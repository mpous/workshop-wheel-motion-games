---
name: motion-game-devtools
description: How to run, test, screenshot and deploy the Arduino UNO Q motion games in this repo (ardu-kart, ardu-fishing, ardu-snowball), with or without a board. Covers the devtools/ stubs and the simulated Modulino board, every env var, the /api/debug/* endpoints, the puppeteer and Python test scripts, the three.js vendor bundles, the LED-matrix sketch tests, and deploying to a real UNO Q over SSH or adb. Use when asked to "run locally", "use the simulator", "test", "take a screenshot", "deploy to the board", "hot-update assets", "read the logs", or "probe the board".
---

# Motion game devtools

Everything here lives in `devtools/` (plus `run_local.sh` at the repo root). Sibling skills:
`unoq-motion-game` (game architecture), `modulino-imu-aim` (tilt/aim filters),
`edge-impulse-motion-gestures` (Motion Lab, models), `arduino-unoq-applab` (App Lab, bricks, CLI).

Detailed per-script notes: [references/test-scripts.md](references/test-scripts.md).
Simulator internals: [references/simulator.md](references/simulator.md).

## 1. Setup

| What | Command | Notes |
|---|---|---|
| Python venv | `./run_local.sh` once, then Ctrl+C | Creates `devtools/.venv` with Python 3.10+ and installs `devtools/requirements-dev.txt` (fastapi, fastapi-socketio, python-socketio, uvicorn). |
| Python test client | `devtools/.venv/bin/pip install "python-socketio[client]" requests` | Needed by `test_server.py` only; not in `requirements-dev.txt`. |
| Node deps | `cd devtools && npm install` | `puppeteer-core`, `three` (0.187), `esbuild`. Node 18+ (scripts use global `fetch`). |
| Chrome | installed Google Chrome | `puppeteer-core` does not download a browser. Every puppeteer script hardcodes `executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'` (macOS). On Linux/Windows edit that line in each script; there is no env override. |
| C++ compiler | any `c++` with C++17 | For `devtools/sketch_test/`. |

Scripts fall back to `python3` if `devtools/.venv/bin/python` is missing.

### What the stubs replace (`devtools/stub/arduino/`, put on `PYTHONPATH` by the run scripts)

| Stub | Replaces | Fidelity |
|---|---|---|
| `app_bricks/web_ui/` | `arduino:web_ui` brick | Real brick source copied from app-bricks-py (MPL-2.0 headers). Same FastAPI + Socket.IO + static serving as on the board. |
| `app_utils/__init__.py` | `App`, `Bridge`, `brick`, `Logger`, `notify/call/provide` | Minimal. `App.run()` starts bricks and their `execute`/`loop` threads. There is no MCU: Python-to-MCU `Bridge.notify` calls are stored in `Bridge.sent` (see `/api/debug/mcu`), and `Bridge.call` to the MCU raises `RuntimeError`. |
| `app_utils/sim_board.py` | the sketch + Modulino board | Only with `ARDUKART_SIM_BOARD=1`. Streams `imu` at 62.5 Hz, `hw` every 2 s, `ml` 4x/s, `btn` edges. |
| `app_bricks/motion_detection/` | `arduino:motion_detection` brick | Only with `ARDUKART_SIM_BRICK=1`, otherwise the import fails as on a runtime without the brick. Its "model" reports the gesture the sim board is playing. |

Limits of the simulation (verified in `sim_board.py`):
- Tilt is one rotation about the board z axis with the board upright (the Kart wheel pose). It does not model the fishing rod or snowball poses; use `aim_check.mjs` for the aim filter in other grips.
- Gestures are synthetic accelerometer/gyro "shapes" (`SHAPES`) for all three games' labels, 900 ms long. Probabilities in `ml` are faked: the played label wins (0.88-0.97) between 150 ms and 900 ms; they do not come from a model.
- Buttons are indices 0..2 (A/B/C); a press is held 0.12 s unless `hold` is given.
- The `hw` heartbeat always says `name=Ardu Kart wheel (simulated)` and `sim=1`, even for fishing and snowball.
- LED matrix, Pixels and button LEDs are not rendered; inspect what would be sent with `/api/debug/led` and `/api/debug/mcu`.

## 2. Run a game locally

| Game | Command (from `devtools/`) | Default URL | Data dir |
|---|---|---|---|
| Ardu Kart | `./run_server.sh` (or `../run_local.sh`) | `http://localhost:7000` | `devtools/data` |
| Ardu Fishing | `./run_fishing.sh` | `http://localhost:7000` | `devtools/data-fishing` |
| Ardu Snowball | `./run_snowball.sh` | `http://localhost:7000` | `devtools/data-snowball` |

Typical simulator sessions (ports as used by the READMEs and test defaults):

```bash
cd devtools
ARDUKART_SIM_BOARD=1 ARDUKART_DEBUG=1 ARDUKART_PORT=7123 ./run_server.sh
ARDUKART_SIM_BOARD=1 ARDUFISH_DEBUG=1 ARDUFISH_PORT=7311 ./run_fishing.sh
ARDUKART_SIM_BOARD=1 ARDUSNOW_DEBUG=1 ARDUSNOW_PORT=7322 ./run_snowball.sh
```

The fishing and snowball scripts copy `sketch.yaml` and `model_config.h` into a scratch app dir (`devtools/data-*/app/sketch/`) so Motion Lab model installs never touch the repo. `run_server.sh` does not set `ARDUKART_APP_DIR`, so a Kart model install from the Motion Lab writes into `ardu-kart/sketch/`. Set `ARDUKART_APP_DIR` to a scratch folder (with a copy of `sketch/`) if you test that flow; `test_server.py` does exactly this.

### Environment variables

Per game prefix: `ARDUKART_` (Kart), `ARDUFISH_` (Fishing), `ARDUSNOW_` (Snowball).

| Variable | Default | Meaning |
|---|---|---|
| `<P>_PORT` | `7000` (run scripts) | WebUI port. |
| `<P>_ASSETS` | `../ardu-<game>/assets` | Folder served as the web UI. |
| `<P>_DATA_DIR` | `devtools/data`, `data-fishing`, `data-snowball` | Records and prefs. On the board it falls back to `/app/data`. |
| `<P>_APP_DIR` | Fishing/Snowball: `devtools/data-*/app`; Kart: unset (app folder) | Where `model_installer.py` installs a model into `sketch/`. |
| `<P>_DEBUG=1` | off | Exposes `/api/debug/led`, `/api/debug/mcu`, `/api/debug/sim`. |
| `<P>_EI_STUDIO_URL` | `https://studio.edgeimpulse.com/v1/api` | Edge Impulse Studio API (point at `fake_ei.py`). |
| `<P>_EI_INGEST_URL` | `https://ingestion.edgeimpulse.com` | Ingestion API (point at `fake_ei.py`). |
| `ARDUFISH_MATCH_MS`, `ARDUSNOW_MATCH_MS` | `180000` | Match length, for short local tests. Kart has no equivalent. |
| `ARDUKART_SIM_BOARD=1` | off | Start the simulated Modulino board (all three games use this name). |
| `ARDUKART_SIM_MODEL=0` | `1` | Simulate a sketch without an Edge Impulse model (`hw` says `model=0`, no `ml`). |
| `ARDUKART_SIM_LABELS` | Kart: `idle,accelerate,brake,use_item,change_camera`; Fishing script: `idle,cast,reel,unhook`; Snowball script: `idle,scoop,pack,throw,run` | Classes the sim board's model reports. |
| `ARDUKART_SIM_BRICK=1` | off | Enable the stub Motion detection brick (needs the sim board for gestures). |
| `ARDUKART_SIM_BRICK_LABELS` | the sim board's labels | Labels of the stub brick model. |
| `ARDUKART_TEST_PORT` | random free port | Port used by `test_server.py`. |
| `HOST_IP` | unset | Read by the real WebUI brick for the URL it prints. |

### Debug endpoints (need `<P>_DEBUG=1`)

| Endpoint | Returns |
|---|---|
| `GET /api/status` | Always on: players, lobby, uptime, `version`. |
| `GET /api/debug/led` | `{"led": "<state>"}` the LED matrix would show (e.g. `idle`, `race:2:3:4`). |
| `GET /api/debug/mcu` | Last arguments of each Python-to-MCU notification (e.g. `led_state`, `ml_engine`, `rev`/`pix`, `ctl_leds`). Stub only. |
| `GET /api/debug/sim?...` | Drives the sim board; returns `{"ok":true,"tilt","tiltNow","gesture","model"}` or `{"ok":false,"error":"start with ARDUKART_SIM_BOARD=1"}`. |

`/api/debug/sim` query parameters (combine freely):

| Param | Effect |
|---|---|
| `tilt=0.3` | Hold a roll angle in radians, clamped to +-1.2; positive = counter-clockwise = left. |
| `auto=true` | Back to the automatic sway (0.35 rad sine). |
| `gesture=cast` | Play a gesture for 900 ms (IMU shape + `ml` top class). |
| `button=0..2` | Press button A/B/C. |
| `hold=2` | With `button`: hold for 2 s instead of 0.12 s. |

```bash
curl "localhost:7311/api/debug/sim?tilt=-0.4"
curl "localhost:7311/api/debug/sim?gesture=reel"
curl "localhost:7311/api/debug/sim?button=1&hold=2"
curl "localhost:7311/api/debug/sim?auto=true"
```

Offline Edge Impulse: `devtools/.venv/bin/python devtools/fake_ei.py [api_key]` prints the `ARDUKART_EI_STUDIO_URL` / `ARDUKART_EI_INGEST_URL` values to export (use the `ARDUFISH_` / `ARDUSNOW_` names for the other games). Upload, train, build and install then work without an account (see `edge-impulse-motion-gestures`).

## 3. Test scripts

Run puppeteer scripts from `devtools/` against a running server. Screenshots go to `devtools/shots/` (gitignored). Default ports differ per script; pass the port to match your server.

| Script | Game | Needs | Usage | Checks / output |
|---|---|---|---|---|
| `test_server.py` | Kart | venv + socketio client | `.venv/bin/python test_server.py` | Starts its own servers. 120+ checks: protocol, LED states, lobby, races, records persistence, 20-player lobby, sim wheel, ownership, recording, fake EI upload/train/build/install, stub brick. Exit 1 on failure. |
| `game_shot.js` | Kart | server | `node game_shot.js [basic,race,go,full,retry] [port=7111]` | `shots/<scenario>_*.png`; logs `QK` state lines; `errors: N`. Env `W`, `H`, `TRACK`, `TOGGLES`. |
| `mp_test.js` | Kart | server | `node mp_test.js [port=7111] [players=2..20]` | N browser contexts join, race; `shots/mp_*.png`. |
| `lab_check.js` | Kart | sim board + debug | `ARDUKART_URL=http://localhost:7123 node lab_check.js` | Motion Lab page, recording, wheel ownership between lab/game tabs, steering, `rev` lights; `shots/lab*.png`, `game_*.png`; `ERRORS:`. Env `SHOTS`. |
| `probe.js` | Kart | server | `N=5 DT=500 node probe.js "<js body>" [port=7111]` | Evaluates code in the page N times and prints it. |
| `shot.js` | Kart model preview | static server on 8765 + `devtools/kart_preview/` | `node shot.js [front rear close items view=...]` | `kart_preview/shot_*.png`. `kart_preview/` is gitignored, so this only works where that page exists locally. |
| `check_tracks.mjs` | Kart | node deps | `node check_tracks.mjs` | Prints length, clearance, min radius, slope per track; writes `tracks.svg` in the cwd. `node svg2png.mjs tracks.svg tracks.png` renders it. |
| `fish_shot.js` | Fishing | server | `node fish_shot.js [menus\|play] [port=7311]` | `shots/fish_<scenario>_*.png`; autopilot match (`PLAY_MS`, default 60000). |
| `fish_tourney.js` | Fishing | server, `ARDUFISH_MATCH_MS=40000` | `node fish_tourney.js [port=7311]` | Two players: lobby, ready, synced start, scoreboard, results; `shots/fish_tourney_*.png`. |
| `aim_check.mjs` | Fishing | none | `node aim_check.mjs` | Feeds synthetic IMU data through `ardu-fishing/assets/js/motion.js` and prints aim per second for several grips (see `modulino-imu-aim`). |
| `snowball_shot.js` | Snowball | sim board + debug | `node snowball_shot.js [all\|menus\|play\|lan] [port=7000]` | PASS/FAIL checks, gesture flow via `/api/debug/sim`, LED states; `shots/snow_*.png`. `lan` wants `ARDUSNOW_MATCH_MS=30000`. Exit code 1 on failure. |
| `board_probe.js` | Kart, real board | a board | `node board_probe.js http://my-unoq.local:7000` | JSON of `window.ardukart.motion` state. See section 7. |

When to run: protocol or Python changes, `test_server.py`; UI or rendering, the game's `*_shot.js`; motion/controller code, `lab_check.js` or `snowball_shot.js play` plus `aim_check.mjs`; multiplayer, `mp_test.js`, `fish_tourney.js`, `snowball_shot.js lan`; track edits, `check_tracks.mjs`; LED frames, `sketch_test/`.

## 4. Vendor bundles (three.js)

Each game imports `assets/libs/three.bundle.js` (ES module, three r187, minified). Socket.IO is a prebuilt `assets/libs/socket.io.min.js` (v4.8.1), not built here.

```bash
cd devtools
npx esbuild vendor-entry.js          --bundle --format=esm --minify --outfile=../ardu-kart/assets/libs/three.bundle.js
npx esbuild vendor-entry-fishing.js  --bundle --format=esm --minify --outfile=../ardu-fishing/assets/libs/three.bundle.js
npx esbuild vendor-entry-snowball.js --bundle --format=esm --minify --outfile=../ardu-snowball/assets/libs/three.bundle.js
```

The Fishing and Snowball commands are in the entry files' header comments. `vendor-entry.js` has no comment; the Kart command above is inferred from the same pattern. Add an export to the entry file when a game needs another `three/examples/jsm` module, rebuild, and commit the bundle.

## 5. Sketch checks

LED-matrix logic (`sketch/led_frames.h`) compiles on the host with `sketch_test/arduino_shim.h` (a `String` and `millis()` stand-in):

```bash
cd devtools/sketch_test
c++ -std=c++17 -o render_test render_test.cpp && ./render_test                  # Kart: "render tests: OK"
c++ -std=c++17 -o fish_render_test fish_render_test.cpp && ./fish_render_test   # "all fishing LED tests passed"
c++ -std=c++17 -o snow_render_test snow_render_test.cpp && ./snow_render_test   # "all snowball LED tests passed"
```

They print ASCII frames and `assert` the state parser. Binaries are gitignored. Full sketch compile (arduino-cli 1.x, from the repo README):
`arduino-cli compile --profile default -b arduino:zephyr:unoq ardu-kart/sketch`. On macOS build from a folder under your home directory, not `/tmp`.

## 6. Deploy to a real UNO Q

Apps live in `/home/arduino/ArduinoApps/<app>` on the board. Replace `my-unoq.local` with your board's hostname or IP.

```bash
scp -r ardu-fishing arduino@my-unoq.local:/home/arduino/ArduinoApps/
ssh arduino@my-unoq.local "arduino-app-cli app stop user:ardu-fishing; arduino-app-cli app start user:ardu-fishing"
ssh arduino@my-unoq.local "arduino-app-cli app list"
ssh arduino@my-unoq.local "arduino-app-cli app logs /home/arduino/ArduinoApps/ardu-fishing --all"
```

The READMEs use both `user:<app>` and the folder path as the app id; the logs examples use the folder path. Do not copy local `data/` folders over a board's records.

What needs what after a change:

| Changed | Action | Why |
|---|---|---|
| `assets/**` (HTML, JS, CSS, bundles) | copy the file(s), hard-refresh the browser | The WebUI brick mounts `assets` with `NonCachedStaticFiles` (`Cache-Control: no-store`) and reads files from disk per request. |
| `python/**` | copy, then `app stop` + `app start` | `main.py` and its modules are loaded once at start-up. |
| `sketch/**`, `app.yaml`, an installed model | copy, then restart the app | The sketch is compiled and flashed when the app starts (first start can take a minute). |

Hot-updating assets only:

```bash
scp ardu-fishing/assets/js/game.js arduino@my-unoq.local:/home/arduino/ArduinoApps/ardu-fishing/assets/js/
```

Not verifiable from this repo: that App Lab bind-mounts the app folder into the container (the brick serves `/app/assets`). Confirm the deployed version with md5sum instead of assuming:

```bash
md5sum ardu-fishing/assets/js/game.js            # Linux; macOS: md5 -q
ssh arduino@my-unoq.local "md5sum /home/arduino/ArduinoApps/ardu-fishing/assets/js/game.js"
curl -s http://my-unoq.local:7000/api/status     # Python VERSION (Kart 1.1.0, Fishing/Snowball 1.0.0)
```

### Over USB with adb

Arduino App Lab ships `adb`. Generic macOS locations (the version folder varies):
`~/Library/Application Support/arduino_applab_workspace/arduino15/data/packages/arduino/tools/adb/<version>/adb`, or, with the `arduino:zephyr` core in arduino-cli, `~/Library/Arduino15/packages/arduino/tools/adb/<version>/adb`. Windows and Linux paths were not checked; look for `packages/arduino/tools/adb` in the App Lab data folder.

```bash
adb devices
adb push ardu-fishing/assets/js/game.js /home/arduino/ArduinoApps/ardu-fishing/assets/js/
adb shell "arduino-app-cli app stop user:ardu-fishing; arduino-app-cli app start user:ardu-fishing"
adb forward tcp:7000 tcp:7000      # then open http://localhost:7000
```

The adb commands follow `arduino-unoq-applab`; they are not used by any script in this repo.

## 7. Probe a live board from a headless browser

`board_probe.js` loads the game, waits 6 s and prints `window.ardukart.motion` fields: `owner`, `ownerKind`, `owned`, `online`, `active`, `hw`, `engine`, `labels`, `hasModel`, `settings.enabled`, `steer`. The same pattern works for the other games through `window.ardufish.motion` and `window.ardusnow.motion` (copy the script and change the global).

Etiquette: a probe tab is a full game client. `_autoClaim()` in `assets/js/motion.js` claims the controller when nobody owns it, or when the probe has focus and the owner is the Motion Lab or a hidden tab. A probe can therefore take the controller from a player whose tab is in the background. Before probing a board someone is using:
- tell the player, or probe while their game tab is in the foreground;
- or disable motion in the probe before load: `localStorage['<game>.settings'] = JSON.stringify({ motion: { enabled: 'off' } })` via `page.evaluateOnNewDocument` (keys: `ardukart.settings`, `ardufish.settings`, `ardusnow.settings`);
- close the probe quickly; disconnecting releases ownership.

## 8. Pre-PR checklist

- [ ] `devtools/.venv/bin/python devtools/test_server.py` ends with `ALL N CHECKS PASSED` (Kart server changes).
- [ ] The changed game's shot script runs: `game_shot.js basic,race`, `fish_shot.js menus` and `play`, `snowball_shot.js all` (`all checks passed`).
- [ ] Motion changes: `lab_check.js` (Kart), `snowball_shot.js play`, `aim_check.mjs` (Fishing).
- [ ] Multiplayer changes: `mp_test.js`, `fish_tourney.js`, `snowball_shot.js lan`.
- [ ] No `[pageerror]` or `[console.error]` lines; scripts report `errors: 0`, `no errors`, `ERRORS: none`.
- [ ] Look at the new screenshots in `devtools/shots/`; attach the relevant ones to the PR (the folder itself is gitignored).
- [ ] LED changes: the three `sketch_test` binaries pass. Sketch changes: `arduino-cli compile` or a board start without compile errors in the logs.
- [ ] Bundle rebuilt if a `vendor-entry*.js` changed.
- [ ] If tested on a board: md5sum of deployed files matches, the app logs are clean.
- [ ] No personal hostnames, IPs, API keys or absolute home paths in the diff.
