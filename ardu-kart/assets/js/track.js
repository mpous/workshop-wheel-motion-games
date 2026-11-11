// Track: samples a closed centre-line spline and builds road, curbs, shoulders, walls, terrain and
// track furniture. Also answers the spatial queries the physics needs (progress, lateral offset, ground).
import * as THREE from '../libs/three.bundle.js';
import { clamp, lerp, smoothstep, makeNoise2D, hashString } from './util.js';
import * as TEX from './textures.js';
import { THEMES } from './tracks.js';

export const TRACK_SCALE = 1.2;
const SPACING = 2; // world units between centre-line samples
const WALL_H = 1.5;

export class Track {
  constructor(def, { quality = 'high' } = {}) {
    this.def = def;
    this.theme = THEMES[def.theme];
    this.quality = quality;
    this.group = new THREE.Group();
    this.group.name = 'track';
    this.animated = []; // { update(t, dt) }
    this._sample();
    this._features();
    this._buildRoad();
    this._buildTerrain();
    this._buildStartGate();
    this._buildRamps();
    this._buildBoostPads();
  }

  // ---------------------------------------------------------------- sampling
  _sample() {
    const def = this.def;
    const ctrl = def.points.map((p) => new THREE.Vector3(p[0] * TRACK_SCALE, p[2], p[1] * TRACK_SCALE));
    const curve = new THREE.CatmullRomCurve3(ctrl, true, 'centripetal');
    this.length = curve.getLength();
    const N = (this.N = Math.round(this.length / SPACING));
    const pts = curve.getSpacedPoints(N);
    this.px = new Float32Array(N);
    this.py = new Float32Array(N);
    this.pz = new Float32Array(N);
    this.tx = new Float32Array(N);
    this.tz = new Float32Array(N);
    this.lx = new Float32Array(N); // lateral (left) unit vector
    this.lz = new Float32Array(N);
    this.curv = new Float32Array(N); // signed curvature (1/radius), + = turning left
    this.slope = new Float32Array(N);
    this.hw = new Float32Array(N); // half width of tarmac
    for (let i = 0; i < N; i++) {
      this.px[i] = pts[i].x;
      this.py[i] = pts[i].y;
      this.pz[i] = pts[i].z;
    }
    for (let i = 0; i < N; i++) {
      const a = (i - 1 + N) % N, b = (i + 1) % N;
      let dx = this.px[b] - this.px[a], dz = this.pz[b] - this.pz[a];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      this.tx[i] = dx; this.tz[i] = dz;
      this.lx[i] = dz; this.lz[i] = -dx;
      this.slope[i] = (this.py[b] - this.py[a]) / (l || 1);
      this.hw[i] = def.width / 2;
    }
    // curvature from heading change over a window, then smoothed
    const raw = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const a = (i - 3 + N) % N, b = (i + 3) % N;
      const h0 = Math.atan2(this.tx[a], this.tz[a]);
      let dh = Math.atan2(this.tx[b], this.tz[b]) - h0;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      raw[i] = dh / (6 * SPACING);
    }
    for (let i = 0; i < N; i++) {
      let s = 0;
      for (let k = -4; k <= 4; k++) s += raw[(i + k + N) % N];
      this.curv[i] = s / 9;
    }
    this.shoulder = def.shoulder;
    this.wallDist = def.width / 2 + def.shoulder;
  }

  idxOfT(t) {
    return ((Math.round(t * this.N) % this.N) + this.N) % this.N;
  }

  _features() {
    const N = this.N;
    this.rampAt = new Float32Array(N); // ramp height at sample (only on tarmac)
    this.rampLip = new Uint8Array(N);
    this.boostAt = new Int8Array(N).fill(-1);
    this.ramps = (this.def.ramps || []).map((r) => {
      const i0 = this.idxOfT(r.t);
      const n = Math.max(2, Math.round(r.len / SPACING));
      for (let k = 0; k <= n; k++) this.rampAt[(i0 + k) % N] = (k / n) * r.h;
      this.rampLip[(i0 + n) % N] = 1;
      return { i0, n, h: r.h, len: n * SPACING };
    });
    this.pads = (this.def.boostPads || []).map((b, j) => {
      const i0 = this.idxOfT(b.t);
      for (let k = 0; k < 4; k++) this.boostAt[(i0 + k) % N] = j;
      return { i0, off: b.off, n: 4, halfW: 3.2 };
    });
    this.itemRows = (this.def.itemRows || []).map((t) => this.idxOfT(t));
    this.coinRows = (this.def.coins || []).map((t) => this.idxOfT(t));
  }

  // ---------------------------------------------------------------- queries
  wrap(i) {
    const N = this.N;
    return ((i % N) + N) % N;
  }

  // Finds the closest centre-line segment. `hint` (previous index) keeps the search local so that
  // overlapping sections (bridges) never get confused. Returns `out`.
  query(x, y, z, hint, out = {}) {
    const N = this.N;
    let best = 0, bestD = Infinity;
    if (hint == null || hint < 0) {
      for (let i = 0; i < N; i++) {
        const dx = x - this.px[i], dz = z - this.pz[i], dy = (y - this.py[i]) * 3;
        const d = dx * dx + dz * dz + dy * dy;
        if (d < bestD) { bestD = d; best = i; }
      }
    } else {
      for (let k = -14; k <= 14; k++) {
        const i = (hint + k + N) % N;
        const dx = x - this.px[i], dz = z - this.pz[i];
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    // refine onto segment best->next or prev->best
    const nx = (best + 1) % N, pv = (best - 1 + N) % N;
    let i0 = best, i1 = nx;
    const fwd = (x - this.px[best]) * this.tx[best] + (z - this.pz[best]) * this.tz[best];
    if (fwd < 0) { i0 = pv; i1 = best; }
    const sx = this.px[i1] - this.px[i0], sz = this.pz[i1] - this.pz[i0];
    const sl2 = sx * sx + sz * sz || 1;
    const f = clamp(((x - this.px[i0]) * sx + (z - this.pz[i0]) * sz) / sl2, 0, 1);
    const cx = this.px[i0] + sx * f, cz = this.pz[i0] + sz * f;
    const lx = lerp(this.lx[i0], this.lx[i1], f), lz = lerp(this.lz[i0], this.lz[i1], f);
    const lat = (x - cx) * lx + (z - cz) * lz;
    out.idx = i0;
    out.frac = f;
    out.pos = i0 + f; // fractional sample index
    out.lat = lat;
    out.tx = lerp(this.tx[i0], this.tx[i1], f);
    out.tz = lerp(this.tz[i0], this.tz[i1], f);
    out.hw = this.hw[i0];
    out.wall = this.wallDist;
    const cy = lerp(this.py[i0], this.py[i1], f);
    out.centerY = cy;
    const alat = Math.abs(lat);
    out.onRoad = alat <= out.hw + 0.6;
    let g = cy;
    if (alat > out.hw) g -= (alat - out.hw) * 0.05;
    else g += lerp(this.rampAt[i0], this.rampAt[i1], f) * (this.rampAt[i1] > 0 || this.rampAt[i0] > 0 ? 1 : 0);
    out.ground = g;
    out.rampLip = this.rampLip[i0] === 1 && alat <= out.hw;
    out.onRamp = this.rampAt[i0] > 0 && alat <= out.hw;
    const pad = this.boostAt[i0];
    out.boost = pad >= 0 && Math.abs(lat - this.pads[pad].off) < this.pads[pad].halfW;
    out.slope = this.slope[i0];
    return out;
  }

  point(idxF, lat = 0, out = new THREE.Vector3()) {
    const N = this.N;
    const i0 = Math.floor(idxF);
    const f = idxF - i0;
    const a = this.wrap(i0), b = this.wrap(i0 + 1);
    const lx = lerp(this.lx[a], this.lx[b], f), lz = lerp(this.lz[a], this.lz[b], f);
    out.set(
      lerp(this.px[a], this.px[b], f) + lx * lat,
      lerp(this.py[a], this.py[b], f),
      lerp(this.pz[a], this.pz[b], f) + lz * lat,
    );
    return out;
  }

  heading(idxF) {
    const a = this.wrap(Math.floor(idxF));
    return Math.atan2(this.tx[a], this.tz[a]);
  }

  gridSlot(k) {
    const row = Math.floor(k / 2);
    const side = k % 2 === 0 ? 1 : -1;
    const idx = this.N - 4 - row * 3.2 - (k % 2) * 1.4;
    return { idx: this.wrap(Math.round(idx * 10) / 10), lat: side * this.def.width * 0.2 };
  }

  // ---------------------------------------------------------------- road meshes
  _ribbon(latA, latB, steps, opts) {
    const { yFn, uScale = 1, vTile = 10, filter, down = false } = opts;
    const N = this.N;
    const pos = [], uv = [], idx = [];
    const cols = steps + 1;
    let s = 0;
    const segs = [];
    for (let i = 0; i <= N; i++) {
      const j = i % N;
      if (i > 0) {
        const pj = (i - 1) % N;
        s += Math.hypot(this.px[j] - this.px[pj], this.pz[j] - this.pz[pj], this.py[j] - this.py[pj]);
      }
      for (let c = 0; c < cols; c++) {
        const t = c / steps;
        const la = typeof latA === 'function' ? latA(j) : latA;
        const lb = typeof latB === 'function' ? latB(j) : latB;
        const lat = lerp(la, lb, t);
        const y = this.py[j] + (yFn ? yFn(j, lat, t) : 0);
        pos.push(this.px[j] + this.lx[j] * lat, y, this.pz[j] + this.lz[j] * lat);
        uv.push(t * uScale, s / vTile);
      }
      segs.push(j);
    }
    // ribbons can run left->right or right->left; keep every one facing up
    const ax = pos[3] - pos[0], az = pos[5] - pos[2];
    const fx = pos[cols * 3] - pos[0], fz = pos[cols * 3 + 2] - pos[2];
    const up = (fz * ax - fx * az > 0) !== down;
    for (let i = 0; i < N; i++) {
      if (filter && !filter(i)) continue;
      for (let c = 0; c < steps; c++) {
        const a = i * cols + c, b = a + 1, d = a + cols, e = d + 1;
        if (up) idx.push(a, d, b, b, d, e);
        else idx.push(a, b, d, b, e, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  _buildRoad() {
    const th = this.def.theme;
    const hw = this.def.width / 2;
    const night = this.theme.night;
    // tarmac
    const roadMat = new THREE.MeshStandardMaterial({
      map: TEX.roadTexture(th),
      roughness: th === 'neon' ? 0.32 : th === 'frost' ? 0.55 : 0.82,
      metalness: th === 'neon' ? 0.35 : 0.0,
      envMapIntensity: th === 'neon' ? 1.4 : 0.6,
    });
    if (th === 'neon') {
      roadMat.emissiveMap = TEX.roadEmissiveTexture();
      roadMat.emissive = new THREE.Color(0xffffff);
      roadMat.emissiveIntensity = 1.6;
    }
    const road = new THREE.Mesh(this._ribbon(hw, -hw, 8, { vTile: 26, yFn: () => 0.02 }), roadMat);
    road.receiveShadow = true;
    road.name = 'road';
    this.group.add(road);

    // curbs at corners only (both sides), slightly raised
    const curbMask = new Uint8Array(this.N);
    for (let i = 0; i < this.N; i++) if (Math.abs(this.curv[i]) > 1 / 75) curbMask[i] = 1;
    // dilate so curbs begin a little before the corner
    const dil = curbMask.slice();
    for (let i = 0; i < this.N; i++) if (curbMask[i]) for (let k = -6; k <= 6; k++) dil[this.wrap(i + k)] = 1;
    const curbMat = new THREE.MeshStandardMaterial({ map: TEX.curbTexture(th), roughness: 0.6 });
    if (th === 'neon') {
      curbMat.emissiveMap = curbMat.map;
      curbMat.emissive = new THREE.Color(0xffffff);
      curbMat.emissiveIntensity = 0.7;
    }
    for (const side of [1, -1]) {
      const g = this._ribbon(side * (hw - 0.3), side * (hw + 1.5), 2, {
        vTile: 4,
        yFn: (j, lat, t) => 0.06 + Math.sin(t * Math.PI) * 0.08,
        filter: (i) => dil[i] && dil[(i + 1) % this.N],
      });
      const m = new THREE.Mesh(g, curbMat);
      m.receiveShadow = true;
      this.group.add(m);
    }

    // shoulders (off-road strip up to the walls)
    const offTex = TEX.groundTexture(this.def.offroad);
    const shMat = new THREE.MeshStandardMaterial({ map: offTex, roughness: 0.95 });
    if (th === 'neon') {
      shMat.emissiveMap = TEX.neonGridEmissive();
      shMat.emissive = new THREE.Color(0xffffff);
      shMat.emissiveIntensity = 0.8;
    }
    for (const side of [1, -1]) {
      const g = this._ribbon(side * hw, side * (this.wallDist + 0.3), 3, {
        vTile: 14,
        uScale: this.shoulder / 14,
        yFn: (j, lat) => -Math.max(0, Math.abs(lat) - hw) * 0.05,
      });
      const m = new THREE.Mesh(g, shMat);
      m.receiveShadow = true;
      this.group.add(m);
    }

    // walls / barriers
    const wallMat = new THREE.MeshStandardMaterial({
      map: TEX.wallTexture(th),
      roughness: 0.55,
      metalness: th === 'sunset' ? 0.2 : 0,
      side: THREE.DoubleSide,
    });
    if (th === 'neon') {
      wallMat.emissiveMap = wallMat.map;
      wallMat.emissive = new THREE.Color(0xffffff);
      wallMat.emissiveIntensity = 1.3;
    }
    const wd = this.wallDist;
    const drop = (j, lat) => -Math.max(0, Math.abs(lat) - hw) * 0.05;
    for (const side of [1, -1]) {
      const wallG = this._wall(side * wd, WALL_H, th === 'frost' ? 0.9 : 0.35, drop);
      const w = new THREE.Mesh(wallG, wallMat);
      w.castShadow = this.quality !== 'low';
      w.receiveShadow = true;
      this.group.add(w);
    }

    // bridge decks & pillars where there is no terrain underneath
    if (!this.def.skirt) this._buildDeck();
  }

  _wall(lat, height, thick, dropFn) {
    // closed box-ish strip: inner face, top, outer face
    const N = this.N;
    const pos = [], uv = [], idx = [];
    const sgn = Math.sign(lat);
    let s = 0;
    const prof = [
      [lat - sgn * thick * 0.5, -2.5, 0],
      [lat - sgn * thick * 0.5, height, 0.8],
      [lat + sgn * thick * 0.5, height, 0.85],
      [lat + sgn * thick * 0.5, -2.5, 1],
    ];
    for (let i = 0; i <= N; i++) {
      const j = i % N;
      if (i > 0) {
        const pj = (i - 1) % N;
        s += Math.hypot(this.px[j] - this.px[pj], this.pz[j] - this.pz[pj]);
      }
      const base = this.py[j] + dropFn(j, lat);
      for (const [l, h, u] of prof) {
        pos.push(this.px[j] + this.lx[j] * l, base + h, this.pz[j] + this.lz[j] * l);
        uv.push(s / 8, u);
      }
    }
    for (let i = 0; i < N; i++)
      for (let c = 0; c < 3; c++) {
        const a = i * 4 + c, b = a + 1, d = a + 4, e = d + 1;
        if (sgn > 0) idx.push(a, b, d, b, e, d);
        else idx.push(a, d, b, b, d, e);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  _buildDeck() {
    const wd = this.wallDist + 0.3;
    const deckMat = new THREE.MeshStandardMaterial({ color: 0x1c1d2e, roughness: 0.7, metalness: 0.4 });
    const underG = this._ribbon(-wd, wd, 1, {
      vTile: 20,
      down: true,
      yFn: (j, lat) => -1.4 - Math.max(0, Math.abs(lat) - this.def.width / 2) * 0.05,
      filter: (i) => this.py[i] > 1.5,
    });
    const under = new THREE.Mesh(underG, deckMat);
    this.group.add(under);
    // pillars
    const pillarG = new THREE.CylinderGeometry(1.1, 1.4, 1, 12);
    const glowMat = new THREE.MeshStandardMaterial({ color: 0x111122, emissive: 0x7a3cff, emissiveIntensity: 2.2 });
    const ringG = new THREE.TorusGeometry(1.25, 0.12, 6, 16);
    const pillars = [];
    for (let i = 0; i < this.N; i += 9) {
      if (this.py[i] < 3) continue;
      pillars.push(i);
    }
    const inst = new THREE.InstancedMesh(pillarG, deckMat, pillars.length * 2);
    const rings = new THREE.InstancedMesh(ringG, glowMat, pillars.length * 2);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    let k = 0;
    for (const i of pillars) {
      for (const side of [-0.6, 0.6]) {
        const h = this.py[i] - 1.4 + 0.5;
        p.set(this.px[i] + this.lx[i] * side * this.wallDist, (h - 0.5) / 2, this.pz[i] + this.lz[i] * side * this.wallDist);
        sc.set(1, h + 0.5, 1);
        m.compose(p, q.identity(), sc);
        inst.setMatrixAt(k, m);
        p.y = h * 0.55;
        m.compose(p, q.setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)), sc.set(1, 1, 1));
        rings.setMatrixAt(k, m);
        k++;
      }
    }
    inst.castShadow = true;
    this.group.add(inst, rings);
  }

  // ---------------------------------------------------------------- terrain
  terrainHeightFar(x, z) {
    const n = this._noise;
    switch (this.def.theme) {
      case 'sunset': {
        const coast = clamp((z + 40) * 0.07, -9, 14);
        return coast + n.fbm(x * 0.006, z * 0.006, 4) * 14 + Math.max(0, z - 220) * 0.12;
      }
      case 'frost':
        return 8 + n.fbm(x * 0.005, z * 0.005, 5) * 40 + Math.abs(n(x * 0.012, z * 0.012)) * 18;
      case 'dunes':
        return 3 + Math.sin(x * 0.02 + Math.sin(z * 0.01) * 2) * 6 + n.fbm(x * 0.008, z * 0.008, 3) * 12;
      default:
        return -0.4;
    }
  }

  _buildTerrain() {
    this._noise = makeNoise2D(hashString(this.def.id));
    const th = this.def.theme;
    // bounds
    let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
    for (let i = 0; i < this.N; i++) {
      minx = Math.min(minx, this.px[i]); maxx = Math.max(maxx, this.px[i]);
      minz = Math.min(minz, this.pz[i]); maxz = Math.max(maxz, this.pz[i]);
    }
    const cx = (minx + maxx) / 2, cz = (minz + maxz) / 2;
    const size = Math.max(maxx - minx, maxz - minz) + 900;
    this.center = new THREE.Vector3(cx, 0, cz);
    this.radius = Math.max(maxx - minx, maxz - minz) / 2;
    const res = this.quality === 'low' ? 110 : this.quality === 'medium' ? 160 : 210;
    const geo = new THREE.PlaneGeometry(size, size, res, res);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const wd = this.wallDist;
    const pal = {
      sunset: [new THREE.Color(0x5f9a3c), new THREE.Color(0x8a7a5a), new THREE.Color(0xecd39e)],
      frost: [new THREE.Color(0xf2f6fc), new THREE.Color(0x8590a0), new THREE.Color(0xdfe9f5)],
      dunes: [new THREE.Color(0xe7c48a), new THREE.Color(0xb07a48), new THREE.Color(0xf0d39c)],
      neon: [new THREE.Color(0x15152a), new THREE.Color(0x15152a), new THREE.Color(0x15152a)],
    }[th];
    const tmp = new THREE.Color();
    // coarse sample stride for nearest track distance
    const stride = 2;
    for (let v = 0; v < pos.count; v++) {
      const x = pos.getX(v) + cx, z = pos.getZ(v) + cz;
      let bd = Infinity, bi = 0;
      for (let i = 0; i < this.N; i += stride) {
        const dx = x - this.px[i], dz = z - this.pz[i];
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; bi = i; }
      }
      const d = Math.sqrt(bd);
      const far = this.terrainHeightFar(x, z);
      let h;
      if (th === 'neon') h = -0.4;
      else {
        const near = this.py[bi] - 1.0 - Math.max(0, d - this.def.width / 2) * 0.05;
        const t = smoothstep(wd + 4, wd + 70, d);
        h = lerp(near, Math.max(far, near - 30), t);
        if (d < wd + 4) h = Math.min(h, near);
      }
      pos.setXYZ(v, x, h, z);
      // colouring
      if (th === 'sunset') {
        const beach = smoothstep(1.6, -0.5, h);
        tmp.copy(pal[0]).lerp(pal[1], smoothstep(10, 22, h)).lerp(pal[2], beach);
      } else if (th === 'frost') {
        tmp.copy(pal[0]).lerp(pal[1], smoothstep(0.55, 0.9, Math.abs(this._noise(x * 0.03, z * 0.03)) + smoothstep(30, 60, h) * 0.3));
      } else if (th === 'dunes') {
        tmp.copy(pal[0]).lerp(pal[1], smoothstep(10, 22, h) * 0.7).lerp(pal[2], smoothstep(0.2, 0.6, this._noise(x * 0.01, z * 0.01)));
      } else tmp.copy(pal[0]);
      const nv = 0.92 + this._noise(x * 0.08, z * 0.08) * 0.12;
      colors[v * 3] = tmp.r * nv;
      colors[v * 3 + 1] = tmp.g * nv;
      colors[v * 3 + 2] = tmp.b * nv;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const tex = TEX.groundTexture(this.def.terrain).clone();
    tex.repeat.set(size / 28, size / 28);
    tex.needsUpdate = true;
    const mat = new THREE.MeshStandardMaterial({ map: tex, vertexColors: true, roughness: 0.95 });
    if (th === 'neon') {
      const e = TEX.neonGridEmissive().clone();
      e.repeat.set(size / 40, size / 40);
      e.needsUpdate = true;
      mat.emissiveMap = e;
      mat.emissive = new THREE.Color(0xffffff);
      mat.emissiveIntensity = 0.55;
      mat.roughness = 0.4;
      mat.metalness = 0.5;
    }
    const terrain = new THREE.Mesh(geo, mat);
    terrain.receiveShadow = true;
    terrain.name = 'terrain';
    this.group.add(terrain);
    this.terrainSize = size;
    // a vertex texture-less helper for scenery placement
    this.distToTrack = (x, z) => {
      let bd = Infinity, bi = 0;
      for (let i = 0; i < this.N; i += 2) {
        const dx = x - this.px[i], dz = z - this.pz[i];
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; bi = i; }
      }
      return { d: Math.sqrt(bd), i: bi };
    };
    this.groundAt = (x, z) => {
      const { d, i } = this.distToTrack(x, z);
      if (th === 'neon') return -0.4;
      const near = this.py[i] - 1.0 - Math.max(0, d - this.def.width / 2) * 0.05;
      const t = smoothstep(wd + 4, wd + 70, d);
      const far = this.terrainHeightFar(x, z);
      let h = lerp(near, Math.max(far, near - 30), t);
      if (d < wd + 4) h = Math.min(h, near);
      return h;
    };
  }

  // ---------------------------------------------------------------- furniture
  _buildStartGate() {
    const i = 0;
    const p = this.point(i, 0);
    const heading = this.heading(i);
    const g = new THREE.Group();
    g.position.copy(p);
    g.rotation.y = heading;
    const hw = this.wallDist - 1;
    const postMat = new THREE.MeshStandardMaterial({ color: 0x2a2d3a, metalness: 0.7, roughness: 0.35 });
    const postG = new THREE.BoxGeometry(1.2, 9, 1.2);
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(postG, postMat);
      post.position.set(s * hw, 4.5, 0);
      post.castShadow = true;
      g.add(post);
    }
    const bannerTex = TEX.billboardTexture(['ARDU KART', 'POWERED BY ARDUINO UNO Q'], { bg: '#0b1a3a', accent: '#00a8a8' });
    const banner = new THREE.Mesh(
      new THREE.BoxGeometry(hw * 2 + 1.2, 2.4, 0.6),
      [postMat, postMat, postMat, postMat, new THREE.MeshStandardMaterial({ map: bannerTex, emissiveMap: bannerTex, emissive: 0xffffff, emissiveIntensity: 0.35 }), new THREE.MeshStandardMaterial({ map: bannerTex, emissiveMap: bannerTex, emissive: 0xffffff, emissiveIntensity: 0.35 })],
    );
    banner.position.set(0, 8.4, 0);
    banner.castShadow = true;
    g.add(banner);
    // countdown light bar (5 lamps)
    this.startLights = [];
    const lampG = new THREE.SphereGeometry(0.45, 16, 12);
    for (let k = 0; k < 5; k++) {
      const mat = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff0000, emissiveIntensity: 0 });
      const lamp = new THREE.Mesh(lampG, mat);
      lamp.position.set((k - 2) * 1.4, 6.6, -0.4);
      g.add(lamp);
      this.startLights.push(mat);
    }
    const housing = new THREE.Mesh(new THREE.BoxGeometry(7.6, 1.3, 0.6), postMat);
    housing.position.set(0, 6.6, -0.1);
    g.add(housing);
    // checkered start line on the road
    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(this.def.width, 2.2),
      new THREE.MeshStandardMaterial({ map: TEX.checkerTexture(10), roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2 }),
    );
    line.rotation.x = -Math.PI / 2;
    line.position.y = 0.05;
    line.receiveShadow = true;
    g.add(line);
    this.group.add(g);
  }

  setStartLights(phase) {
    // phase: -1 off, 0..3 = number of red lights lit pairs, 4 = green
    if (!this.startLights) return;
    this.startLights.forEach((m, k) => {
      if (phase >= 4) {
        m.emissive.setHex(0x00ff55);
        m.emissiveIntensity = 4;
      } else {
        m.emissive.setHex(0xff1a00);
        const lit = phase > 0 && k < Math.ceil((phase / 3) * 5);
        m.emissiveIntensity = lit ? 4 : 0;
      }
    });
  }

  _buildRamps() {
    const mat = new THREE.MeshStandardMaterial({ map: TEX.boostPadTexture(), roughness: 0.4, emissive: 0xff8800, emissiveIntensity: 0.25 });
    const sideMat = new THREE.MeshStandardMaterial({ color: 0x3b3f4c, roughness: 0.6, metalness: 0.4 });
    for (const r of this.ramps) {
      const hw = this.def.width / 2;
      const pos = [], uv = [], idx = [];
      for (let k = 0; k <= r.n; k++) {
        const j = this.wrap(r.i0 + k);
        const h = (k / r.n) * r.h;
        for (const [lat, u] of [[hw, 0], [-hw, 1]]) {
          pos.push(this.px[j] + this.lx[j] * lat, this.py[j] + h + 0.04, this.pz[j] + this.lz[j] * lat);
          uv.push(u * 3, k / r.n * 2);
        }
      }
      for (let k = 0; k < r.n; k++) {
        const a = k * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      const top = new THREE.Mesh(g, mat);
      top.receiveShadow = true;
      top.castShadow = true;
      this.group.add(top);
      // vertical lip face + side triangles
      const j = this.wrap(r.i0 + r.n);
      const lipG = new THREE.PlaneGeometry(this.def.width, r.h);
      const lip = new THREE.Mesh(lipG, sideMat);
      lip.position.set(this.px[j], this.py[j] + r.h / 2, this.pz[j]);
      lip.rotation.y = Math.atan2(this.tx[j], this.tz[j]);
      this.group.add(lip);
      for (const s of [1, -1]) {
        const sp = [];
        const lat = s * hw;
        const j0 = this.wrap(r.i0);
        sp.push(this.px[j0] + this.lx[j0] * lat, this.py[j0], this.pz[j0] + this.lz[j0] * lat);
        sp.push(this.px[j] + this.lx[j] * lat, this.py[j] + r.h, this.pz[j] + this.lz[j] * lat);
        sp.push(this.px[j] + this.lx[j] * lat, this.py[j], this.pz[j] + this.lz[j] * lat);
        const sg = new THREE.BufferGeometry();
        sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
        sg.computeVertexNormals();
        const side = new THREE.Mesh(sg, new THREE.MeshStandardMaterial({ color: 0x3b3f4c, side: THREE.DoubleSide }));
        this.group.add(side);
      }
    }
  }

  _buildBoostPads() {
    const tex = TEX.boostPadTexture().clone();
    tex.needsUpdate = true;
    const mat = new THREE.MeshStandardMaterial({
      map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 1.2, roughness: 0.3,
      polygonOffset: true, polygonOffsetFactor: -3,
    });
    for (const pad of this.pads) {
      const pos = [], uv = [], idx = [];
      for (let k = 0; k <= pad.n; k++) {
        const j = this.wrap(pad.i0 + k);
        for (const [lat, u] of [[pad.off + pad.halfW, 0], [pad.off - pad.halfW, 1]]) {
          pos.push(this.px[j] + this.lx[j] * lat, this.py[j] + 0.06, this.pz[j] + this.lz[j] * lat);
          uv.push(u, (k / pad.n) * 2);
        }
      }
      for (let k = 0; k < pad.n; k++) {
        const a = k * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, mat);
      m.receiveShadow = true;
      this.group.add(m);
    }
    this.animated.push({ update: (t) => { tex.offset.y = -t * 2.2; mat.emissiveIntensity = 1.0 + Math.sin(t * 10) * 0.3; } });
  }

  update(t, dt) {
    for (const a of this.animated) a.update(t, dt);
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    });
  }
}
