#!/usr/bin/env bash
# Run the Ardu Fishing Python server locally against the real WebUI brick.
# Env: ARDUFISH_ASSETS (default ../ardu-fishing/assets), ARDUFISH_DATA_DIR (default devtools/data-fishing),
#      ARDUFISH_PORT (default 7000), ARDUFISH_DEBUG=1 exposes /api/debug/*.
#      ARDUKART_SIM_BOARD=1 simulates the Modulino rod (classes idle, cast, reel, unhook).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$HERE/../ardu-fishing"
export PYTHONPATH="$HERE/stub${PYTHONPATH:+:$PYTHONPATH}"
export ARDUFISH_ASSETS="${ARDUFISH_ASSETS:-$APP/assets}"
export ARDUFISH_DATA_DIR="${ARDUFISH_DATA_DIR:-$HERE/data-fishing}"
export ARDUFISH_PORT="${ARDUFISH_PORT:-7000}"
export ARDUFISH_APP_DIR="${ARDUFISH_APP_DIR:-$HERE/data-fishing/app}"
export ARDUKART_SIM_LABELS="${ARDUKART_SIM_LABELS:-idle,cast,reel,unhook}"
export PYTHONUNBUFFERED=1
mkdir -p "$ARDUFISH_APP_DIR/sketch"
[ -f "$ARDUFISH_APP_DIR/sketch/sketch.yaml" ] || cp "$APP/sketch/sketch.yaml" "$APP/sketch/model_config.h" "$ARDUFISH_APP_DIR/sketch/"
PY="$HERE/.venv/bin/python"; [ -x "$PY" ] || PY=python3
exec "$PY" "$APP/python/main.py" "$@"
