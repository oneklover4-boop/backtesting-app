#!/usr/bin/env python3
"""Decrypt a Tape Replay journal auto-save (see "Journal auto-save" in index.html and /journal in voice-helper/worker.js).

  python3 journal-sync/read.py KEY                -> prints the slot id for that key
  python3 journal-sync/read.py KEY journal.bin    -> prints the journal text
  python3 journal-sync/read.py KEY journal.bin --json out.json   -> also writes the full saved data (journal + store)

The key is never stored in this public repo. journal.bin comes from the "Read journal" workflow (branch journal-sync)."""
import gzip, hashlib, json, sys
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

def norm(k): return ''.join(c for c in k.upper() if c.isalnum())
def ids(k):
    k = norm(k)
    return hashlib.sha256(('tape-journal-id|' + k).encode()).hexdigest()[:32], hashlib.sha256(('tape-journal-tok|' + k).encode()).hexdigest()

def decrypt(k, blob):
    k = norm(k)
    if blob[0] != 1: raise SystemExit('unknown journal format')
    key = hashlib.pbkdf2_hmac('sha256', k.encode(), b'tape-journal-salt-v1', 200000, 32)
    plain = AESGCM(key).decrypt(blob[2:14], blob[14:], None)
    if blob[1] == 1: plain = gzip.decompress(plain)
    return json.loads(plain)

if __name__ == '__main__':
    a = sys.argv[1:]
    if len(a) == 1: print(ids(a[0])[0]); sys.exit()
    d = decrypt(a[0], open(a[1], 'rb').read())
    if '--json' in a: json.dump(d, open(a[a.index('--json') + 1], 'w'), indent=1)
    print(f"# saved {d['savedAt']} · app build {d.get('build')} · {d.get('device', '')[:80]}\n")
    print(d['journal'])
