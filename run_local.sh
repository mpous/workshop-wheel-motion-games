#!/usr/bin/env bash
# Run Q-Kart on this computer (no UNO Q needed).
# First run creates devtools/.venv and installs the desktop dependencies.
# Usage: ./run_local.sh            -> http://localhost:7000
#        QKART_PORT=8080 ./run_local.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$HERE/devtools/.venv"
if [ ! -x "$VENV/bin/python" ]; then
  # the WebUI brick needs Python 3.10+ (the UNO Q ships 3.13)
  PY=""
  for c in python3.13 python3.12 python3.14 python3.11 python3.10 python3.15 python3; do
    if command -v "$c" >/dev/null && "$c" -c 'import sys; sys.exit(sys.version_info < (3, 10))' 2>/dev/null; then PY="$c"; break; fi
  done
  if [ -z "$PY" ]; then
    echo "Python 3.10 or newer is required (found: $(python3 --version 2>&1))."
    echo "macOS: brew install python@3.13   |   Ubuntu: sudo apt install python3 python3-venv"
    exit 1
  fi
  echo "Creating Python virtual environment in devtools/.venv with $PY ..."
  "$PY" -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --upgrade pip
  "$VENV/bin/pip" install --quiet -r "$HERE/devtools/requirements-dev.txt"
fi
PORT="${QKART_PORT:-7000}"
IP="$( (ipconfig getifaddr en0 || hostname -I | awk '{print $1}') 2>/dev/null || true)"
echo
echo "  Q-Kart running:  http://localhost:$PORT"
[ -n "$IP" ] && echo "  Same network:   http://$IP:$PORT"
echo "  Stop with Ctrl+C"
echo
QKART_PORT="$PORT" exec "$HERE/devtools/run_server.sh"
