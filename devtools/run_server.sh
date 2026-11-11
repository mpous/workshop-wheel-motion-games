#!/usr/bin/env bash
# Run the Q-Kart Python server locally against the real WebUI brick.
# Env: QKART_ASSETS (default ../q-kart/assets), QKART_DATA_DIR (default devtools/data),
#      QKART_PORT (default 7000), QKART_DEBUG=1 exposes /api/debug/led.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$HERE/../q-kart"
export PYTHONPATH="$HERE/stub${PYTHONPATH:+:$PYTHONPATH}"
export QKART_ASSETS="${QKART_ASSETS:-$APP/assets}"
export QKART_DATA_DIR="${QKART_DATA_DIR:-$HERE/data}"
export QKART_PORT="${QKART_PORT:-7000}"
export PYTHONUNBUFFERED=1
PY="$HERE/.venv/bin/python"; [ -x "$PY" ] || PY=python3
exec "$PY" "$APP/python/main.py" "$@"
