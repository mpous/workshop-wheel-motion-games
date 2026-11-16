---
name: edge-impulse-motion-gestures
description: Design, record, train, deploy and map Edge Impulse gesture models for the UNO Q motion games (Ardu Kart, Ardu Fishing, Ardu Snowball). Covers choosing classes (one per action plus a big idle class), window size and frequency, the Motion Lab flow (/train.html, API key, recording, labels, training, Build & install), the Motion detection brick vs the MCU model engine (auto / brick / mcu), the "ml" message, defaultAction label mapping, threshold, confidence, edge and held actions, and troubleshooting. Use when someone mentions a gesture model, Edge Impulse, train, classes, labels, the Motion detection brick, an MCU model, label mapping, or gestures that fire at the wrong time.
---

# Edge Impulse motion gestures for the UNO Q games

This skill covers the path from a gesture idea to a game action: design the classes, record them in the Motion Lab, train in Edge Impulse, deploy to the **Motion detection brick** or the **MCU**, and map classes to actions in the browser.

Related skills (not repeated here):
- `unoq-motion-game`: overall architecture (sketch, Python, browser, multiplayer).
- `modulino-imu-aim`: gyro / accel aiming, calibration, drift.
- `motion-game-devtools`: simulated board, `/api/debug/sim`, headless tests.
- `arduino-unoq-applab`: general App Lab, bricks, `app.yaml`, CLI and Edge Impulse deployment.

All three games share the same gesture pipeline. `python/controller.py`, `python/brick_engine.py` and `python/model_installer.py` are identical apart from the log prefix (`[Ardu Kart]`, `[Ardu Fishing]`, `[Ardu Snowball]`), the env prefix (`ARDUKART_`, `ARDUFISH_`, `ARDUSNOW_`) and the Pixels message (`rev` in kart, `pix` in fishing and snowball). The games differ in `assets/js/motion.js`.

Details of every socket message and Edge Impulse call: [references/motion-lab-api.md](references/motion-lab-api.md).

## 1. Designing the classes

Rules:
1. **One class per game action.** The browser fires the action of the top class (see section 5), so two actions should never share a class.
2. **One big `idle` class that includes the aiming or steering motion.** The gyroscope aims all the time, so `idle` must cover holding the controller, turning or tilting it to aim, and small nervous moves. Otherwise aiming triggers gestures. Record more `idle` than any other class.
3. **Distinct gestures.** Different axes or rhythms (a flick vs. circles vs. a shake). Each gesture is repeated continuously for the whole recording (continuous motion recognition, "10 s ≈ 8–10 gestures" in `train.html`).
4. **Name labels so `defaultAction()` maps them** (section 5). Then no manual remapping is needed.
5. About 1 minute per class, for example six 10 s recordings (main `README.md` section 3.3).

| Game | `DEFAULT_LABELS` (`motion.js`) | Gesture ideas (README / `train.html`) |
|---|---|---|
| Ardu Kart | `idle`, `accelerate`, `brake`, `use_item`, `change_camera` | push the wheel forward / pull it towards you / quick up-down shake / short twist out of plane. `idle` = holding the wheel and steering normally |
| Ardu Fishing | `idle`, `cast`, `reel`, `unhook` | quick forward flick that stops sharply / small wrist circles like a reel handle / short upward jerk then a twist (README says sideways shake or twist). `idle` = holding the rod and aiming left and right |
| Ardu Snowball | `idle`, `scoop`, `pack`, `throw`, `run` | low sweeping dig / short squeezes and wrist rolls / overarm whip that stops sharply / arm pumping like sprinting. `idle` = still, tilting slowly to aim |

### Window, frequency and axes

| Setting | Value | Where |
|---|---|---|
| Recommended impulse | window **1000 ms**, increase **250 ms**, **62.5 Hz**, Spectral Analysis on all 6 axes, Classification | main `README.md` 3.2, hint in `train.js` (`renderImpulse` "No impulse yet") |
| Board sample rate without a model | `*_SAMPLE_US 16000UL` (62.5 Hz) | `sketch/sketch.ino` (`ARDUKART_`, `ARDUFISH_`, `ARDUSNOW_` prefix) |
| Board sample rate with an MCU model | `EI_CLASSIFIER_INTERVAL_MS * 1000` | same macro, `#if *_HAS_MODEL` |
| MCU window | `EI_CLASSIFIER_DSP_INPUT_FRAME_SIZE` values, `EI_CLASSIFIER_RAW_SAMPLES_PER_FRAME` axes | `*_WINDOW_VALUES`, `*_AXES` in `sketch.ino` |
| MCU inference rate | `INFER_STRIDE_MS = 250` (4 Hz) | `sketch.ino` |
| Brick inference rate | `STRIDE_MS = 250` | `python/brick_engine.py` |
| Brick window | `input_features_count / axis_count` samples at `interval_ms` from `MotionDetection.get_model_info()` | `BrickEngine._configure()` |
| Recorded sample | 6 axes `accX accY accZ` (m/s2), `gyrX gyrY gyrZ` (dps) | `SENSORS` in `controller.py` |

How they agree:
- The sketch streams `imu` in g and deg/s at its own rate and reports `interval=` in the `hw` heartbeat. Python records at that interval and converts acceleration to m/s² (`GRAVITY = 9.80665`) on upload.
- **MCU:** once a model is compiled in, the sketch samples at the model's rate and maps the impulse axes by name (`buildAxisMap()` parses `EI_CLASSIFIER_FUSION_AXES_STRING`, so `accX + accY + accZ` or `gyrZ` alone both work).
- **Brick:** `BrickEngine.push()` linearly resamples the board stream to the model's `interval_ms` and keeps the first `axis_count` channels in order (acc x y z, then gyro x y z). Models with fewer axes must use them in that order. `_configure()` rejects anything other than 1..6 axes.
- The Motion Lab warns when the impulse frequency differs from the board by more than 2 Hz (`renderImpulse` in `train.js`).

## 2. The Motion Lab flow (`assets/train.html` + `assets/js/train.js`)

Every Edge Impulse call goes through the board (`controller.py` `MotionHub`), so the browser never needs CORS access to Studio.

| Step | UI | Browser → Python | Python → Edge Impulse |
|---|---|---|---|
| 1. Connect | paste the `ei_...` key, **Connect** (optionally "Remember the key", `localStorage` key `ardukart.ei.key`, shared by the three games) | `ei_project {apiKey}` | `GET /v1/api/projects`, `GET /v1/api/{pid}`, `GET /v1/api/{pid}/impulse` |
| 2. Record | label, length 2/5/10/20 s, dataset Training / Testing / Auto 80/20, Upload or Review first. **RECORD**, Modulino button A or key R. 3-2-1 countdown | `motion_record {label, ms}`, then Python emits `motion_record_done`. Cancel: `motion_record_cancel` | none |
| 3. Upload | automatic, or after review (Discard / Download JSON / Upload) | `ei_upload {apiKey, label, category, interval, values}` | `POST ingestion /api/{training or testing}/data` with `x-label`, `x-file-name`, `x-add-date-id` |
| 4. Train | **Train the model** | `ei_job {kind: "retrain"}` | `POST /{pid}/jobs/retrain`, poll `jobs/{id}/stdout` and `jobs/{id}/status` every 2 s |
| 5a. Deploy to the brick | Studio link `.../deployment`, target **Arduino UNO Q**, then App Lab | none | none (done in Studio and App Lab) |
| 5b. Deploy to the MCU | **Build & install** / **Train + build + install** | `ei_job {kind: "build" or "train_build"}` | `POST /{pid}/jobs/build-ondevice-model?type=arduino` `{engine: "tflite-eon"}`, then `GET /{pid}/deployment/download?type=arduino&engine=tflite-eon` |
| 5c. Manual zip | "Install a library .zip manually", "Remove model" | `model_upload {data: base64}` (max 8 MB), `model_remove` | none |
| 6. Engine | chips Auto / Motion detection brick / Model on the MCU | `motion_engine {engine}` | none |
| 7. Test | live bars 4 times per second, top class, history, DSP/NN timing, threshold slider shared with the game | listens to `ml` | none |

Job progress arrives as `ei_job_progress {stage, line, error?, installed?}`. The stages are `training`, `trained`, `building`, `downloading`, `installing`, `done` and `error`. Only one job runs at a time per board, and a job times out after `JOB_TIMEOUT_S` (30 min).

Validation in `controller.py`: `API_KEY_RE` (`ei_` + 16..128 alphanumerics), `LABEL_RE` (letters, digits, space, `_ - .`, max 64), recording 200 ms..`MAX_RECORD_MS` (20 s), uploads of 2..`MAX_UPLOAD_SAMPLES` (4000) rows of 6 finite numbers.

## 3. The two inference engines

| | Motion detection brick (`"brick"`) | Model on the MCU (`"mcu"`) |
|---|---|---|
| Where it runs | the `arduino:motion_detection` brick container on Linux (`.eim`) | compiled into `sketch.ino` (STM32U585) |
| Deploy | Studio → Deployment → **Arduino UNO Q** → Build → Go to Arduino. In App Lab: click the brick → **AI models → Download** → **Brick Configuration** → select → **Save** → **Run**. App Lab stores the choice in `app.yaml` (the brick's model variable, `EI_MOTION_DETECTION_MODEL`, see `arduino-unoq-applab`) and restarts the app. The committed `app.yaml` files list the brick with no model, so the brick's default model is used (the kart comment names it: updown / wave / snake / idle) | **Build & install** in the Motion Lab, a manual zip, or `python3 <game>/python/model_installer.py <zip>` (`--remove` to undo). The installer unpacks into `sketch/libraries/<name>_inferencing`, adds `- dir: libraries/<folder>` to `sketch.yaml` and rewrites `model_config.h` (`*_HAS_MODEL 1`, `*_EI_HEADER <..._inferencing.h>`). **Restart the app**; the sketch recompiles in 1–3 min |
| Swap a model | in App Lab, no recompile | rebuild + restart |
| Python side | `BrickEngine` keeps its own rolling window and calls `MotionDetection.infer_from_features()` every `STRIDE_MS`. States: `off`, `starting`, `ready`, `error` (retries `get_model_info()` every `RETRY_S` = 10 s) | `on_ml` receives the Bridge `ml(probs_csv, dsp_ms, nn_ms)` from `runModel()` |
| Labels from | `get_model_info().labels` | the `hw` heartbeat `labels=a|b|c` (`ei_classifier_inferencing_categories`) |

**Choosing the engine** (`MotionHub._pick_engine()`): the preference is `ENGINES = ("auto", "brick", "mcu")`, saved on the board in `<data dir>/motion.json` and shared by every browser.
- `auto`: the MCU model if the sketch reports `model=1` and the board is online, else the brick if it is `ready`, else `None`.
- `brick` or `mcu`: that engine or nothing. The UI then says the engine "is not available — pick AUTO".
- When the engine changes, Python sends `ml_engine 1|0` to the MCU (the MCU shows its own gestures only when 1) and a fresh `hw` status to the browsers. Results from the inactive engine are dropped.
- With the brick, Python also notifies the MCU with `gesture(cls, label, pct)` for the LED matrix and Pixels flash. This happens at `GESTURE_CONFIDENCE = 0.7` for non-idle labels (`IDLE_RE`), at most once per 0.9 s per class. These are local board effects only; the game uses its own threshold.

**What the browser sees.**
- `ml` message (room `motion`): `{labels, p, dsp, nn, t, src}`. `p` holds the probabilities in label order, rounded to 3 decimals, `dsp` and `nn` are timings in ms, and `src` is `"brick"` or `"mcu"`. The last one is replayed in the `motion_status` reply (`st.ml`).
- `hw` / `motion_status`: `engine: {pref, active, labels, name, brick}`. `brick` = `{state, error, name, project, labels, axes, intervalMs, windowMs}`.
- `MotionController._onStatus()` takes `engine.labels` (falls back to `hw.labels`). `_onMl()` takes `m.labels`. So the class list, the map UI and the HUD bars always follow the **active** engine.
- HUD header: `` `${ENGINE_LABEL[eng] || 'EDGE IMPULSE'} · ${this.engineName}` `` with `ENGINE_LABEL = { brick: 'MOTION DETECTION BRICK', mcu: 'MODEL ON THE MCU' }`. Bars go `stale` after `ML_STALE_MS` (1500 ms). The settings screen chip reads "Brick model: …" / "MCU model: …" / "No gesture model running".

## 4. Labels to actions: `defaultAction()` per game

`actionFor(label)` = `settings.motion.map[label]` if set, else `defaultAction(label)`. The map is per browser (`localStorage` `ardukart.settings` / `ardufish.settings` / `ardusnow.settings`, key `motion.map`). The Motion Lab reads the same key to show each class's action. The sketch's `gestureIconFor()` in `led_frames.h` uses matching keywords for the LED icons.

| Game | Regex (first match wins, order as in code) → action |
|---|---|
| Kart | `idle\|noise\|none\|rest\|still\|background\|unknown` → none · `brake\|break\|stop\|slow` → brake · `accel\|gas\|forward\|throttle\|^go$\|faster\|updown\|up_down\|up-down` → accelerate · `item\|use\|fire\|throw\|shoot\|punch\|wave` → item · `cam\|view\|snake\|circle` → camera · `back\|look\|behind` → lookBack · `drift\|hop\|jump` → drift · `pause\|menu` → pause |
| Fishing | idle set + `repos` → none · `unhook\|release\|treu\|ham\|free` → unhook · `reel\|pull\|drag\|arross\|recull\|crank\|circle\|snake` → reel · `cast\|throw\|llan\|lanz\|tir\|flick\|wave\|updown\|up_down\|up-down` → cast · `pause\|menu` → pause |
| Snowball | idle set + `repos` → none · `scoop\|dig\|grab\|recull\|recoll\|recog\|pala\|shovel` → scoop · `pack\|press\|squeez\|compact\|prem\|apret\|clap` → pack · `throw\|launch\|shoot\|llan\|lanz\|tir\|flick\|punch` → throw · `run\|sprint\|dash\|corr\|jog\|shake` → run · `pause\|menu` → pause |

Anything unmatched → `none`. The regexes include Catalan and Spanish stems (for example `llan`, `tir`, `recull`).

**Remap UI:** the game's **Train your motion controller** screen (`ui.js`), "GESTURE → ACTION". It has one selector per label of the running model, or per `DEFAULT_LABELS` when no model runs, with choices from `ACTIONS`:
- Kart: NOTHING, ACCELERATE, BRAKE, USE ITEM, CHANGE CAMERA, LOOK BACK, DRIFT, PAUSE.
- Fishing: NOTHING, CAST, REEL, UNHOOK, PAUSE.
- Snowball: NOTHING, SCOOP, PACK, THROW, RUN, PAUSE.

The same screen has **GESTURE CONFIDENCE** (`threshold`, clamped 0.3..0.98, default 0.7), **GESTURE ENGINE** and live class bars with the threshold mark.

## 5. Firing rules (`MotionController._onMl()` / `_gesture()`)

1. Ignored when replayed (`motion_status`) or when this tab does not drive (`active` false: rod or wheel off, offline, or owned by another tab).
2. Every label with `p < threshold * 0.6` is **re-armed** (`armed[label] = true`).
3. Only the **top class** counts, and only if `p >= threshold` and its action is not `none`.
4. **Edge actions** (`EDGE`) fire once. They need the label to be armed and `EDGE_COOLDOWN_MS` to have passed since the same action last fired. After firing, the label is disarmed until it fades below 60 % of the threshold.
5. **Held actions** (`HOLD_MS`) stay on for that many ms after each detection, so a continuous gesture keeps them on.

| Game | `EDGE` | `HOLD_MS` | `EDGE_COOLDOWN_MS` | Confidence used as |
|---|---|---|---|---|
| Kart | accelerate, item, camera, pause | brake 600, lookBack 450, drift 450 | 500 | not used. `accelerate` sets `cruise = true` (throttle stays on until a brake). A brake while moving stops the kart; a brake at a standstill reverses |
| Fishing | cast, unhook, pause | reel 600 | 700 | **cast strength**: `pulses.set('cast', p)`. `game.js _cast(p)` scatters by `lerp(4.5, 0.6, (p-0.5)/0.5)`; ≥0.9 is "PERFECT CAST", ≥0.75 "GREAT CAST" |
| Snowball | scoop, pack, throw, pause | run 600 (README: about 0.6 s of sprint per detection) | 700 | **throw power**: `poll().throw = p`, passed to `aimVelocity()` / `throwBall()` |

**Button fallbacks** (`_onButton`, `input.js`), so the game works without a model:

| Game | A | B | C |
|---|---|---|---|
| Kart | hold to accelerate | use item | hold to accelerate |
| Fishing | cast at `settings.buttonCast` (default 0.8, slider "BUTTON CAST STRENGTH" 0.5..1) | hold to reel | unhook |
| Snowball | throw at `settings.buttonThrow` (default 0.85, "BUTTON THROW POWER") | hold to run | scoop or pack, whichever makes sense (`snow`) |

In menus A / B / C mean ok / back / next (`menuQueue`).

## 6. Reusing a model from another game

Every game shows whatever labels the active engine reports, so any model works after remapping:
- **Kart model in Fishing:** `accelerate`, `brake`, `use_item` and `change_camera` match no fishing regex, so they all default to NOTHING. Map them by hand, for example `accelerate` → CAST, `brake` → REEL, `use_item` → UNHOOK. Push-forward works well as a cast and a pull as a reel. `brake` becomes a held action (REEL, 600 ms) only through the mapping. Snowball would need the same manual mapping.
- **Default brick model (updown / wave / snake / idle):** Fishing maps `wave`/`updown` → cast and `snake` → reel. Kart maps `updown` → accelerate, `wave` → item and `snake` → camera. Snowball maps none of them, so remap there.

Why a dedicated model is better:
- Its `idle` class was recorded with **this game's** aiming motion. The rod's yaw sweep is not the kart's wheel roll, so a borrowed model fires while you aim.
- Confidence drives fishing cast strength and snowball throw power, so a gesture that does not match the movement gives weak, noisy values.
- The class count matches the actions (no unused classes taking probability mass), and the default names map with no setup on every browser. The map lives in each browser's `localStorage`.

## 7. Troubleshooting

| Symptom | Check / fix |
|---|---|
| Gestures fire while aiming or steering | Record more `idle` while aiming the way you play, then retrain. Raise **Gesture confidence**. Make sure `idle`-like labels match the idle regex, or map them to NOTHING |
| An edge action never fires twice | The class never falls below `threshold * 0.6` between gestures (not re-armed). Make the gestures more distinct or add `idle` between them |
| Wrong classes in the HUD or map | Check **Gesture engine**. With *Auto*, an installed MCU model wins over the brick, so pick *Motion detection brick* to use the App Lab model. The HUD header shows which engine and model is active |
| Brick "not available" or "Retrying..." | `Motion detection brick not available (...)` = the brick is not in the runtime. `Motion detection brick: ... Retrying...` = the runner did not answer (first start downloads the container, which takes a few minutes) or `unsupported model: N axes` / `missing window / frequency / labels`. Pick a model in Brick Configuration, Save, Run |
| Brick ready but no bars | Python only feeds the brick while it is the active engine (`_active == "brick"`). Look for `brick inference failed:` in the logs |
| Board still says "no model" after Build & install | Restart the app (`arduino-app-cli app stop user:<app> && arduino-app-cli app start user:<app>`). The Motion Lab shows "Restart the app to flash the new model" while `restartNeeded` is true (an install or removal, or the board's `model=` differs from `model_config.h`). If it persists, the compile failed: read `arduino-app-cli app logs` |
| MCU build failures | The Studio job log streams into the Motion Lab. "this zip is not an Edge Impulse Arduino library (no src/*_inferencing.h)" = wrong export (use Arduino library, not the UNO Q `.eim`). For compile errors, read `arduino-app-cli app logs`. If the model is too big for the MCU, try a smaller impulse or use the brick. `model_installer.py --remove` restores `*_HAS_MODEL 0` so the app starts again |
| "Edge Impulse rejected the API key" | 401/403 from Studio. Copy the key again from Dashboard → Keys |
| Impulse Hz warning | The impulse frequency does not match the board's. Set 62.5 Hz, or record again after installing the model (the sketch then samples at the model's rate) |
| Motion Lab shows no Modulinos | Qwiic cables. Modulinos are probed every 2.5 s (`PROBE_INTERVAL`) |

Game READMEs: main `README.md` "Troubleshooting" and sections 3.2–3.5 (kart, and they apply to all games), `ardu-fishing/README.md` section 5, `ardu-snowball/README.md` section 2. Python logs: `arduino-app-cli app logs user:<app>` (prefixes `[Ardu Kart]`, `[Ardu Fishing]`, `[Ardu Snowball]`). Without hardware, use `ARDUKART_SIM_BOARD=1` / `ARDUKART_SIM_BRICK=1` / `ARDUKART_SIM_MODEL=0` (see `motion-game-devtools`).

## Checklist: adding a gesture or action to a game

1. Add the action to `ACTIONS`, to `EDGE` or `HOLD_MS`, and a keyword branch in `defaultAction()` (`assets/js/motion.js`), plus `DEFAULT_LABELS`.
2. Read it in `poll()` and use it in the game loop. Add a button fallback if needed.
3. Mirror the keyword in `gestureIconFor()` (`sketch/led_frames.h`) if the LED matrix should show an icon.
4. Add the gesture card in `assets/train.html` and the README class table.
5. Record the new class plus extra `idle`, retrain, redeploy (brick: reselect the model in App Lab. MCU: Build & install + restart).
