---
name: modulino-imu-aim
description: Turn Arduino Modulino Movement (LSM6DSOX) accelerometer and gyroscope data into robust steering or aiming for browser motion games on the Arduino UNO Q, as done in MotionController (assets/js/motion.js) of ardu-kart, ardu-fishing and ardu-snowball. Use when adding or debugging steering, aiming, tilt or turn controls, choosing roll vs yaw vs pitch, writing a complementary filter, gyro bias or drift handling, angle wrapping, deadzone and sensitivity, the calibration flow (centre + full right, re-centre), or when the aim snaps back to centre, drifts, sticks at full lock, or looks dead. Also covers testing aim with devtools/aim_check.mjs, the simulated board and the browser console.
---

# Modulino IMU aim and steering

The three games turn one IMU stream into one number: `steer` in -1..1. This skill is
about that path. For the overall app architecture see `unoq-motion-game`; for the
simulator, test runners and deploy see `motion-game-devtools`; for gesture models see
`edge-impulse-motion-gestures`; for App Lab, bricks and the Bridge see
`arduino-unoq-applab`.

| Game | Device | Motion used for aim | Filter in `_sample` | Output field from `poll()` |
|------|--------|---------------------|---------------------|-----------------------------|
| `ardu-kart` | steering wheel | roll about the board normal | complementary (gyro + accel) on one axis | `steer` (+ = left) |
| `ardu-fishing` | rod | yaw about gravity (gyro only), plus any tilt | yaw integrator + complementary tilt | `aim` (+ = left) |
| `ardu-snowball` | hand controller | tilt ("tilt it fully right") | same as Kart | `turn` (+ = left, a turn *rate*) |

Snowball still has the Kart filter. Fishing is the newest design. Copy the fishing
filter when you start a new game.

## 1. Data path, units, frames

- `sketch/sketch.ino` `sampleImu()` runs every `ARD*_SAMPLE_US` (16000 us = 62.5 Hz, or
  `EI_CLASSIFIER_INTERVAL_MS` when a model is compiled in) and calls
  `Bridge.notify("imu", ax, ay, az, gx, gy, gz)`.
  - Acceleration is in **g**, angular rate in **deg/s**, both in the **board frame**.
  - The library calls the rates `movement.getRoll()/getPitch()/getYaw()`. They are the
    x/y/z **rates**, not angles.
  - Only the model input is converted to m/s² (`v * GRAVITY`).
- `python/controller.py` `on_imu()` batches `IMU_BATCH = 2` samples and sends Socket.IO
  `"imu"` to the room `"motion"`:
  ```json
  { "s": [[ax, ay, az, gx, gy, gz], [...]], "i": 16.0 }
  ```
  `i` is the sample interval in ms, from the `hw` heartbeat `interval=`. The rate is about
  31 messages/s.
- `MotionController._onImu(m)` takes `dt = (m.i || 16) / 1000`. It runs `_sample(s, dt)`
  for each sample, then calls `_updateSteer()` once, then `_captureStep()` if a
  calibration is running.
- At rest, the accelerometer reads **+1 g pointing up**. Its normalised value works as
  the "up" vector (`ref`, `autoRef`, `up`).

### Sign conventions (keep them)

| Quantity | Convention |
|----------|------------|
| `angle`, `yaw`, `tilt`, `rawAngle`, `turnRate` | radians or rad/s, **+ = right** |
| `steer` (and `aim` / `turn` in `poll()`) | **+ = left** (`this.steer = -x`) |
| Yaw to the right | clockwise seen from above = **negative** rotation about `up`. Uncalibrated it is `yawRate = -dot(w, up)` |
| Uncalibrated Kart axis | `[0,0,-1]` if `|ref[2]| < 0.75` (upright board), else `[0,-1,0]` (flat board) |
| `angleAbout(ref, g, axis)` | the board rotation about `axis` that takes gravity from `ref` to `g`. The minus is there because gravity turns the other way in the board frame |
| Sim board `tilt` | radians, **+ = left** (counter-clockwise wheel) |
| HUD | `AIM LEFT/RIGHT n°` shows `|angle|`. `GYRO` shows `turnRate` in °/s, then the raw gyro x y z |

## 2. Choose the motion

Ask how the player holds the device and what "turn right" means to them.

| Motion | What the accelerometer sees | How to filter | Example |
|--------|-----------------------------|---------------|---------|
| **Roll or tilt** about a horizontal axis | gravity moves in the board frame | complementary filter (accel corrects gyro drift) | Kart wheel, snowball tilt |
| **Yaw** about the vertical | **nothing**: gravity does not move | gyro only: integrate the rate about `up`, track the bias | fishing rod pointed left/right |
| **Pitch** (nose up/down) | yes | complementary filter | avoid for aim if gestures (cast, throw) are pitch flicks |

Rules:
- If the natural gesture is "point it over there", it is **yaw**. The accelerometer
  cannot measure it. A complementary filter pulls it back to centre (pitfall 1).
- Do not aim on the same axis as the main gesture. A cast is a fast pitch, so the rod
  aims with yaw.
- **Uncalibrated defaults matter.** Most players never calibrate. Fishing handles both
  cases with no calibration: yaw about gravity *plus* tilt about a horizontal auto axis
  (`_autoAxis()`). So a held rod and a Kart-style roll both work out of the box
  (aim_check "kart wheel roll (about z)").
- The first 30 samples (about 0.5 s) after load, or after `resetCalibration()`, are
  averaged into `autoRef` and the gyro `bias`. The board must be still and centred then.

## 3. Filter recipes (real code)

Full excerpts and the helpers (`dot`, `cross`, `reject`, `angleAbout`) are in
[references/filter-recipes.md](references/filter-recipes.md). Summary of
`ardu-fishing` `_sample()`:

```js
const w = sub(gyro, this.bias);                    // deg/s, bias removed
const still = len(w) < 3;
const calm = Math.abs(g - 1) < 0.15;               // accel measures mostly gravity
if (calm) this.up = norm(this.up.map((v, i) => v + (acc[i] / g - v) * 0.05));  // gravity low-pass
// yaw: gyro only, about the low-passed gravity
yawRate = (cal ? cal.sign : -1) * dot(w, this.up) * DEG;
const lim = ((cal && cal.range) || DEFAULT_RANGE) / (0.5 + s2.sensitivity) * 1.5;
this.yaw = clamp(this.yaw + yawRate * dt, -lim, lim);          // soft clamp
// tilt: complementary filter about a horizontal axis
const shaking = Math.abs(g - 1) > 0.22 || len(reject(acc, axis)) < 0.35;
let a = this.tilt + tiltRate * dt;
if (!shaking) { let d = accAngle - a; d = Math.atan2(Math.sin(d), Math.cos(d)); a = a + 0.04 * d; }
this.tilt = Math.atan2(Math.sin(a), Math.cos(a));               // wrap to ±180°
this.angle = this.yaw + this.tilt;
if (still && calm) this.bias = this.bias.map((v, i) => v + (gyro[i] - v) * 0.003);
```

| Technique | Fishing | Kart / Snowball |
|-----------|---------|-----------------|
| Gyro bias at start-up | mean of the first 30 samples (uncalibrated), or `cal.bias` copied into `this.bias` in the constructor and then tracked | mean of the first 30 samples (uncalibrated). Calibrated, it uses the fixed `cal.bias` (`({ ref, axis, bias } = cal)`) |
| Bias tracking | always when `still && calm`, gain 0.003 per sample (about 5 s) | only uncalibrated, when `!shaking && |rate| < 3°/s`, gain 0.002 |
| Gravity low-pass `up` | 0.05 per sample, only when `calm` | none (uses the fixed `ref`) |
| Complementary blend | `0.04 * d` (that is k = 0.96) | `k = shaking ? 1 : 0.96` |
| Shaking gate | `|g−1| > 0.22` or gravity nearly along the axis (`len(reject(acc, axis)) < 0.35`) | same |
| Blend unwrap | `atan2(sin d, cos d)` | same |
| Angle wrap | `tilt` wrapped to ±180° | `angle` wrapped to ±180° |
| Soft clamp | yaw clamped at 1.5× the full-aim angle ("like a mouse at the screen edge": turning further moves the centre along) | none, the accel pulls it back |

### `_updateSteer()` (the same in all three games)

```js
const range = (s.cal && s.cal.range) || DEFAULT_RANGE;   // 35° default
const gain = 0.5 + s.sensitivity;                         // sensitivity 0..1 -> gain 0.5..1.5
let x = clamp((this.angle / range) * gain, -1, 1);
const dz = s.deadzone * 0.3;
x = ax <= dz ? 0 : Math.sign(x) * Math.pow((ax - dz) / (1 - dz), 1.15);
if (s.invert) x = -x;
this.steer = -x;                                          // game: + = left
```

The default deadzone is 0.25 in Kart and 0.15 in Fishing and Snowball
(`defaultMotionSettings()`). Kart also has `menuTilt`, which tilts through menus.

## 4. Calibration design

UI (`ui.js`): READY? → `captureCentre()` → `captureRight()`. There is also a
`RESET TO DEFAULT` button (`resetCalibration()`) and a `RE-CENTRE` button
(`recentre()`). The result goes to `settings.motion.cal`, which `app.saveSettings()`
stores in **this browser's localStorage**. Every browser needs its own calibration.

| Step | Fishing | Kart / Snowball |
|------|---------|-----------------|
| Centre (`need: 45` samples) | mean acc → `ref`, mean gyro → `bias`. Restarts and emits `'cal-move'` if the acc spread is > 0.12 g | same |
| Right | **integrates the gyro**: `c.rot += (gyro − bias) · 0.016 · DEG`. Done when `|rot| ≥ 15°` and the last 20 samples are under 8°/s | waits for the **accelerometer** angle to reach 15° with a spread ≤ 0.06 |
| Mode detection | `spin = norm(rot)`, `vert = dot(spin, ref)`. If `|vert| > 0.7`, mode is `'yaw'` with `sign = Math.sign(vert)`. Otherwise mode is `'tilt'`, with the axis from the accel (`cross(accM, ref)`) when it moved more than 8°, else `reject(spin, ref)` | the axis is always `cross(accM, ref)` |
| Range | `clamp(turned * 0.85, 12°, 80°)`, so a full turn of 0.85 × the calibration gives full lock | same |
| Stored | `{mode, ref, sign \| axis, bias, range, at}` | `{ref, axis, bias, range, at}` |
| After saving | sets `bias`, `up`, and `yaw` or `tilt` to the current (full right) pose | sets `angle` |

- **Old calibrations keep working.** A Kart-style `cal` has no `mode`. Because
  `cal.mode === 'yaw'` is false, it runs as tilt about `cal.axis`. If you add a field,
  give it a default when it is missing. Never require it.
- Once calibrated, only one path runs: yaw mode ignores tilt (`axis = null`) and tilt mode
  ignores yaw. That stops double counting.
- `recentre()` keeps the axis, sets `cal.ref` (or `autoRef`) to the current
  `norm(this.acc)` and zeroes `angle`, `yaw` and `tilt`. It does not re-estimate the
  bias.
- `resetCalibration()` clears `cal`, `autoN`, `bias` and `up`. The next 30 samples
  become the new auto centre.

## 5. Pitfalls checklist

1. **A filter that cannot see yaw.** The Kart filter was reused for the rod. Yaw does not
   move gravity, so `accAngle` stayed about 0 and the 0.04 blend pulled the aim back to
   centre a moment after every turn. The Kart calibration also waited for the
   accelerometer to change, so it never finished on a pure yaw. Fixed in `3830a9b`: yaw
   from the gyro about `up`, and calibration integrates the gyro.
2. **Angle past ±180° after a vigorous gesture.** During shaking only the gyro
   integrates. A full roll while reeling carried `tilt` past 180°. The wrapped blend `d`
   then settled on the copy 360° away, and the aim was pinned (HUD `AIM LEFT 372°` with
   `GYRO 0°/s`). Fixed by wrapping the filtered angle with `atan2(sin, cos)`
   (`tilt` in Fishing, `angle` in Kart and Snowball).
3. **Double counting.** If the uncalibrated tilt axis is not horizontal, a yaw also shows
   up as tilt. `_autoAxis()` uses `reject(guess, ref)`, and it returns `null` when the
   guess is nearly vertical (`len(h) <= 0.5`).
4. **Wrong axis guess.** The uncalibrated Kart and Snowball axis is a fixed board axis
   (`z` or `y`). A different mounting steers on the wrong axis, or backwards, until the
   player calibrates. Check the sign with `invert`, or calibrate.
5. **Gestures disturb the aim.** Fast flicks add gyro on all axes. Only the part on the
   aim axis counts (aim_check "cast flick at 4 s" stays at about 0.35). Pick an aim axis
   different from your gesture axes. The shaking gate keeps the accelerometer out while
   the device moves.
6. **Drift and bias.** The yaw has no absolute reference. It relies on the start-up bias
   plus tracking while still. Fishing's `still` is `len(w) < 3` deg/s. In aim_check, a
   steady 2°/s yaw for 10 s gives an aim of 0.00 because the bias absorbs it. When the
   rod stops, the aim drifts the other way (about -0.08 after 4 s). A real player rarely
   turns that slowly, but do not lower the gain or raise the threshold without testing
   this. Kart stops tracking the bias after calibration.
7. **Start-up pose.** Uncalibrated, the first 0.5 s defines the centre and the bias. If
   the device moves then, both are wrong until `resetCalibration()` or a reload.
8. **Hard-coded dt in calibration.** `_captureStep()` integrates with `0.016` s and does
   not use `m.i`. If a model changes the sample interval, the yaw range is scaled by
   16 / interval.
9. **Calibration is per browser.** It lives in localStorage, so a second laptop is
   uncalibrated.
10. **The input looks dead but the HUD moves.** Only the owning tab drives the game:
    `get active()` needs `owned || owner == null`, and `poll()` returns `null`
    otherwise. The Motion Lab tab or another screen may own the device. The HUD says
    `ROD IN THE MOTION LAB` or `ROD ON ANOTHER SCREEN`. Call
    `takeRod()`/`takeWheel()`/`takeController()`, or focus the tab (`_autoClaim()`). Also
    check `online` (heartbeat with `movement`) and `settings.enabled !== 'off'`.
11. **The aim_check stub bypasses the constructor.** `controller()` in
    `devtools/aim_check.mjs` uses `Object.create(MotionController.prototype)` and lists
    the state fields itself. A new field you add to the constructor must be added there
    too, or it is `undefined` in tests.

## 6. Testing

Details and a template are in [references/testing.md](references/testing.md).

- **`node devtools/aim_check.mjs`** drives the real Fishing `_sample` / `_updateSteer` /
  `_captureStep` with synthetic IMU data. It prints `-steer` (+ = right) once per second.
  - `rot(v, k, a)`: Rodrigues rotation.
  - `run(name, up, axis, profile, opts)`: `up` is gravity at rest in the board frame,
    `axis` is the board axis of a right turn, `profile(t)` is the turn angle in rad.
    `opts` are `bias` (constant or `t => [...]`), `secs`, `cal`, `m`, `every`, and
    `flick: {at, axis}`.
  - `calibrated(name, up, axis)`: runs the centre + 30° right calibration, then a turn
    sequence.

  Expected output: about 0.83 while holding 30°, 0.00 at centre, 1.00 after calibration,
  and the last line ends with `angle=0°`.
- **Sim board** (`ARDUKART_SIM_BOARD=1`, used by `devtools/run_*.sh`;
  `/api/debug/sim?tilt=..` also needs the game's `*_DEBUG=1`). It only produces a
  **Kart-style roll about z** (`acc = [sin, cos, 0]`, rate on gz). It cannot show yaw
  bugs or wrap bugs. Use aim_check for those.
- **Real board, browser console.** The globals are `window.ardukart`,
  `window.ardufish` and `window.ardusnow`, and each has `.motion`:
  ```js
  const m = ardufish.motion;
  m.on((w) => { if (w === 'imu') console.log((m.yaw*57.3).toFixed(1), (m.tilt*57.3).toFixed(1), m.steer.toFixed(2), m.bias.map(v=>v.toFixed(2))); });
  m.settings.cal; m.imuRate; m.owned; m.active; m.up;
  ```
  `on()` returns an unsubscribe function. Kart and Snowball have `angle` and `rawAngle`
  (the accelerometer-only angle), but no `yaw` or `tilt`.
