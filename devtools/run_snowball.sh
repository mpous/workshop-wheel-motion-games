#!/usr/bin/env bash
# Run the Ardu Snowball Python server locally against the real WebUI brick.
# Env: ARDUSNOW_ASSETS (default ../ardu-snowball/assets), ARDUSNOW_DATA_DIR (default devtools/data-snowball),
#      ARDUSNOW_PORT (default 7000), ARDUSNOW_DEBUG=1 exposes /api/debug/*.
#      ARDUKART_SIM_BOARD=1 simulates the Modulino controller (classes idle, scoop, pack, throw, run).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$HERE/../ardu-snowball"
export PYTHONPATH="$HERE/stub${PYTHONPATH:+:$PYTHONPATH}"
export ARDUSNOW_ASSETS="${ARDUSNOW_ASSETS:-$APP/assets}"
export ARDUSNOW_DATA_DIR="${ARDUSNOW_DATA_DIR:-$HERE/data-snowball}"
export ARDUSNOW_PORT="${ARDUSNOW_PORT:-7000}"
export ARDUSNOW_APP_DIR="${ARDUSNOW_APP_DIR:-$HERE/data-snowball/app}"
export ARDUKART_SIM_LABELS="${ARDUKART_SIM_LABELS:-idle,scoop,pack,throw,run}"
export PYTHONUNBUFFERED=1
mkdir -p "$ARDUSNOW_APP_DIR/sketch"
[ -f "$ARDUSNOW_APP_DIR/sketch/sketch.yaml" ] || cp "$APP/sketch/sketch.yaml" "$APP/sketch/model_config.h" "$ARDUSNOW_APP_DIR/sketch/"
PY="$HERE/.venv/bin/python"; [ -x "$PY" ] || PY=python3
exec "$PY" "$APP/python/main.py" "$@"
