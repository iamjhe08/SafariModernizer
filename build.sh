#!/bin/sh
# Full build: page scripts (web/) -> headers -> tweak packages (tweak/packages).
# Needs Node.js 18+, Python 3, and Theos with an arm64e-capable toolchain.
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT/web"
[ -d node_modules ] || npm ci
npm run build
npm test
cd "$ROOT/tweak"
python3 embed.py ../web/polyfill.min.js polyfill.h polyfill_js
python3 embed.py ../web/smfix.min.js smfix.h smfix_js
./build-all.sh
