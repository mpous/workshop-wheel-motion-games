# Simulated board and stub bricks

Source: `devtools/stub/arduino/app_utils/sim_board.py`, `devtools/stub/arduino/app_utils/__init__.py`,
`devtools/stub/arduino/app_bricks/motion_detection/__init__.py`.

## How it starts

`Bridge.provide("hw", ...)` in the stub creates `SimBoard(Bridge)` when `ARDUKART_SIM_BOARD=1`.
Each game's controller provides `hw`, so the sim starts as soon as `main.py` wires the motion controller.
It waits 0.5 s, then runs a 16 ms loop.

## What it emits (as the sketch would over the Bridge)

| Message | Rate | Content |
|---|---|---|
| `imu(ax, ay, az, gx, gy, gz)` | every 16 ms (62.5 Hz) | g and deg/s. Gravity from the current roll, gaussian noise (0.01 g, 0.4 dps) and a fixed gyro bias (0.8, -0.5, 1.2 dps), plus the gesture shape. |
| `hw("v=2;sim=1;mv=1;bt=1;px=1;interval=16.00;model=1;name=...;labels=a\|b")` | every 125 samples (2 s) | Movement, Buttons and Pixels "detected"; `model=0` with `ARDUKART_SIM_MODEL=0`. |
| `ml("p0,p1,...", 2, 1)` | every 16 samples (4 Hz) | Fake probabilities over `ARDUKART_SIM_LABELS`; the played gesture wins from 150 ms to 900 ms, else the first label. |
| `btn(i, pressed)` | on command | Press on `command(button=)`, release after `hold` (default 0.12 s). |

## Tilt model

The board is held upright facing the player (+z towards them, +y up) and turned about z.
`tilt_now` follows the target with a 0.25 low-pass per sample; `gz` is the derivative of the angle.
Target = `tilt` from the debug API (clamped to +-1.2 rad), or `0.35 * sin(0.6 t)` in auto mode.
This matches the Kart wheel. Rod (Fishing) and controller (Snowball) grips are not modelled; the
game filters still see a plain roll. Use `devtools/aim_check.mjs` for other grips.

## Gesture shapes (`SHAPES`)

| Game | Labels with a shape |
|---|---|
| Kart | `accelerate`, `brake`, `use_item`, `change_camera` |
| Fishing | `cast`, `reel`, `unhook` |
| Snowball | `scoop`, `pack`, `throw`, `run` |

A label without a shape (for example `idle`) changes nothing on the IMU, but still wins in `ml` if it is in the label list.
Shapes are synthetic sine/gaussian bursts so recorded Motion Lab samples look different per class; they are not real recordings.

## Stub Motion detection brick

Enabled by `ARDUKART_SIM_BRICK=1`. `MotionDetection.get_model_info()` returns a fake model
(`project_id=4242`, 6 axes, 62-sample window, `interval_ms=16`). `infer_from_features()` requires exactly
372 features and returns the gesture the sim board is playing (same 150-900 ms window), so it is useful
only together with `ARDUKART_SIM_BOARD=1`. Labels: `ARDUKART_SIM_BRICK_LABELS` or the sim board's labels.
`test_server.py` (`brick_tests`) shows the engine selection flows with `ARDUKART_SIM_MODEL=0`.

## Driving the sim

From HTTP (needs `<P>_DEBUG=1`): `/api/debug/sim?tilt=&gesture=&button=&hold=&auto=`.
In-process (tests): `Bridge.sim.command(tilt=..., gesture=..., button=..., hold=..., auto=True)`; `Bridge.sim.state()`.
