# Filter recipes: excerpts from the real code

The excerpts are taken from `ardu-fishing/assets/js/motion.js` unless a section says
otherwise. Kart and Snowball share one filter. Their files differ only in names and
gesture code.

## Vector helpers and `angleAbout`

```js
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const reject = (v, axis) => sub(v, scale(axis, dot(v, axis)));   // component perpendicular to axis

// Signed board rotation about `axis` that takes gravity from `ref` to `g`.
// Gravity rotates the opposite way in the board frame, hence the minus.
function angleAbout(ref, g, axis) {
  const r = norm(reject(ref, axis)), p = norm(reject(g, axis));
  return -Math.atan2(dot(axis, cross(r, p)), dot(r, p));
}
```

`angleAbout` is only well conditioned when gravity has a large component perpendicular
to `axis`. That is why the shaking gate also checks `len(reject(acc, axis)) < 0.35`.

## Kart / Snowball: one-axis complementary filter

```js
const rate = dot(sub(gyro, bias), axis) * DEG;     // rad/s about the axis, + = right
const accAngle = angleAbout(ref, acc, axis);
const shaking = Math.abs(g - 1) > 0.22 || len(reject(acc, axis)) < 0.35;
const k = shaking ? 1 : 0.96;
let a = this.angle + rate * dt;
if (!shaking) {
  let d = accAngle - a;
  d = Math.atan2(Math.sin(d), Math.cos(d));         // unwrap so the blend never crosses ±180°
  a = a + (1 - k) * d;
}
this.angle = Math.atan2(Math.sin(a), Math.cos(a)); // keep it within ±180° (pitfall 2)
if (!cal && !shaking && Math.abs(rate) < 3 * DEG) this.bias = this.bias.map((v, i) => v + (gyro[i] - v) * 0.002);
```

This filter is right for a wheel or a tilt, because gravity moves when you roll the
board. It is wrong for yaw.

## Fishing: start-up centre and bias

```js
if (!cal && this.autoN < 30) {
  this.autoAcc = this.autoAcc.map((v, i) => v + acc[i]);
  this.bias = this.bias.map((v, i) => v + gyro[i] / 30);
  if (++this.autoN === 30) { this.autoRef = norm(this.autoAcc); this.up = this.autoRef; }
  return;
}
```

## Fishing: yaw about gravity (gyro only) with a soft clamp

```js
if (calm) this.up = norm(this.up.map((v, i) => v + (acc[i] / g - v) * 0.05));
let yawRate = 0;
if (!cal || cal.mode === 'yaw') {
  yawRate = (cal ? cal.sign : -1) * dot(w, this.up) * DEG;
  const s2 = this.settings, lim = ((cal && cal.range) || DEFAULT_RANGE) / (0.5 + s2.sensitivity) * 1.5;
  this.yaw = clamp(this.yaw + yawRate * dt, -lim, lim);
}
```

Projecting onto `up`, not onto a fixed board axis, makes yaw work in any mounting. The
aim_check cases include an upright board, a flat board, a board on its side and a rod
tilted 40° up. `up` is only updated while `calm`, so a cast does not swing it.

## Fishing: tilt about a horizontal axis

```js
const axis = cal ? (cal.mode === 'yaw' ? null : cal.axis) : this._autoAxis();
if (axis) {
  tiltRate = dot(w, axis) * DEG;
  const accAngle = angleAbout(ref, acc, axis);
  const shaking = Math.abs(g - 1) > 0.22 || len(reject(acc, axis)) < 0.35;
  let a = this.tilt + tiltRate * dt;
  if (!shaking) { let d = accAngle - a; d = Math.atan2(Math.sin(d), Math.cos(d)); a = a + 0.04 * d; }
  this.tilt = Math.atan2(Math.sin(a), Math.cos(a));   // keep it within ±180°
}
this.turnRate = yawRate + tiltRate;
this.angle = this.yaw + this.tilt;
```

```js
// uncalibrated roll axis: the board normal for an upright board, y for a flat one,
// made horizontal so it never double counts the yaw
_autoAxis() {
  const guess = Math.abs(ref[2]) < 0.75 ? [0, 0, -1] : [0, -1, 0];
  const h = reject(guess, ref);
  this._axis = len(h) > 0.5 ? norm(h) : null;        // cached per autoRef
}
```

## Fishing: calibration, the "right" step

```js
for (; c.n < c.buf.length; c.n++) {
  const s = c.buf[c.n];
  c.rot = c.rot.map((v, i) => v + (s[3 + i] - centre.bias[i]) * 0.016 * DEG);   // fixed dt!
}
const turned = len(c.rot);
const moving = Math.max(...last.map((s) => len(sub([s[3], s[4], s[5]], centre.bias))));
if (turned < 15 * DEG || moving > 8) return;
const spin = norm(c.rot);                 // positive rotation about it = right turn
const vert = dot(spin, centre.ref);
const range = clamp(turned * 0.85, 12 * DEG, 80 * DEG);
if (Math.abs(vert) > 0.7) cal = { mode: 'yaw', ref: centre.ref, sign: Math.sign(vert), bias: centre.bias, range, at: Date.now() };
else {
  const seen = len(cross(accM, centre.ref)) > Math.sin(8 * DEG);
  const axis = seen ? norm(cross(accM, centre.ref)) : norm(reject(spin, centre.ref));
  cal = { mode: 'tilt', ref: centre.ref, axis, bias: centre.bias, range, at: Date.now() };
}
```

Summing a rotation vector is a small-angle approximation. It is fine for a turn about a
single axis of up to about 80°. It is not fine for tumbling motions.

## Adapting this to a new game

1. Start from the Fishing `_sample` / `_autoAxis` / `_captureStep`.
2. Keep `angle` + = right and `steer = -x` + = left, so that `input.js` and the HUD keep
   working.
3. Wrap every angle that the accelerometer corrects. Clamp every angle that the
   accelerometer cannot see.
4. Add the scenario to `devtools/aim_check.mjs`. Point the import at your game's
   `motion.js` if it is not Fishing.
