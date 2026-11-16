# Message reference

All names are taken from `python/controller.py`, `python/main.py`, `sketch/sketch.ino` and `assets/js/*.js`. "Room" means a Socket.IO room of the WebUI brick: the browser joins it with `Net.joinRoom(name)`, which emits `enter_room`. A Python handler that returns a value answers with `<name>_response`, which `Net.request(name, data, timeout)` resolves (or resolves with `null` after the timeout).

## MCU ⇄ Python (Bridge)

| Name | Dir | Args | Sketch side | Python side |
|---|---|---|---|---|
| `imu` | MCU→Py | `ax, ay, az, gx, gy, gz` (g, deg/s) | `sampleImu()`, every `<PREFIX>_SAMPLE_US` | `MotionHub.on_imu`: batches `IMU_BATCH`, feeds the recordings and `BrickEngine.push` |
| `ml` | MCU→Py | `probs_csv, dsp_ms, nn_ms` | `runModel()`, every `INFER_STRIDE_MS = 250` once the window is full | `on_ml`: ignored unless the active engine is `mcu` |
| `btn` | MCU→Py | `index 0..2, pressed` | `pollButtons()` every 15 ms, edges only | `on_btn` |
| `hw` | MCU→Py | `k=v;...` (`v, mv, bt, px, interval, model, name, project, deploy, window, axes, labels`) | `sendInfo()` every 2 s | `on_hw` → `parse_hw()` |
| `led_state` | Py→MCU | one string | `onLedState` → `parseLedState()` in `led_frames.h` | `push_led_state()` in `main.py tick()` |
| `pix` | Py→MCU | `mode 0..7, value -100..100` | `onPix` (Fishing, Snowball) | `on_pix` → `flush_pix` |
| `rev` | Py→MCU | `speed 0..150, flags` (bit0 racing, bit1 boost, bits2-3 drift level, bit4 finished) | `onRev` (Kart) | `on_rev` → `flush_rev` |
| `btn_leds` | Py→MCU | `mask` (bits A/B/C) | `onButtonLeds` → `buttons.setLeds` | `on_leds` (from browser `ctl_leds`) |
| `gesture` | Py→MCU | `cls, label[:24], pct` | `onGesture` → `showGesture` | `_on_brick_ml` (brick results ≥ 0.7, not idle, ≤ 1 per 0.9 s per class) |
| `ml_engine` | Py→MCU | `1` MCU model drives, `0` brick drives | `onEngine` | `_send_ml_engine` (forced on every `hw`) |

The MCU timeouts are `LED_STATE_TIMEOUT = 3500` (then the dim idle frame) and Fishing's `PIX_TIMEOUT = 1200` (then the idle scanner). Python must keep resending.

### LED matrix state strings (`led_frames.h` header comment)

| Game | States |
|---|---|
| Kart | `idle` · `lobby:<n>` · `count:<N>` · `race:<lap>:<laps>:<pos>` · `finish:<pos>` |
| Fishing | `idle` · `lobby:<n>` · `count:<N>` · `fish:<secsLeft>:<fish>:<phase>` (phase 0 aim, 1 waiting, 2 bite, 3 fight, 4 unhook, 5 caught) · `finish:<fish>:<place>` |
| Snowball | `idle` · `lobby:<n>` · `count:<N>` · `play:<secsLeft>:<ammo>:<flags>:<my>:<their>:<snow%>` (flags 1 star carried, 2 frozen, 4 our star stolen, 8 snow in hands) · `finish:<my>:<their>:<result>` (0 loss, 1 win, 2 draw) |

### Pixels modes

- Fishing `onPix`: 0 idle, 1 aim (value = aim −100 left .. 100 right), 2 waiting, 3 bite, 4 fight (value = tension), 5 unhook (value = progress), 6 caught, 7 snapped or escaped.
- Snowball `onPix`: 0 idle, 1 playing (value = ammo×10 + snow 0..9), 2 carrying the enemy star, 3 frozen (value = time left), 4 hit landed, 5 star captured, 6 our star stolen, 7 countdown (value = seconds).
- Kart `onRev`: shift lights from speed and flags.
- In all games a gesture flashes its `CLASS_RGB` colour for about 260 ms.

## Python ⇄ browser: motion controller (`MotionHub.register()`)

| Message | Dir | Payload / reply |
|---|---|---|
| `motion_status` | req | → `status_payload()` + `ml` (last result) |
| `hw` | push, room `motion` | `{online, hw, installed, restartNeeded, job, owner, ownerKind, ownerVisible, engine:{pref, active, labels, name, brick}}` |
| `imu` | push, room `motion` | `{s:[[ax,ay,az,gx,gy,gz],...], i}` |
| `ml` | push, room `motion` | `{labels, p, dsp, nn, t, src:'mcu'\|'brick'}` |
| `btn` | push, room `motion` | `{i, p}` |
| `motion_claim` | req | `{force, focused, visible}` / `{force, kind:'lab'}` / `{release}` → `{owner, kind, visible}` |
| `motion_visible` | req | `{visible}` (owner only) |
| `motion_owner` | push, room `motion` | `{id, kind, visible}` |
| `motion_engine` | req | `{engine:'auto'\|'brick'\|'mcu'}` → `{ok, engine}` |
| `pix` / `rev` | send | see above (owner only, `_may_drive`) |
| `ctl_leds` | send | `{mask}` (owner only) |

## Python ⇄ browser: Motion Lab (`train.js`)

| Message | Payload / reply |
|---|---|
| `motion_record` | `{label, ms}` (0.2 .. 20 s) → `{ok, samples, interval}`, then the push `motion_record_done {label, interval, values, durationMs}` to that sid |
| `motion_record_cancel` | → `{ok}` |
| `ei_project` | `{apiKey}` → `{ok, project, summary, labels, impulse, studio}` |
| `ei_upload` | `{apiKey, label, category, interval, values, device}` → ingestion `/api/<category>/data` |
| `ei_job` | `{apiKey, kind:'retrain'\|'build'\|'train_build'}` → `{ok}`, then the push `ei_job_progress {stage, line, ...}` |
| `model_upload` | `{data: base64 zip ≤ 8 MB}` → `model_installer.install_zip` |
| `model_remove` | → `{ok}` |

## Python ⇄ browser: game (`main.py`)

Common to all three: `hello {name}` → `{id, serverTime, records, version, lobby, ...}`, `clock {t}` → `{t, serverTime}`, `solo_status {...}`, `record {...}` → ranks, `get_records`, the `records` broadcast and `GET /api/status`. With `<PREFIX>_DEBUG=1` there are also `GET /api/debug/led`, `/api/debug/mcu` (stub Bridge only) and `/api/debug/sim`.

| Game | Lobby / match messages | Rooms |
|---|---|---|
| Kart | `lobby_join`, `lobby_leave`, `lobby_update {character, name, ready}`, `lobby_settings {track, cc, laps, bots}`, `lobby_start`, `state {karts}`, `event {type,...}`, `finish {id, time, bestLap}`; pushes `lobby`, `race_start`, `race_results` (to everyone), `snapshot`, `event`, `player_left` (room `race`) | `race` |
| Fishing | `tourney_join {name, board}`, `tourney_leave`, `tourney_ready {ready}`, `tourney_start`, `tourney_score {fish, kg, phase}`, `tourney_catch {species, kg, rarity}`, `tourney_state`; pushes `tourney_lobby`, `tourney_start`, `tourney_scores`, `tourney_results` | `tourney` |
| Snowball | `lobby_join`, `lobby_leave`, `lobby_update {ready, team}`, `lobby_start`, `state {ents, game}`, `event {type,...}`, `match_state`; pushes `lobby`, `match_start` (room `lobby`), `snapshot`, `event`, `player_left {id, hostId}`, `match_results` (room `match`) | `lobby`, `match` |
