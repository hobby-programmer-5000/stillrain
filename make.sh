#!/bin/sh
# Everything from nothing: the sources -> one HTML file (dist/stillrain.html, copied to index.html).
# Needs Python 3 only. Node (optional) syntax-checks every file first.
set -e
cd "$(dirname "$0")"
if command -v node >/dev/null 2>&1; then python3 tools/build.py --check; else python3 tools/build.py; fi
echo "open dist/stillrain.html"
