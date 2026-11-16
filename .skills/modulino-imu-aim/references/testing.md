# Testing aim and steering

There are three layers. Run them in this order: synthetic data, then the simulated
board, then the real board.

## 1. `devtools/aim_check.mjs` (synthetic IMU, real filter)

```bash
cd devtools && node aim_check.mjs        # or: node devtools/aim_check.mjs from the repo root
```

The script imports `MotionController` from `../ardu-fishing/assets/js/motion.js`. It
needs no DOM, because `controller(cal)` builds the object with
`Object.create(MotionController.prototype)` and an explicit state list:

```js
angle, yaw, tilt, up, rawAngle, steer, acc, gyro, bias, samples,
autoRef, autoAcc, autoN, turnRate, capture, listeners, app: { saveSettings() {} }
```

If you add a state field to the constructor, add it here too.

### Helpers

| Helper | What it does |
|--------|--------------|
| `rot(v, k, a)` | Rodrigues rotation of `v` about the unit axis `k` by `a` rad |
| `noise(s)` | uniform noise in ±s |
| `run(name, up, axis, profile, opts)` | Simulates `secs / 0.016` samples. Gravity is `rot(up, axis, -a)`. The gyro is `axis * rate + bias + noise(0.4)`. It calls `_sample`, `_updateSteer` and `_captureStep`, and prints `-steer` (+ = right) every `every` samples (62 is about 1 s). It returns the controller |
| `opts.bias` | constant `[x, y, z]` in deg/s, or `t => [...]` for drift |
| `opts.cal` / `opts.m` | start from a stored calibration, or continue with an existing controller |
| `opts.flick` | `{at, axis}`: a 0.4 s, 400°/s pitch-like burst plus 1.5 g, which imitates a cast |
| `calibrated(name, up, axis)` | `startCalibration()` and `captureCentre()` (1.5 s still), then `captureRight()` (30° right over 1 s, then held). It prints `mode` and `range`, then plays a turn sequence |
| `turn(t)` | the standard profile: 30° right at 1 s, hold, centre at 8 s, 20° right at 10 s |

`up` is what the accelerometer reads at rest, in the board frame. `axis` is the board
axis about which a positive rotation is a turn to the **right**. For yaw this is `-up`
(clockwise seen from above).

### Expected output (current code)

- The yaw cases (upright, flat, on its side, tilted 40°) and the kart roll read
  `0.00 0.00 0.8x … 0.8x 0.0x 0.00 0.4x 0.50 0.50`.
- The `calibrated …` cases show `mode=yaw` (or `mode=tilt` for the kart roll), a
  `range` of about 25°, then `1.00 1.00 0.00 … 1.00`.
- `3 min still, drifting bias`: all values are `0.00`.
- `cast flick at 4 s`: the aim stays at about 0.35.
- `full roll while reeling, then still`: it ends with `angle=0°`. Before `f49510d` it
  stuck at 360°.

### Adding a scenario

Append it to the end of the file. Example: a slow yaw, which tests bias absorption.

```js
// slow turn: 2°/s for 10 s (below the 3°/s "still" threshold), then hold
run('slow yaw 2°/s, then hold', [0, 1, 0], [0, -1, 0], (t) => Math.min(t, 10) * 2 * DEG, { secs: 14 });
```

Today this prints all `0.00` and then about `-0.08`. The bias tracking eats very slow
turns (SKILL.md pitfall 6).

For a motion that `run()` cannot express, such as a tumble, a changing acceleration
magnitude, or a turn about a moving axis, write your own loop, as the "full roll while
reeling" block does. Build `s = [ax, ay, az, gx, gy, gz]` in g and deg/s, then call
`m._sample(s, DT); m._updateSteer();`.

Good scenarios to keep:
- every mounting you support, uncalibrated *and* calibrated
- the inverse direction (`calibrated('… the other way round', up, negated axis)`)
- long stillness with a drifting bias
- every gesture model class played as a burst in the middle of a hold
- a full 360° roll or yaw during shaking, then rest

To test Kart or Snowball, change the import path. Note that their controllers have no
`yaw` or `tilt` fields.

## 2. Simulated board (`devtools/stub/arduino/app_utils/sim_board.py`)

Start a game with `ARDUKART_SIM_BOARD=1` (for example with `devtools/run_fishing.sh`).
Add `ARDUFISH_DEBUG=1`, `ARDUKART_DEBUG=1` or `ARDUSNOW_DEBUG=1` to expose
`/api/debug/sim`:

```
/api/debug/sim?tilt=0.5      # radians, + = left, clamped to ±1.2
/api/debug/sim?auto=1        # back to the gentle sway 0.35·sin(0.6 t)
/api/debug/sim?gesture=cast  # SHAPES: accelerate, brake, use_item, change_camera, cast, reel, unhook, scoop, pack, throw, run
```

The simulated motion is **only a Kart-style roll about z**: `acc = [sin a, cos a, 0]`,
the rate on `gz`, and a constant gyro bias of `0.8, -0.5, 1.2`. It is good for checking
the end-to-end plumbing, the HUD, the ownership logic and gestures. It **cannot**
reproduce yaw (gravity never stays fixed while the gyro turns), so pitfalls 1 and 2
would have passed here. Use aim_check for filter work. See `motion-game-devtools` for
the runners and the headless browser tests.

## 3. Real board: the browser console

| Game | Global (`main.js`) |
|------|--------------------|
| Ardu Kart | `window.ardukart` |
| Ardu Fishing | `window.ardufish` |
| Ardu Snowball | `window.ardusnow` |

```js
const m = ardufish.motion;                 // the MotionController
m.imuRate                                  // about 62 samples/s, else the stream or Bridge is the problem
[m.online, m.owned, m.active, m.ownerKind] // input looks dead? check ownership first
m.settings.cal                             // {mode, ref, sign|axis, bias, range, at} or null
m.bias, m.up                               // deg/s and unit gravity
const off = m.on((w) => { if (w === 'imu')
  console.log((m.yaw*57.3).toFixed(1), (m.tilt*57.3).toFixed(1), (m.turnRate*57.3).toFixed(0), m.steer.toFixed(2)); });
off();                                     // stop logging
m.recentre(); m.resetCalibration();        // the same as the buttons
```

How to read it:
- The aim creeps back to centre after a turn, while `turnRate` was correct during the
  turn. The accelerometer is correcting an axis it cannot see (pitfall 1).
- `|tilt|` or `|angle|` is above 180° while the device rests: missing wrap (pitfall 2).
- The aim drifts while the device rests: compare `m.gyro` with `m.bias`. If they differ
  by more than about 1°/s, the bias tracking is blocked (the device is not `calm`, or
  Kart is calibrated).
- The HUD moves but the game does not: `m.active` is false (another tab or the Motion
  Lab owns the device).
