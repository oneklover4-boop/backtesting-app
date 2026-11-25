#!/usr/bin/env python3
"""Encrypt a journal fix for the app (see "Journal fixes from Claude" in index.html).

  python3 journal-sync/fix.py KEY fix.json     -> writes fixes/<slot id>.bin
  python3 journal-sync/fix.py KEY fix.json 2   -> writes fixes/<slot id>-2.bin (fixes only newer app builds understand, e.g. "addlive":
                                                  {"kind": "addlive", "trade": {...live trade...}, "pics": ["data:image/jpeg;base64,..."]})

fix.json = {"fix": "<unique name>", "msg": "<toast>", "ops": [{"sess", "kind": "trade"|"nt"|"voice", "id",
"expect": {field: sha256 of its current value}, "set": {field: new value}}]}. The app applies it once, on open,
only to entries that still read what "expect" says. The key is never stored in this public repo."""
import gzip, hashlib, json, os, sys
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from read import norm, ids

k, src = sys.argv[1], sys.argv[2]
fix = json.load(open(src))
key = hashlib.pbkdf2_hmac('sha256', norm(k).encode(), b'tape-journal-salt-v1', 200000, 32)
iv = os.urandom(12)
blob = bytes([1, 1]) + iv + AESGCM(key).encrypt(iv, gzip.compress(json.dumps(fix).encode()), None)
out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'fixes', ids(k)[0] + ('-' + sys.argv[3] if len(sys.argv) > 3 else '') + '.bin')
os.makedirs(os.path.dirname(out), exist_ok=True)
open(out, 'wb').write(blob)
print(out, len(blob), 'bytes')
