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
const NOTES_SYS = 'You fill in the top of a backtesting journal entry for an ICT-style futures trader (MNQ, MES, NQ, ES). You get everything the trader said about one trade (or a day with no trade), word for word, and the current answers. Return JSON with exactly these keys: "confirmation", "bias", "manipulation", "dol". Each answer is one to four words, the way a trader writes a journal: confirmation = what confirmed the entry (for example "SMT with ES, 1m CISD" or "5m iFVG"); bias = exactly "Bullish" or "Bearish", or "" if they did not say; manipulation = what price manipulated into or swept before the move (for example "Asia high" or "4H FVG"); dol = the draw on liquidity (for example "BSL above PDH" or "PWL"). Rules: only what they said, never invent; "" for anything they did not mention; no sentences, no reasons, no "I", no filler (the full words are kept separately); use shorthand: FVG, iFVG, BPR, SMT, CISD, MSS, BOS, OTE, BSL, SSL, PDH, PDL, PWH, PWL, EQH, EQL, NWOG, NDOG, 1m, 5m, 15m, 1H, 4H, Asia, London, NY AM, NY PM. Keep a current answer unless what they said changes it.';
const FIELDS = [['Confirmation', 'confirmation'], ['Bias', 'bias'], ['Manipulated into', 'manipulation'], ['DOL', 'dol']];
/* Journal template mode (mode: 'tpl'): every heading of the trader's template. Same as NOTES_TPL_SYS / TPL_KEYS in index.html */
const NOTES_TPL_SYS = 'You turn a futures trader\'s spoken trade notes into their trading journal. The trader (ICT style, trades MNQ, MES, NQ, ES) talks freely about one trade: they ramble, repeat themselves, change their mind, go off topic, and usually sum up at the end. Speech-to-text wrote it down word for word, with mistakes. Read ALL of it first, work out what they actually meant, then fill each heading with the short note they would write themselves. The journal is searched later (for example every trade with a 1m iFVG), so use the same exact terms every time. Return JSON with exactly these keys: "bias", "idea", "dol", "trigger", "target", "confirmation", "reasoning", "confidence", "a_plus_dol", "amd", "po3", "true_manip", "pd_array", "smt", "ltf_lrl", "cisd", "hr_lr". bias: exactly "Bullish" or "Bearish" (long/buying = Bullish, short/selling = Bearish), else "". idea (Idea/key levels): their plan for the day as they said it, as scenarios, e.g. "Sweep Asia low then long to PDH, or take PDH first then short to Asia low"; the key levels they named. Max 25 words. dol (DOL, draw on liquidity): what they called the DOL or draw; if they never named one, where their TP is. A few words only (max 4), e.g. "BSL above PDH", "Asia high". trigger (What I took my trade off): the PD array and timeframe they entered from plus what made them enter, from their final version, a few words (max 6), e.g. "15m FVG, displacement out", "1H OB, MSS on 5m". target (My target): where the TP is, e.g. "Asia high", "PDH". confirmation (The confirmation): what confirmed the entry, a few words only (max 5), e.g. "1m iFVG", "SMT with ES, 1m CISD". reasoning (Where and why for TP and SL): where TP and SL went AND their short reason why for each, e.g. "TP at PDH (BSL), SL under 15m FVG low that held". Max 20 words. confidence: their own words, a few words only (max 3), e.g. "Pretty confident", "8/10", "Not confident". Yes/no headings (a_plus_dol, amd, po3, true_manip, pd_array, ltf_lrl = LRL, hr_lr = HR LR, smt, cisd): exactly "Yes", "No" or "". smt = Yes if they said they had SMT (e.g. "SMT with ES"); cisd = Yes if they said they had a CISD; the others only when they said that heading\'s name then yes or no (A plus DOL, AMD, PO3 or power of three, true manip, PD array, LRL or LTF LRL, HR LR); never judge them yourself. Rules: notes, not sentences: no "I", no "we", no "because" unless it is the reason, no filler (like, um, you know, basically, so yeah). Never invent a level, number or reason they did not say; leave "" when nothing they said covers a heading. If they corrected themselves or summed up at the end, use the final version. Exact terms to use: FVG, iFVG (inverse FVG / inversion fair value gap / "I F V G" / "IFEG"), BPR, OB, breaker, SMT, CISD, MSS, BOS, OTE, displacement, BSL, SSL, PDH, PDL, PWH, PWL, EQH, EQL, NWOG, NDOG, timeframes 1m 3m 5m 15m 1H 4H Daily Weekly ("one minute" = 1m, "four hour" = 4H), sessions Asia, London, NY AM, NY PM, Asia high/low, London high/low. Speech-to-text mishears: "true minute PS", "true man ups" = true manip; "PO three", "P03" = PO3; "C I S D", "CSD" = CISD; "S M T" = SMT; "D O L", "dole" = DOL; "fair value gap" = FVG. "H R L R", "HRLR" = HR LR; "L R L", "LTF LRL", "low resistance liquidity" = LRL. Ignore any current answers given: fill everything fresh from what they said.';
const TPL_KEYS = [['Bias', 'bias'], ['Idea/key levels', 'idea'], ['DOL', 'dol'], ['What I took my trade off', 'trigger'], ['My target', 'target'], ['The confirmation', 'confirmation'], ['Where and why for TP and SL', 'reasoning'], ['Confidence', 'confidence'], ['A+ DOL', 'a_plus_dol'], ['AMD', 'amd'], ['PO3', 'po3'], ['True Manip', 'true_manip'], ['PD Array', 'pd_array'], ['SMT', 'smt'], ['CISD', 'cisd'], ['LRL', 'ltf_lrl'], ['HR LR', 'hr_lr']];
/* Yes/no headings that are the trader's own judgement: never filled unless the heading's name (or a misheard version) is in what they said */
const NAMED = [['true_manip', /(?:^|[^\w])(?:true|through|tru)\s*(?:manip|man|mani|manny|min|minute|menu|mana|mean|m\.?\s?a\.?\s?n)/i], ['a_plus_dol', /(?:^|[^\w])a\s?(?:\+|plus|-plus)\s?(?:dol|d\.?\s?o\.?\s?l|dole|doll|dull|doal)/i],
  ['amd', /(?:^|[^\w])(?:amd|a\.?\s?m\.?\s?d)(?:'s)?\b/i], ['po3', /(?:^|[^\w])(?:p\.?\s?[o0]\.?\s?(?:3|three)|power of (?:3|three)|pio three|pure three)\b/i], ['pd_array', /(?:^|[^\w])(?:pd|p\.?\s?d|pd's|pede|pt)\s?(?:arrays?|a ray|ray|arra)\b/i],
  ['hr_lr', /(?:^|[^\w])(?:h[\s.\-]?r\.?[\s,\/\-]*(?:(?:and|slash|or|to)[\s,\-]*)?l[\s.\-]?r\b|hrlr|high resistance)/i], ['ltf_lrl', /(?:^|[^\w])(?:lrl|l[\s.\-]?r[\s.\-]?l\b|low resistance liquidity)/i]];
async function notes(req, env, ask) {
  let inp; try { inp = await req.json(); } catch (e) { return json(req, 400, { error: { message: 'nothing to summarise' } }); }
  const said = typeof inp.said === 'string' ? inp.said.trim().slice(0, 20000) : '', cur = inp.notes && typeof inp.notes === 'object' ? inp.notes : {};
  const tpl = inp.mode === 'tpl', F = tpl ? TPL_KEYS : FIELDS, SYS = tpl ? NOTES_TPL_SYS : NOTES_SYS;
  if (!said) return json(req, 400, { error: { message: 'nothing to summarise' } });
  const lim = await ask({ op: 'check' });
  if (!lim.ok) return json(req, 429, { error: { message: 'the shared notes helper has reached today\'s limit. It resets at midnight.' } });
  const user = 'Current notes:\n' + F.map(([l]) => `${l}: ${typeof cur[l] === 'string' ? cur[l].slice(0, 600) : ''}`).join('\n') + '\n\nEverything they said:\n' + said;
  let r, body;
  for (const model of (tpl ? ['gpt-4.1', ...NOTES_MODELS] : NOTES_MODELS)) {
    r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0, max_tokens: 900, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: SYS }, { role: 'user', content: user }] }) });
    body = await r.text(); if (r.ok || (r.status !== 404 && r.status !== 400)) break;   // that model isn't available: try the next one
  }
  if (!r.ok) return json(req, 502, { error: { message: 'the notes helper said: error ' + r.status } });
  let d; try { d = JSON.parse(body); } catch (e) { return json(req, 502, { error: { message: 'the notes helper gave no answer' } }); }
  const u = d.usage || {}, big = /^gpt-4\.1(?!-)/.test(d.model || ''); await ask({ op: 'add', micros: Math.max(1, Math.ceil((u.prompt_tokens || 2000) * (big ? 2 : 0.4) + (u.completion_tokens || 300) * (big ? 8 : 1.6))) });   // gpt-4.1: $2 in, $8 out; gpt-4.1-mini: $0.40 in, $1.60 out per million tokens
  let o = {}; try { o = JSON.parse(d.choices[0].message.content) || {}; } catch (e) {}
  const out = {}; for (const [, k] of F) out[k] = typeof o[k] === 'string' ? o[k].slice(0, 600) : '';
  if (tpl) for (const [k, re] of NAMED) if (out[k] && !re.test(said)) out[k] = '';   // these yes/no headings only count when their name was said
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
