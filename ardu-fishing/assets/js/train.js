// Ardu Fishing Motion Lab: record Modulino Movement gestures, send them to Edge
// Impulse, train the model, deploy it (App Lab Motion detection brick, or an
// Arduino library built into the sketch), then test the live classifier. All
// Edge Impulse calls go through the board
// (python/controller.py), so the browser never needs CORS access to Studio.
import { Net } from './net.js';
import { el, $, clamp } from './util.js';
import { DEFAULT_LABELS, defaultAction, ACTION_LABEL } from './motion.js';

// same Edge Impulse key as the Ardu Kart Motion Lab: one project key per workshop
const KEY_STORE = 'ardukart.ei.key';
const SETTINGS_KEY = 'ardufish.settings';
const CHART_SECONDS = 5;
const AXES = ['x', 'y', 'z'];
const ACC_COL = ['#ff5a6e', '#46f08b', '#5aa8ff'];
const GYR_COL = ['#ffb13d', '#c6ff4a', '#38e6ff'];
const IDLE_RE = /idle|noise|none|rest|still|background|unknown/i;

const net = new Net();
const state = {
  key: '',
  project: null,       // ei_project response
  hw: null, online: false, installed: null, restartNeeded: false, job: null, owner: undefined,
  engine: null,        // {pref, active, labels, name, brick}
  buf: [],             // [[ax..gz]] for the live chart
  interval: 16,
  frozen: false,
  recording: null,     // {label, ms, started, timer}
  pending: null,       // recorded sample awaiting review
  samples: [],         // uploaded this session
  labels: [],          // model labels
  probs: [], mlAt: 0,
  history: [],
  imuN: 0, imuT: 0,
};

// ------------------------------------------------------------------ helpers
function toast(text, cls = '') {
  const t = el('div', { class: 'toast-row ' + cls }, text);
  $('#toast').append(t);
  setTimeout(() => t.classList.add('out'), 3200);
  setTimeout(() => t.remove(), 3800);
}

function gameSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; }
}
function threshold() { const m = gameSettings().motion; return m && m.threshold ? m.threshold : 0.7; }
function setThreshold(v) {
  const s = gameSettings();
  s.motion = { ...(s.motion || {}), threshold: v };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* private mode */ }
}
function actionFor(label) {
  const m = gameSettings().motion;
  return (m && m.map && m.map[label]) || defaultAction(label);
}

const fmtMs = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : `${Math.round(ms / 1000)}s`);

let audioCtx = null;
function beep(freq = 880, dur = 0.09, vol = 0.15) {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = freq; o.type = 'square';
    g.gain.setValueAtTime(vol, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + dur);
  } catch { /* no audio */ }
}

// Edge Impulse data acquisition format (acceleration in m/s², like the board uploads)
function acquisitionJson(sample) {
  const G = 9.80665;
  return {
    protected: { ver: 'v1', alg: 'none', iat: Math.floor(Date.now() / 1000) },
    signature: '0'.repeat(64),
    payload: {
      device_name: 'uno-q-rod', device_type: 'ARDUINO_UNO_Q', interval_ms: sample.interval,
      sensors: [['accX', 'm/s2'], ['accY', 'm/s2'], ['accZ', 'm/s2'], ['gyrX', 'dps'], ['gyrY', 'dps'], ['gyrZ', 'dps']].map(([name, units]) => ({ name, units })),
      values: sample.values.map((r) => [r[0] * G, r[1] * G, r[2] * G, r[3], r[4], r[5]].map((v) => +v.toFixed(4))),
    },
  };
}

// ------------------------------------------------------------------ charts
function drawSeries(canvas, rows, offset, colors, fixedRange) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  let range = fixedRange;
  for (const r of rows) for (let i = 0; i < 3; i++) range = Math.max(range, Math.abs(r[offset + i]) * 1.1);
  // grid
  g.strokeStyle = 'rgba(255,255,255,0.07)'; g.lineWidth = 1;
  g.beginPath();
  for (let i = 1; i < 4; i++) { const y = (h * i) / 4; g.moveTo(0, y); g.lineTo(w, y); }
  g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.35)'; g.font = '11px system-ui';
  g.fillText('+' + (range >= 10 ? Math.round(range) : range.toFixed(1)), 4, 12);
  g.fillText('−' + (range >= 10 ? Math.round(range) : range.toFixed(1)), 4, h - 4);
  if (rows.length < 2) return;
  const n = rows.length;
  for (let a = 0; a < 3; a++) {
    g.strokeStyle = colors[a]; g.lineWidth = 1.6;
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      const y = h / 2 - (rows[i][offset + a] / range) * (h / 2 - 2);
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.stroke();
  }
}

function legend(id, row, offset, colors, unit, digits) {
  const box = $(id);
  if (!box) return;
  box.innerHTML = '';
  AXES.forEach((ax, i) => box.append(el('span', { style: { color: colors[i] } }, `${ax} ${row ? row[offset + i].toFixed(digits) : '–'}${unit}`)));
}

let chartDirty = false;
function renderCharts() {
  requestAnimationFrame(renderCharts);
  if (!chartDirty || state.frozen) return;
  chartDirty = false;
  const rows = state.buf;
  drawSeries($('#chart-acc'), rows, 0, ACC_COL, 1.2);
  drawSeries($('#chart-gyr'), rows, 3, GYR_COL, 60);
  const last = rows[rows.length - 1];
  legend('#leg-acc', last, 0, ACC_COL, '', 2);
  legend('#leg-gyr', last, 3, GYR_COL, '', 0);
}

// ------------------------------------------------------------------ board status
function renderBoard() {
  const box = $('#board-chips');
  box.innerHTML = '';
  const chip = (on, t) => el('span', { class: 'chip ' + (on ? 'on' : 'off') }, (on ? '● ' : '○ ') + t);
  if (!net.connected) { box.append(chip(false, 'Not connected to the UNO Q')); return; }
  const hw = state.hw;
  if (!state.online || !hw) {
    box.append(chip(false, 'Board not responding'));
  } else {
    box.append(chip(hw.movement, 'Movement'), chip(hw.buttons, 'Buttons'), chip(hw.pixels, 'Pixels'),
      chip(!!engineActive(), engineActive() ? `${engineActive() === 'brick' ? 'Brick' : 'MCU'} model: ${state.engine.name || 'Edge Impulse'}` : 'No gesture model'));
    if (hw.sim) box.append(el('span', { class: 'chip sim' }, 'SIMULATED BOARD'));
  }
  const nb = $('#no-board');
  if (!state.online || !hw || !hw.movement) {
    nb.classList.remove('hidden');
    nb.textContent = !net.connected ? 'Connecting to the UNO Q…'
      : !state.online ? 'The MCU is not sending data yet. Is the Ardu Fishing app running on the board?'
        : 'No Modulino Movement found. Plug it into the Qwiic connector; it is picked up automatically.';
  } else nb.classList.add('hidden');
  renderModelState();
}

function onStatus(st) {
  if (!st) return;
  state.hw = st.hw || state.hw;
  state.online = !!st.online;
  state.installed = st.installed;
  state.restartNeeded = !!st.restartNeeded;
  if ('owner' in st) state.owner = st.owner;
  if (st.hw && st.hw.interval) state.interval = st.hw.interval;
  if (st.engine) state.engine = st.engine;
  const labels = state.engine ? state.engine.labels : st.hw && st.hw.labels;
  if (labels && labels.length) state.labels = labels;
  if (st.job && !jobRunning) setJobUi(true, st.job.stage);
  renderBoard();
  renderLabelChips();
}

const engineActive = () => (state.engine ? state.engine.active : state.hw && state.hw.model ? 'mcu' : null);

function renderEngine() {
  const eng = state.engine || {};
  for (const b of document.querySelectorAll('#engine-pick [data-e]')) b.classList.toggle('sel', b.dataset.e === (eng.pref || 'auto'));
  $('#dep-brick').classList.toggle('active', eng.active === 'brick');
  $('#dep-mcu').classList.toggle('active', eng.active === 'mcu');
  $('#engine-where').textContent = eng.active === 'brick' ? 'the Motion detection brick on the Linux side'
    : eng.active === 'mcu' ? 'the model running on the STM32 MCU' : 'none running yet';
  if (state.project) $('#studio-deploy').href = `https://studio.edgeimpulse.com/studio/${state.project.project.id}/deployment`;
}

function renderModelState() {
  const box = $('#model-state');
  box.innerHTML = '';
  renderEngine();
  const hw = state.hw, inst = state.installed, eng = state.engine || {}, b = eng.brick || {};
  const running = hw && hw.model ? `${hw.name || 'model'}${hw.deploy ? ' · deploy v' + hw.deploy : ''}` : 'no model';
  const brick = b.state === 'ready' ? `${b.name} · ${b.labels.join(', ')} · ${b.axes} axes, ${b.windowMs} ms window`
    : b.state === 'error' ? b.error : b.state === 'starting' ? 'starting…' : 'not available (add arduino:motion_detection to app.yaml)';
  const used = eng.active === 'brick' ? 'Motion detection brick' : eng.active === 'mcu' ? 'model on the MCU'
    : 'none: use the Modulino buttons A / B / C to cast, reel and unhook';
  box.append(
    el('div', {}, el('b', {}, 'Game uses: '), used),
    el('div', {}, el('b', {}, 'Motion detection brick: '), brick),
    el('div', {}, el('b', {}, 'Running on the MCU: '), running),
    el('div', {}, el('b', {}, 'Installed in the sketch: '), inst ? inst.name : 'none'));
  if (state.restartNeeded) {
    box.append(el('div', { class: 'restart' },
      el('b', {}, 'Restart the app to flash the new model. '),
      'In Arduino App Lab press Stop, then Run. Or over SSH:',
      el('code', {}, 'arduino-app-cli app stop user:ardu-fishing && arduino-app-cli app start user:ardu-fishing'),
      'The sketch is recompiled with the model, which takes 1–3 minutes.'));
  }
}

// ------------------------------------------------------------------ Edge Impulse project
async function connectEI(e) {
  e?.preventDefault();
  const key = $('#api-key').value.trim();
  if (!/^ei_[A-Za-z0-9]{16,}$/.test(key)) { toast('Paste the project API key (it starts with ei_)', 'warn'); return; }
  const btn = $('#connect');
  btn.disabled = true; btn.textContent = 'Connecting…';
  const r = await net.request('ei_project', { apiKey: key }, 40000);
  btn.disabled = false; btn.textContent = 'Connect';
  if (!r) { toast('No answer from the board', 'warn'); return; }
  if (!r.ok) { toast(r.error, 'warn'); return; }
  state.key = key;
  state.project = r;
  try { if ($('#remember').checked) localStorage.setItem(KEY_STORE, key); else localStorage.removeItem(KEY_STORE); } catch { /* ignore */ }
  renderProject();
  toast(`Connected to ${r.project.name}`);
}

async function refreshProject() {
  if (!state.key) return;
  const r = await net.request('ei_project', { apiKey: state.key }, 40000);
  if (r && r.ok) { state.project = r; renderProject(); }
}

function renderProject() {
  renderEngine();
  const r = state.project;
  const box = $('#project');
  box.innerHTML = '';
  if (!r) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const link = $('#studio-link');
  link.href = r.studio; link.classList.remove('hidden');
  const tr = r.summary.training, te = r.summary.testing;
  box.append(
    el('div', { class: 'proj-name' }, r.project.name, el('span', { class: 'muted' }, ` · #${r.project.id}${r.project.owner ? ' · ' + r.project.owner : ''}`)),
    el('div', { class: 'proj-stats' },
      el('div', {}, el('b', {}, tr.count), ' training samples', el('span', { class: 'muted' }, ` (${fmtMs(tr.ms)})`)),
      el('div', {}, el('b', {}, te.count), ' testing samples', el('span', { class: 'muted' }, ` (${fmtMs(te.ms)})`))),
    el('div', { class: 'chips small' }, r.labels.length ? r.labels.map((l) => el('span', { class: 'chip' }, l)) : el('span', { class: 'muted' }, 'No data yet: record your first gesture below.')));
  renderImpulse();
  renderLabelChips();
}

function renderImpulse() {
  const box = $('#impulse');
  const r = state.project;
  box.innerHTML = '';
  if (!r) { box.append('Connect your Edge Impulse project first.'); return; }
  const imp = r.impulse;
  if (!imp) {
    box.append(el('div', { class: 'warn-box' },
      el('b', {}, 'No impulse yet. '), 'In Studio, open ', el('a', { href: `${r.studio}/create-impulse`, target: '_blank', rel: 'noopener' }, 'Create impulse ↗'),
      ' and add: Time series data (window 1000 ms, increase 250 ms, 62.5 Hz) → Spectral Analysis → Classification. Save, generate features once, then come back and press Train.'));
    return;
  }
  const hz = imp.hz ? `${Math.round(imp.hz * 10) / 10} Hz` : '';
  box.append(el('div', {}, el('b', {}, 'Impulse: '), `${imp.windowMs} ms window, ${imp.strideMs} ms stride${hz ? ', ' + hz : ''} · `, (imp.dsp || []).join(' + '), ' → ', (imp.learn || []).join(' + ')));
  const boardHz = 1000 / (state.interval || 16);
  if (imp.hz && Math.abs(imp.hz - boardHz) > 2) box.append(el('div', { class: 'warn-box' }, `The board samples at ${boardHz.toFixed(1)} Hz but the impulse expects ${imp.hz} Hz. Once the model is installed the sketch uses the model's rate. Record again after the restart.`));
}

// ------------------------------------------------------------------ recording
function renderLabelChips() {
  const box = $('#label-chips');
  const set = new Set([...DEFAULT_LABELS, ...(state.project ? state.project.labels : []), ...state.labels]);
  const counts = {};
  for (const s of state.samples) counts[s.label] = (counts[s.label] || 0) + 1;
  const cur = $('#label').value.trim();
  box.innerHTML = '';
  for (const l of set) {
    const act = actionFor(l);
    box.append(el('button', {
      class: 'chip pick' + (l === cur ? ' sel' : ''), type: 'button', title: act !== 'none' ? `In the game: ${ACTION_LABEL[act]}` : 'Not mapped to a fishing action',
      onclick: () => { $('#label').value = l; renderLabelChips(); },
    }, l, counts[l] ? el('small', {}, ' ×' + counts[l]) : null));
  }
}

function setRecStatus(text, progress = null, cls = '') {
  const box = $('#rec-status');
  box.classList.toggle('hidden', !text);
  box.className = 'rec-status ' + cls + (text ? '' : ' hidden');
  box.querySelector('.rec-big').textContent = text || '';
  box.querySelector('.rec-bar i').style.width = progress == null ? '0%' : clamp(progress, 0, 1) * 100 + '%';
}

async function startRecording() {
  if (state.recording) return;
  const label = $('#label').value.trim();
  if (!/^[A-Za-z0-9_\-. ]{1,64}$/.test(label)) { toast('Labels may use letters, digits, space, _ - . (max 64)', 'warn'); return; }
  if (!state.online || !state.hw || !state.hw.movement) { toast('No Modulino Movement connected', 'warn'); return; }
  const ms = +$('#length').value;
  state.recording = { label, ms, phase: 'countdown' };
  $('#record').disabled = true;
  $('#review').classList.add('hidden');
  // countdown so you can get your hands on the rod
  const cd = $('#countdown');
  cd.classList.remove('hidden');
  for (const n of [3, 2, 1]) {
    cd.textContent = n;
    cd.dataset.label = label;
    cd.classList.remove('pop'); void cd.offsetWidth; cd.classList.add('pop');
    beep(660, 0.08);
    await new Promise((r) => setTimeout(r, 700));
    if (!state.recording) { cd.classList.add('hidden'); return; }
  }
  cd.classList.add('hidden');
  beep(1320, 0.18);
  const r = await net.request('motion_record', { label, ms }, 4000);
  if (!r || !r.ok) {
    state.recording = null; $('#record').disabled = false;
    setRecStatus('');
    toast(r ? r.error : 'No answer from the board', 'warn');
    return;
  }
  const t0 = performance.now();
  state.recording.phase = 'recording';
  state.recording.expected = r.samples;
  const tick = () => {
    if (!state.recording || state.recording.phase !== 'recording') return;
    const p = (performance.now() - t0) / ms;
    setRecStatus(`● REC  ${label}  ${Math.max(0, (ms - (performance.now() - t0)) / 1000).toFixed(1)} s`, p, 'live');
    if (p > 1 + 4000 / ms) { failRecording('The recording did not complete. Is the board still sending data?'); return; }
    requestAnimationFrame(tick);
  };
  tick();
}

function failRecording(msg) {
  net.send('motion_record_cancel', {});
  state.recording = null;
  $('#record').disabled = false;
  setRecStatus('');
  toast(msg, 'warn');
}

function onRecordDone(m) {
  if (!state.recording) return;
  state.recording = null;
  $('#record').disabled = false;
  beep(990, 0.12);
  const sample = { label: m.label, interval: m.interval, values: m.values, durationMs: m.durationMs };
  if ($('#after').value === 'upload' && state.key) { setRecStatus(''); upload(sample); return; }
  if ($('#after').value === 'upload' && !state.key) toast('Connect your Edge Impulse project to upload. Review the sample below.', 'warn');
  setRecStatus('');
  state.pending = sample;
  const rv = $('#review');
  rv.classList.remove('hidden');
  $('#review-info').textContent = `${sample.label} · ${(sample.durationMs / 1000).toFixed(1)} s · ${sample.values.length} readings`;
  requestAnimationFrame(() => {
    const c = $('#chart-sample');
    // accelerometer (solid) + gyro scaled into the same plot
    drawSeries(c, sample.values, 0, ACC_COL, 1.2);
  });
}

async function upload(sample) {
  if (!state.key) { toast('Connect your Edge Impulse project first', 'warn'); return; }
  let category = $('#category').value;
  if (category === 'split') category = Math.random() < 0.2 ? 'testing' : 'training';
  const item = { label: sample.label, category, durationMs: sample.durationMs, status: 'uploading', at: new Date() };
  state.samples.unshift(item);
  renderSamples();
  const r = await net.request('ei_upload', { apiKey: state.key, label: sample.label, category, interval: sample.interval, values: sample.values }, 40000);
  if (r && r.ok) {
    item.status = 'ok';
    toast(`Uploaded "${sample.label}" to ${category}`);
    clearTimeout(upload._t);
    upload._t = setTimeout(refreshProject, 1500);
  } else {
    item.status = 'error';
    item.error = r ? r.error : 'No answer from the board';
    item.sample = sample;   // allow a retry
    toast(item.error, 'warn');
  }
  renderSamples();
  renderLabelChips();
}

function renderSamples() {
  const ul = $('#samples');
  ul.innerHTML = '';
  $('#rec-count').textContent = state.samples.length ? `${state.samples.filter((s) => s.status === 'ok').length} uploaded this session` : '';
  for (const s of state.samples.slice(0, 8)) {
    ul.append(el('li', { class: s.status },
      el('span', { class: 'dot' }), el('b', {}, s.label), el('span', { class: 'muted' }, ` ${s.category} · ${(s.durationMs / 1000).toFixed(1)} s`),
      el('span', { class: 'grow' }),
      s.status === 'error' ? el('button', { class: 'ghost tiny', onclick: () => { state.samples.splice(state.samples.indexOf(s), 1); upload(s.sample); } }, 'Retry') : null,
      el('span', { class: 'st' }, s.status === 'ok' ? '✓' : s.status === 'error' ? s.error : '…')));
  }
}

function download(sample) {
  const blob = new Blob([JSON.stringify(acquisitionJson(sample))], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `${sample.label}.${Date.now()}.json` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ------------------------------------------------------------------ jobs
let jobRunning = false;
function setJobUi(running, stage) {
  jobRunning = running;
  for (const b of document.querySelectorAll('#train [data-kind]')) b.disabled = running;
  const order = ['training', 'trained', 'building', 'downloading', 'installing', 'done'];
  const idx = order.indexOf(stage);
  for (const li of document.querySelectorAll('#stages li')) {
    const i = order.indexOf(li.dataset.s);
    li.className = stage === 'error' ? (li.classList.contains('active') ? 'error' : li.className)
      : i < idx || stage === 'done' ? 'ok' : i === idx || (stage === 'trained' && li.dataset.s === 'building') ? 'active' : '';
  }
}

async function runJob(kind) {
  if (!state.key) { toast('Connect your Edge Impulse project first', 'warn'); return; }
  const log = $('#log');
  log.textContent = '';
  for (const li of document.querySelectorAll('#stages li')) li.className = '';
  if (kind === 'build') document.querySelector('#stages li[data-s="training"]').className = 'skip';
  setJobUi(true, kind === 'build' ? 'building' : 'training');
  const r = await net.request('ei_job', { apiKey: state.key, kind }, 10000);
  if (!r || !r.ok) { setJobUi(false, ''); toast(r ? r.error : 'No answer from the board', 'warn'); }
}

function onJobProgress(m) {
  const log = $('#log');
  if (m.line) {
    log.textContent += m.line + '\n';
    if (log.textContent.length > 60000) log.textContent = log.textContent.slice(-50000);
    log.scrollTop = log.scrollHeight;
  }
  if (m.stage === 'done') { setJobUi(false, 'done'); toast(m.installed ? `Installed ${m.installed.name}. Restart the app to flash it.` : 'Model trained. Deploy it: A · App Lab brick, or B · build for the MCU.'); refreshProject(); }
  else if (m.stage === 'error') {
    for (const li of document.querySelectorAll('#stages li.active')) li.className = 'error';
    setJobUi(false, 'error');
    toast(m.error || 'Job failed', 'warn');
  } else setJobUi(true, m.stage);
}

async function uploadZip(file) {
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) { toast('That zip is larger than 8 MB', 'warn'); return; }
  const data = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); });
  toast('Installing the library…');
  const r = await net.request('model_upload', { data }, 60000);
  if (r && r.ok) toast(`Installed ${r.installed.name}. Restart the app to flash it.`);
  else toast(r ? r.error : 'No answer from the board', 'warn');
  $('#zip').value = '';
}

// ------------------------------------------------------------------ live test
function renderTest() {
  const th = threshold();
  const labels = state.labels;
  const fresh = performance.now() - state.mlAt < 1500;
  const bars = $('#test-bars');
  if (bars.dataset.key !== labels.join('|')) {
    bars.dataset.key = labels.join('|');
    bars.innerHTML = '';
    for (const l of labels) {
      const act = actionFor(l);
      bars.append(el('div', { class: 'bar' }, el('span', {}, l, el('small', {}, act !== 'none' ? ' → ' + ACTION_LABEL[act].toLowerCase() : '')), el('div', {}, el('i'), el('u')), el('b', {}, '–')));
    }
  }
  let best = -1;
  state.probs.forEach((p, i) => { if (best < 0 || p > state.probs[best]) best = i; });
  [...bars.children].forEach((row, i) => {
    const p = fresh ? state.probs[i] || 0 : 0;
    row.querySelector('i').style.width = p * 100 + '%';
    row.querySelector('u').style.left = th * 100 + '%';
    row.querySelector('b').textContent = fresh ? Math.round(p * 100) + '%' : '–';
    row.classList.toggle('top', fresh && i === best && p >= th);
  });
  const top = $('#top-label');
  if (!labels.length) {
    top.textContent = state.hw && !engineActive() ? 'No gesture model running yet' : '–';
    top.className = 'top-label muted';
  } else if (!fresh) {
    top.textContent = 'waiting for the model…'; top.className = 'top-label muted';
  } else if (best >= 0 && state.probs[best] >= th) {
    top.textContent = labels[best]; top.className = 'top-label' + (IDLE_RE.test(labels[best]) ? ' idle' : ' hit');
  } else { top.textContent = 'uncertain'; top.className = 'top-label muted'; }
}

function onMl(m) {
  if (!m || !Array.isArray(m.p)) return;
  if (m.labels && m.labels.length) state.labels = m.labels;
  state.probs = m.p;
  state.mlAt = performance.now();
  $('#timing').textContent = `DSP ${m.dsp} ms · NN ${m.nn} ms · ${m.src === 'brick' ? 'Motion detection brick' : 'on the STM32U585'}`;
  // gesture history (rising edges of non-idle classes)
  const th = threshold();
  let best = 0;
  m.p.forEach((p, i) => { if (p > m.p[best]) best = i; });
  const label = state.labels[best];
  const last = state.history[0];
  if (label && m.p[best] >= th && !IDLE_RE.test(label) && (!last || last.label !== label || performance.now() - last.t > 1200)) {
    state.history.unshift({ label, p: m.p[best], t: performance.now() });
    state.history.length = Math.min(state.history.length, 14);
    const h = $('#history');
    h.innerHTML = '';
    for (const e of state.history) h.append(el('span', { class: 'chip' }, e.label, el('small', {}, ` ${Math.round(e.p * 100)}%`)));
  } else if (label && IDLE_RE.test(label) && last) last.t = 0;
  renderTest();
}

// ------------------------------------------------------------------ wiring
function onImu(m) {
  if (m.i) state.interval = m.i;
  const max = Math.round((CHART_SECONDS * 1000) / (m.i || 16));
  for (const s of m.s) state.buf.push(s);
  if (state.buf.length > max) state.buf.splice(0, state.buf.length - max);
  chartDirty = true;
  const t = performance.now();
  state.imuN += m.s.length;
  if (t - state.imuT > 1000) {
    $('#rate').textContent = `${(state.imuN * 1000 / (t - state.imuT)).toFixed(1)} Hz`;
    state.imuN = 0; state.imuT = t;
  }
  if (!state.online) { state.online = true; renderBoard(); }
}

function onButton(m) {
  // Modulino button A starts a recording from the rod itself
  if (m.p && m.i === 0 && state.owner === net.id && !state.recording) startRecording();
}

function init() {
  try { const k = localStorage.getItem(KEY_STORE); if (k) $('#api-key').value = k; } catch { /* ignore */ }
  $('#key-form').addEventListener('submit', connectEI);
  $('#record').addEventListener('click', () => { beep(0, 0.001, 0); startRecording(); });
  $('#label').addEventListener('input', renderLabelChips);
  $('#freeze').addEventListener('click', () => { state.frozen = !state.frozen; $('#freeze').textContent = state.frozen ? 'Resume chart' : 'Pause chart'; chartDirty = true; });
  $('#r-discard').addEventListener('click', () => { state.pending = null; $('#review').classList.add('hidden'); });
  $('#r-download').addEventListener('click', () => state.pending && download(state.pending));
  $('#r-upload').addEventListener('click', () => { if (state.pending) { upload(state.pending); state.pending = null; $('#review').classList.add('hidden'); } });
  for (const b of document.querySelectorAll('#train [data-kind]')) b.addEventListener('click', () => runJob(b.dataset.kind));
  $('#zip').addEventListener('change', (e) => uploadZip(e.target.files[0]));
  for (const b of document.querySelectorAll('#engine-pick [data-e]')) {
    b.addEventListener('click', async () => {
      const r = await net.request('motion_engine', { engine: b.dataset.e });
      if (r && r.ok) { state.engine = r.engine; if (r.engine.labels.length) state.labels = r.engine.labels; renderBoard(); renderTest(); }
      else toast(r ? r.error : 'No answer from the board', 'warn');
    });
  }
  $('#remove-model').addEventListener('click', async () => {
    if (!confirm('Remove the Edge Impulse model from the sketch? The board keeps running it until the app restarts.')) return;
    const r = await net.request('model_remove', {});
    toast(r && r.ok ? 'Model removed. Restart the app to apply.' : 'Could not remove the model', r && r.ok ? '' : 'warn');
  });
  const th = $('#threshold');
  th.value = threshold();
  $('#th-val').textContent = Math.round(threshold() * 100) + '%';
  th.addEventListener('input', () => { setThreshold(+th.value); $('#th-val').textContent = Math.round(+th.value * 100) + '%'; renderTest(); });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyR' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') startRecording();
    if (e.code === 'Escape' && state.recording) { state.recording = null; failRecording('Recording cancelled'); $('#countdown').classList.add('hidden'); }
  });

  const claimWheel = async () => {
    const c = await net.request('motion_claim', { force: true, kind: 'lab' });
    if (c) state.owner = c.owner;
  };
  // the game tab takes the wheel back when you switch to it; take it again here
  window.addEventListener('focus', () => { if (net.connected && state.owner !== net.id) claimWheel(); });

  net.on('connect', async () => {
    net.joinRoom('motion');
    renderBoard();
    const st = await net.request('motion_status', {});
    onStatus(st);
    if (st && st.ml) onMl(st.ml);
    // take the wheel while the lab is open so button A records here, not in a game tab
    claimWheel();
    net.send('ctl_leds', { mask: 1 });
    if ($('#api-key').value && !state.project) connectEI();
  });
  net.on('disconnect', () => { state.online = false; renderBoard(); });
  net.on('hw', onStatus);
  net.on('imu', onImu);
  net.on('ml', onMl);
  net.on('btn', onButton);
  net.on('motion_owner', (m) => { state.owner = m ? m.id : null; });
  net.on('motion_record_done', onRecordDone);
  net.on('ei_job_progress', onJobProgress);
  net.connect('Motion Lab');

  // board heartbeat timeout
  setInterval(() => {
    if (state.online && state.buf.length && performance.now() - state.imuT > 6000) { state.online = false; renderBoard(); }
  }, 2000);
  renderBoard();
  renderImpulse();
  renderLabelChips();
  renderTest();
  requestAnimationFrame(renderCharts);
}

init();
window.motionLab = state;   // for debugging
