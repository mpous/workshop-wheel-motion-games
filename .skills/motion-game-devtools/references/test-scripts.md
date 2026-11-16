# Test scripts in detail

All puppeteer scripts launch headless Chrome from the hardcoded macOS path
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` with `--use-angle=metal --enable-gpu --ignore-gpu-blocklist`
(most also `--autoplay-policy=no-user-gesture-required`). Change `executablePath` (and drop `--use-angle=metal`) on other systems.
They log `[pageerror]` and console errors; screenshots go to `devtools/shots/` unless noted.

## Python

### `test_server.py` (Ardu Kart)
- Run: `devtools/.venv/bin/python devtools/test_server.py` (needs `pip install "python-socketio[client]" requests` in the venv).
- Starts `run_server.sh` as a subprocess on `ARDUKART_TEST_PORT` (default: a free port) with a temp data dir and `ARDUKART_DEBUG=1`.
- Sections printed as `== ...`: basics, solo LED, lobby, race 1, records, race 2 (host leaves), persistence across restart, 20-player lobby, motion controller (simulated board), wheel ownership, gestures and buttons, recording, Edge Impulse (fake API), train + build + install, manual model files, Motion detection brick (simulated).
- Uses `fake_ei.py` (`FakeEI`) and copies `ardu-kart/sketch` into a temp app dir, so the repo is not modified.
- Fails on any `Traceback` or `ERROR` in server logs. Ends with `ALL N CHECKS PASSED` or `FAILED: <label>` (exit 1).

### `fake_ei.py`
- `python3 devtools/fake_ei.py [api_key]` (default key `ei_` + 32 zeros) serves a fake Studio + ingestion API on a free local port and prints the env vars to set.
- Project id 4242; the "built" library is a stub `ardukart-wheel_inferencing` zip. Offline Motion Lab flow only; it does not train anything.

## Ardu Kart (puppeteer)

| Script | Args / env | Waits for | Output |
|---|---|---|---|
| `game_shot.js` | `[scenario,...] [port=7111]`; `W`,`H` (1600x900), `TRACK` (`sunset`), `TOGGLES` (for `go`: `hud,bloom,flames,particles,composer,mask,lines,vignette`) | `window.ardukart.state === "menu"` | `shots/<scenario>_<name>.png`, `QK {...}` lines, `errors: N` |
| `mp_test.js` | `[port=7111] [players=2]` (max 20; above 4 the extra viewports are 320x180) | menu in each context | `shots/mp_lobby_N.png`, `mp_p0_start_N.png`, `mp_p0_mid_N.png`, `mp_p0_end*.png` |
| `lab_check.js` | `ARDUKART_URL` (`http://localhost:7123`), `SHOTS` (`devtools/shots`) | `motion.online` | `lab_countdown.png`, `lab.png`, `game_main_menu.png`, `game_motion_cal.png`, `game_motion_settings.png`, `game_race_wheel.png`, `game_race_gas.png`, `game_race_other_screen.png`, `game_race_wheel_hud.png`; `ERRORS: none` |
| `probe.js` | `"<function body>" [port=7111]`; `N` (1), `DT` ms (1000) | menu | the returned value, N times |
| `board_probe.js` | `[url=http://127.0.0.1:7000]` | 6 s after load | JSON of the motion state |
| `shot.js` | views (`front rear close items` or `key=value`) | `window.__ready` on `http://localhost:8765/devtools/kart_preview/index.html` | `devtools/kart_preview/shot_*.png` |

`game_shot.js` scenarios: `basic` (title, main, chars, tracks), `race` (intro, go, AI drives the player, 4 drive shots), `go` (start sequence with optional render toggles, NaN camera check), `full` (1-lap race to results), `retry` (full, then RETRY, checks HUD and camera).

`lab_check.js` requires the server with `ARDUKART_SIM_BOARD=1 ARDUKART_DEBUG=1 ARDUKART_PORT=7123`. It covers recording in the Motion Lab, the game tab taking the wheel from the lab, calibration and settings screens, steering by `tilt`, `rev` shift lights in `/api/debug/mcu`, a second game tab, "USE THE WHEEL HERE", and hidden-tab hand-over.

`shot.js` needs `devtools/kart_preview/index.html`, which is gitignored (not in a clone), served from the repo root, for example `python3 -m http.server 8765`.

`check_tracks.mjs` imports `ardu-kart/assets/js/tracks.js` and checks each track's self-clearance (`minClear` vs `needed` = width + 2 x shoulder), min curve radius and max slope; writes `tracks.svg` to the current folder. `svg2png.mjs <in.svg> <out.png>` renders it with Chrome.

## Ardu Fishing

| Script | Args / env | Output |
|---|---|---|
| `fish_shot.js` | `[menus\|play] [port=7311]`; `W`,`H`; `PLAY_MS` (60000) | `shots/fish_menus_{title,main,tourney,motion,records,settings,help,lobby}.png`; `fish_play_{countdown,ph_<phase>,late,results}.png`; `AF {...}` stats; `no errors` / `ERRORS: N` |
| `fish_tourney.js` | `[port=7311]`; server with `ARDUFISH_MATCH_MS=40000` | `shots/fish_tourney_{lobby,mid,results}_{host,guest}.png`; lobby, scoreboard and results JSON |
| `aim_check.mjs` | none | Aim per second for several grips, calibration modes, a full roll while reeling |

The `play` autopilot overrides `input.poll` to aim at signs, cast, reel by tension and unhook. `fish_tourney.js` uses two browser contexts (own localStorage).

## Ardu Snowball

`snowball_shot.js [all|menus|play|lan] [port=7000]`, server with `ARDUKART_SIM_BOARD=1 ARDUSNOW_DEBUG=1`.
- `menus`: title, main and each menu screen.
- `play`: holds `tilt=0`, starts a solo match, plays `scoop`, `scoop`, `pack`, `throw`, `run` via `/api/debug/sim`, presses button C three times, logs `/api/debug/led` and `/api/debug/mcu`, then results.
- `lan`: two contexts; checks lobby join, host, team choice, bots fill 3 v 3, synced countdown (< 400 ms), guest sees the host move, same final score, back to lobby. Start the server with `ARDUSNOW_MATCH_MS=30000`.
- Prints `PASS`/`FAIL` lines, `no console errors`, `all checks passed`. Exit 0 ok, 1 errors or failed checks, 2 crash.

## Sketch tests (`devtools/sketch_test/`)

| File | Includes | Pass line |
|---|---|---|
| `render_test.cpp` | `ardu-kart/sketch/led_frames.h` | `render tests: OK` |
| `fish_render_test.cpp` | `ardu-fishing/sketch/led_frames.h` | `all fishing LED tests passed` |
| `snow_render_test.cpp` | `ardu-snowball/sketch/led_frames.h` | `all snowball LED tests passed` |

Build: `c++ -std=c++17 -o <name> <name>.cpp && ./<name>` inside `sketch_test/`. `arduino_shim.h` provides `String` and `millis()`.
