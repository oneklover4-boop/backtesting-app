/* Tape Replay shared voice helper (Cloudflare Worker).
   Holds the OpenAI key as a secret so it never appears in the website.
   Anyone using the website gets it, no code needed. To stop strangers draining the credit:
   only the website may call it (/transcribe writes down a recording, /notes summarises backtest notes), and there are daily spending limits per person (by internet address) and in total.
   Secret (set by the GitHub workflow): OPENAI_API_KEY. Daily spending limits: PER_IP_CENTS and TOTAL_CENTS in wrangler.toml. */
const SITE = ['https://oneklover4-boop.github.io'];
const MAX_BYTES = 12 * 1024 * 1024;           // about 10 minutes of speech
const MODEL = 'gpt-4o-transcribe';

function cors(req) {
  const o = req.headers.get('Origin') || '';
  return { 'Access-Control-Allow-Origin': SITE.includes(o) ? o : SITE[0], 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Access-Code', 'Access-Control-Max-Age': '86400', Vary: 'Origin' };
}
const json = (req, status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors(req) } });

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/') return json(req, 200, { ok: true, ready: !!env.OPENAI_API_KEY });
    if (req.method !== 'POST' || (url.pathname !== '/transcribe' && url.pathname !== '/notes')) return json(req, 404, { error: { message: 'not found' } });
    const origin = req.headers.get('Origin') || '';
    if (!SITE.includes(origin)) return json(req, 403, { error: { message: 'only the Tape Replay website can use the shared mic' } });
    if (!env.OPENAI_API_KEY) return json(req, 500, { error: { message: 'the shared mic has no OpenAI key yet' } });
    const day = new Date().toISOString().slice(0, 10), ip = req.headers.get('CF-Connecting-IP') || 'unknown';
    const limiter = env.LIMITER.get(env.LIMITER.idFromName('daily'));
    const ask = (o) => limiter.fetch('https://limiter/', { method: 'POST', body: JSON.stringify({ day, ip, perIp: Math.round((+env.PER_IP_CENTS || 50) * 1e4), total: Math.round((+env.TOTAL_CENTS || 500) * 1e4), ...o }) }).then(x => x.json());
    if (url.pathname === '/notes') return notes(req, env, ask);
    const len = +(req.headers.get('Content-Length') || 0);
    if (len > MAX_BYTES) return json(req, 413, { error: { message: 'that recording is too long (10 minutes max)' } });
    let inForm; try { inForm = await req.formData(); } catch (e) { return json(req, 400, { error: { message: 'no recording received' } }); }
    const file = inForm.get('file');
    if (!file || typeof file === 'string') return json(req, 400, { error: { message: 'no recording received' } });
    if (file.size > MAX_BYTES) return json(req, 413, { error: { message: 'that recording is too long (10 minutes max)' } });
    const out = new FormData();
    out.append('file', file, file.name || 'note.webm');
    out.append('model', MODEL);                 // always this model, whatever the page asks for
    out.append('language', 'en');
    const prompt = inForm.get('prompt'); if (typeof prompt === 'string') out.append('prompt', prompt.slice(0, 2000));
    const lim = await ask({ op: 'check' });
    if (!lim.ok) return json(req, 429, { error: { message: lim.why === 'ip' ? 'you have used today\'s shared mic allowance. It resets at midnight.' : 'the shared mic has reached today\'s limit for everyone. It resets at midnight.' } });
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + env.OPENAI_API_KEY }, body: out });
    const body = await r.text();
    if (r.ok) await ask({ op: 'add', micros: costMicros(body, file.size) });
    if (r.status === 401) return json(req, 502, { error: { message: 'the shared mic\'s OpenAI key was not accepted' } });
    return new Response(body, { status: r.status, headers: { 'Content-Type': 'application/json', ...cors(req) } });
  }
};

/* Backtest notes summary: reads everything the trader said about one trade and returns the short summary fields as JSON.
   Same instructions as NOTES_SYS in index.html. Counted in the same daily limits (a summary costs about a tenth of a cent). */
const NOTES_MODELS = ['gpt-4.1-mini', 'gpt-4o-mini'];
const NOTES_SYS = 'You write short backtesting journal notes for an ICT-style futures trader (MNQ, MES, NQ, ES). You get everything the trader said about one trade, word for word, and the current notes. Return JSON with exactly these keys: "key_level", "confirmation", "bias", "tp_sl", "dol". key_level: the key level or PD array they took the trade off (for example "15m FVG after the Asia low sweep"). confirmation: what confirmed the entry (for example "SMT with ES, 1m iFVG, CISD"). bias: exactly "Bullish" or "Bearish", or "" if they did not say. tp_sl: a short summary of where the take profit and the stop loss were and why, keeping every important detail they gave (levels, R multiple, reasons, management such as break even or partials). dol: the draw on liquidity (where price is drawn to). Rules: use only what they said and never invent anything; "" for a field they did not talk about; note style, short fragments, no full sentences, no "I", no filler, no hedging; keep their own trading words and use shorthand: FVG, iFVG, BPR, SMT, CISD, MSS, BOS, OTE, BSL, SSL, PDH, PDL, PWH, PWL, EQH, EQL, NWOG, NDOG, DOL, HTF, LTF, 1m, 5m, 15m, 1H, 4H, Asia, London, NY AM, NY PM. The current notes may hold things the trader typed: keep them unless what they said changes them.';
const FIELDS = [['Key level', 'key_level'], ['Confirmation', 'confirmation'], ['Bias', 'bias'], ['TP and stop loss', 'tp_sl'], ['DOL', 'dol']];
async function notes(req, env, ask) {
  let inp; try { inp = await req.json(); } catch (e) { return json(req, 400, { error: { message: 'nothing to summarise' } }); }
  const said = typeof inp.said === 'string' ? inp.said.trim().slice(0, 20000) : '', cur = inp.notes && typeof inp.notes === 'object' ? inp.notes : {};
  if (!said) return json(req, 400, { error: { message: 'nothing to summarise' } });
  const lim = await ask({ op: 'check' });
  if (!lim.ok) return json(req, 429, { error: { message: 'the shared notes helper has reached today\'s limit. It resets at midnight.' } });
  const user = 'Current notes:\n' + FIELDS.map(([l]) => `${l}: ${typeof cur[l] === 'string' ? cur[l].slice(0, 600) : ''}`).join('\n') + '\n\nEverything they said:\n' + said;
  let r, body;
  for (const model of NOTES_MODELS) {
    r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0, max_tokens: 600, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: NOTES_SYS }, { role: 'user', content: user }] }) });
    body = await r.text(); if (r.ok || (r.status !== 404 && r.status !== 400)) break;   // that model isn't available: try the next one
  }
  if (!r.ok) return json(req, 502, { error: { message: 'the notes helper said: error ' + r.status } });
  let d; try { d = JSON.parse(body); } catch (e) { return json(req, 502, { error: { message: 'the notes helper gave no answer' } }); }
  const u = d.usage || {}; await ask({ op: 'add', micros: Math.max(1, Math.ceil((u.prompt_tokens || 2000) * 0.4 + (u.completion_tokens || 300) * 1.6)) });   // gpt-4.1-mini: $0.40 in, $1.60 out per million tokens
  let o = {}; try { o = JSON.parse(d.choices[0].message.content) || {}; } catch (e) {}
  const out = {}; for (const [, k] of FIELDS) out[k] = typeof o[k] === 'string' ? o[k].slice(0, 600) : '';
  return json(req, 200, { notes: out });
}

/* What a recording cost, in millionths of a dollar, from OpenAI's own token count
   (gpt-4o-transcribe: audio in $6, text in $2.50, text out $10 per million tokens).
   If OpenAI doesn't say, guess from the file size (about 1 KB per 0.1 s of speech, $0.006 a minute), so it never counts as free. */
function costMicros(body, bytes) {
  const guess = Math.ceil(bytes / 1000 * 10);   // ~ $0.0001 per second at ~8 KB/s -> 10 micros per KB
  try { const u = JSON.parse(body).usage; if (u && u.type === 'tokens') { const d = u.input_token_details || {}, audio = d.audio_tokens ?? u.input_tokens ?? 0, text = d.text_tokens ?? 0;
      return Math.max(1, Math.ceil(audio * 6 + text * 2.5 + (u.output_tokens || 0) * 10)); }
    if (u && u.type === 'duration') return Math.ceil(u.seconds * 100); } catch (e) {}
  return Math.max(100, guess);
}

/* Daily counters, kept in one small Durable Object so every request sees the same numbers */
export class Limiter {
  constructor(state) { this.st = state.storage; }
  async fetch(req) {
    const { op, day, ip, perIp, total, micros } = await req.json();
    if ((await this.st.get('day')) !== day) { await this.st.deleteAll(); await this.st.put('day', day); }
    const all = (await this.st.get('all')) || 0, mine = (await this.st.get('ip:' + ip)) || 0;
    if (op === 'add') { const m = Math.max(0, +micros || 0); await this.st.put('all', all + m); await this.st.put('ip:' + ip, mine + m); return Response.json({ ok: true, all: all + m, mine: mine + m }); }
    if (all >= total) return Response.json({ ok: false, why: 'total' });
    if (mine >= perIp) return Response.json({ ok: false, why: 'ip' });
    return Response.json({ ok: true, all, mine });
  }
}
