// Feeds synthetic Modulino Movement data through MotionController's aim filter
// and prints the aim over time, for the ways a rod can be held and turned.
//   node aim_check.mjs
import { MotionController, defaultMotionSettings } from '../ardu-fishing/assets/js/motion.js';

const DEG = Math.PI / 180, DT = 0.016;
// rotate v about unit axis k by angle a (Rodrigues)
function rot(v, k, a) {
  const c = Math.cos(a), s = Math.sin(a), d = v[0] * k[0] + v[1] * k[1] + v[2] * k[2];
  const x = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
  return [0, 1, 2].map((i) => v[i] * c + x[i] * s + k[i] * d * (1 - c));
}
const noise = (s) => (Math.random() - 0.5) * 2 * s;

function controller(cal) {
  const m = Object.create(MotionController.prototype);
  Object.assign(m, {
    app: { saveSettings() {} }, settings: { ...defaultMotionSettings(), cal: cal || null },
    angle: 0, yaw: 0, tilt: 0, up: null, rawAngle: 0, steer: 0, acc: [0, 1, 0], gyro: [0, 0, 0], bias: [0, 0, 0], samples: 0,
    autoRef: null, autoAcc: [0, 0, 0], autoN: 0, turnRate: 0, capture: null, listeners: new Set(),
  });
  return m;
}

// up: gravity direction in the board frame at rest (what the accelerometer reads)
// axis: board axis the user turns about; profile(t) = turn to the right in radians
function run(name, up, axis, profile, { bias = [0.8, -0.5, 1.2], secs = 12, cal, m = controller(cal), every = 62, flick } = {}) {
  let prev = profile(0);
  const out = [];
  for (let i = 0; i < secs / DT; i++) {
    const t = i * DT, a = profile(t), rate = (a - prev) / DT / DEG; prev = a;
    // turning the board by +a about `axis` rotates gravity by -a in the board frame
    const g = rot(up, axis, -a);
    const b = typeof bias === 'function' ? bias(t) : bias;
    const s = [...g.map((v) => v + noise(0.01)), ...axis.map((v, j) => v * rate + b[j] + noise(0.4))];
    // a cast: a fast pitch up and forward about the horizontal axis `flick.axis`
    if (flick && t > flick.at && t < flick.at + 0.4) {
      const ph = (t - flick.at) / 0.4, w = Math.sin(ph * 2 * Math.PI) * 400;
      flick.axis.forEach((v, j) => { s[3 + j] += v * w; s[j] += v * 1.5 * Math.sin(ph * Math.PI); });
    }
    m._sample(s, DT);
    m._updateSteer();
    if (m.capture) m._captureStep();
    if (i % every === 0) out.push((-m.steer).toFixed(2));
  }
  if (name) console.log(name.padEnd(34), out.join(' '));
  return m;
}

// turn right 30° over 1 s at t=1, hold, then back to centre at t=7, right again at t=9
const turn = (t) => (t < 1 ? 0 : t < 2 ? (t - 1) * 30 * DEG : t < 7 ? 30 * DEG : t < 8 ? (8 - t) * 30 * DEG : t < 9 ? 0 : t < 10 ? (t - 9) * 20 * DEG : 20 * DEG);
console.log('aim (+ = right), one value per second; the rod turns right at 1 s, holds, centres at 8 s, 2/3 right at 10 s');
// "right" about an axis: yaw about the vertical is a clockwise turn seen from above = -up
run('upright rod, yaw (turn left/right)', [0, 1, 0], [0, -1, 0], turn);
run('board flat on rod, yaw', [0, 0, 1], [0, 0, -1], turn);
run('board on side of rod, yaw', [1, 0, 0], [-1, 0, 0], turn);
run('rod tilted 40° up, yaw', [0, Math.cos(40 * DEG), Math.sin(40 * DEG)], [0, -Math.cos(40 * DEG), -Math.sin(40 * DEG)], turn);
run('kart wheel roll (about z)', [0, 1, 0], [0, 0, -1], turn);

// calibrate: still for 1 s, turn right 30°, hold, then play the same turns
function calibrated(name, up, axis) {
  const m = controller();
  m.startCalibration();
  m.captureCentre();
  run('', up, axis, () => 0, { secs: 1.5, m, every: 1e9 });
  m.captureRight();
  run('', up, axis, (t) => (t < 1 ? t * 30 * DEG : 30 * DEG), { secs: 2.5, m, every: 1e9 });
  const c = m.settings.cal;
  console.log(`calibrated ${name}: mode=${c && c.mode} range=${c && Math.round(c.range / DEG)}°`);
  run('  then the same turns', up, axis, (t) => (t < 1 ? 30 * DEG : t < 2 ? (2 - t) * 30 * DEG : t < 5 ? 0 : t < 6 ? (t - 5) * 30 * DEG : 30 * DEG), { secs: 8, m });
}
calibrated('upright rod, yaw', [0, 1, 0], [0, -1, 0]);
calibrated('upright rod, yaw the other way round', [0, 1, 0], [0, 1, 0]);
calibrated('kart wheel roll', [0, 1, 0], [0, 0, -1]);

// a whole match, rod held still at the centre, gyro bias drifting by 2°/s
run('3 min still, drifting bias (every 15 s)', [0, 1, 0], [0, -1, 0], () => 0,
  { secs: 180, every: 937, bias: (t) => [0.8 + t / 90, -0.5, 1.2 + t / 90] });
// casting at 4 s must not move the aim much
run('cast flick at 4 s (pitch)', [0, 1, 0], [0, -1, 0], (t) => (t < 1 ? 0 : t < 2 ? (t - 1) * 15 * DEG : 15 * DEG), { secs: 8, flick: { at: 4, axis: [1, 0, 0] } });
