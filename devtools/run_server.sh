#!/usr/bin/env bash
# Run the Ardu Kart Python server locally against the real WebUI brick.
# Env: ARDUKART_ASSETS (default ../ardu-kart/assets), ARDUKART_DATA_DIR (default devtools/data),
#      ARDUKART_PORT (default 7000), ARDUKART_DEBUG=1 exposes /api/debug/led.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$HERE/../ardu-kart"
export PYTHONPATH="$HERE/stub${PYTHONPATH:+:$PYTHONPATH}"
export ARDUKART_ASSETS="${ARDUKART_ASSETS:-$APP/assets}"
export ARDUKART_DATA_DIR="${ARDUKART_DATA_DIR:-$HERE/data}"
export ARDUKART_PORT="${ARDUKART_PORT:-7000}"
export PYTHONUNBUFFERED=1
PY="$HERE/.venv/bin/python"; [ -x "$PY" ] || PY=python3
exec "$PY" "$APP/python/main.py" "$@"
