# Motion Lab and gesture messages: reference

Source: `<game>/python/controller.py` (`MotionHub.register()`), `<game>/python/brick_engine.py`, `<game>/sketch/sketch.ino`, `<game>/assets/js/train.js`, `<game>/assets/js/motion.js`. The code is the same in all three games unless noted.

## Socket.IO messages, browser to Python (`ui.on_message`)

| Message | Payload | Reply / effect |
|---|---|---|
| `motion_status` | `{}` | `status_payload()` + `ml` (last result): `{online, hw, installed, restartNeeded, job, owner, ownerKind, ownerVisible, engine}` |
| `motion_claim` | `{force, focused, visible, kind: "game" or "lab", release}` | `{owner, kind, visible}`, broadcasts `motion_owner` |
| `motion_visible` | `{visible}` | updates the owner's visibility |
| `motion_engine` | `{engine: "auto" or "brick" or "mcu"}` | `{ok, engine: engine_status()}`, saved to `motion.json` |
| `motion_record` | `{label, ms}` | `{ok, samples, interval}`. Later `motion_record_done {label, interval, values, durationMs}` to that tab only |
| `motion_record_cancel` | `{}` | `{ok}` |
| `ei_project` | `{apiKey}` | `{ok, project {id, name, owner}, summary {training, testing: {count, ms, labels}}, labels, impulse {windowMs, strideMs, hz, dsp, learn} or null, studio}` |
| `ei_upload` | `{apiKey, label, category, interval, values}` (values in g / deg/s, 6 per row) | `{ok, label, category, samples, file}` |
| `ei_job` | `{apiKey, kind: "retrain" or "build" or "train_build"}` | `{ok}`, then `ei_job_progress {stage, line, error?, installed?}` |
| `model_upload` | `{data}` base64 (data URL accepted), ≤ 8 MB | `{ok, installed {ok, folder, header, name, version}}` |
| `model_remove` | `{}` | `{ok}` |
| `pix` / `rev` (kart), `ctl_leds` | Pixels state / button LED mask | forwarded to the MCU (owner tab only) |

`ei_project` and `ei_upload` use a 40 s request timeout in `train.js`, and `model_upload` uses 60 s.

## Python to browsers (room `motion`)

| Message | Payload |
|---|---|
| `imu` | `{s: [[ax, ay, az, gx, gy, gz], ...], i: interval_ms}`, batches of `IMU_BATCH` = 2 |
| `ml` | `{labels, p, dsp, nn, t, src}` (`src` = `brick` or `mcu`) |
| `btn` | `{i: 0..2, p: bool}` |
| `hw` | `status_payload()` (on heartbeat, engine change, job end, install) |
| `motion_owner` | `{id, kind, visible}` |

## Bridge (MCU and Python)

| Direction | Name | Args |
|---|---|---|
| MCU → Python | `imu` | ax, ay, az (g), gx, gy, gz (deg/s), every sample |
| MCU → Python | `ml` | `probs_csv`, `dsp_ms`, `nn_ms` (4 Hz, `INFER_STRIDE_MS`) |
| MCU → Python | `btn` | index, pressed |
| MCU → Python | `hw` | `v=2;mv=;bt=;px=;interval=;model=1;name=;project=;deploy=;window=;axes=;labels=a\|b` every 2 s (`parse_hw()`) |
| Python → MCU | `ml_engine` | 1 = the MCU model drives (shows its own gestures), 0 = brick |
| Python → MCU | `gesture` | cls, label (≤24 chars), pct (brick results ≥ 0.7, non-idle) |

## Edge Impulse API calls (`_ei_request`, header `x-api-key`)

Base URLs: `STUDIO_URL` = `https://studio.edgeimpulse.com/v1/api` and `INGEST_URL` = `https://ingestion.edgeimpulse.com`. Both can be overridden with `<PREFIX>_EI_STUDIO_URL` / `<PREFIX>_EI_INGEST_URL` (used by `devtools/fake_ei.py`).

| Call | Purpose |
|---|---|
| `GET {STUDIO}/projects` | project of the key (`projects[0]`) |
| `GET {STUDIO}/{pid}` | `dataSummaryPerCategory` (counts, length, labels) |
| `GET {STUDIO}/{pid}/impulse` | `inputBlocks[0].windowSizeMs / windowIncreaseMs / frequencyHz`, dsp and learn block titles |
| `POST {INGEST}/api/{training or testing}/data` | data acquisition JSON (`device_type` `ARDUINO_UNO_Q`, `interval_ms`, `sensors` accX..gyrZ, values m/s² and dps). Headers `x-label`, `x-file-name: <label>.json`, `x-add-date-id: 1` |
| `POST {STUDIO}/{pid}/jobs/retrain` `{}` | train (DSP + learning blocks) |
| `POST {STUDIO}/{pid}/jobs/build-ondevice-model?type=arduino` `{"engine": "tflite-eon"}` | build the Arduino library |
| `GET {STUDIO}/{pid}/jobs/{id}/stdout` | log lines streamed to `ei_job_progress` |
| `GET {STUDIO}/{pid}/jobs/{id}/status` | `job.finished`, `job.finishedSuccessful` (polled every 2 s) |
| `GET {STUDIO}/{pid}/deployment/download?type=arduino&engine=tflite-eon` | library zip → `model_installer.install_zip()` |

Errors: 401/403 → "Edge Impulse rejected the API key". Other HTTP errors → `Edge Impulse HTTP <code>: <detail>`. Network errors → "cannot reach Edge Impulse (...). Is the board online?".

## Brick API used (`arduino.app_bricks.motion_detection.MotionDetection`)

- `get_model_info()` provides `axis_count`, `input_features_count`, `interval_ms` (or `frequency`), `labels`, `name` and `project_id`.
- `infer_from_features(flat_list)` returns `{result: {classification: {label: p}}, timing: {dsp, classification}}`. A bare `{classification}` is also accepted.

The brick's own detection loop (per-label callbacks) is not used. The game needs every probability 4 times per second, so `BrickEngine` keeps a rolling window and calls `infer_from_features()` itself. A one-slot job queue drops windows when the runner falls behind.
