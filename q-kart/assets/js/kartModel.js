// Q-Kart — procedural karts, drivers, item icons and item meshes.
// Kart space: +Z forward, +Y up, origin = ground contact centre. Left side = +X.
import * as THREE from '../libs/three.bundle.js';

const BGU = THREE.BufferGeometryUtils;

/* ------------------------------------------------------------------ */
/* Characters                                                          */
/* ------------------------------------------------------------------ */
export const CHARACTERS = [
  { id: 0, name: 'Volt', tagline: 'Quick as a spark, twice as bright.', color: 0xffc414, accent: 0x2457ff, suit: 0x2457ff, skin: 0xfff0d8, glove: 0xffffff, head: 'helmet', accessory: 'fox', weightClass: 'light', stats: { speed: 2, accel: 5, weight: 1, handling: 4 } },
  { id: 1, name: 'Nova', tagline: 'Born among the stars, raised on the asphalt.', color: 0xff3d9e, accent: 0x5a2cff, suit: 0xf3f1ff, skin: 0xffd6c0, glove: 0xff3d9e, head: 'helmet', accessory: 'star', weightClass: 'light', stats: { speed: 3, accel: 4, weight: 2, handling: 4 } },
  { id: 2, name: 'Byte', tagline: 'Zero bugs. Maximum throughput.', color: 0x3fd35a, accent: 0x2c3342, suit: 0x3a4152, skin: 0x3fd35a, glove: 0xd9dee8, head: 'robot', accessory: 'none', led: 0x5ffcff, weightClass: 'medium', stats: { speed: 3, accel: 3, weight: 3, handling: 3 } },
  { id: 3, name: 'Rusty', tagline: 'If it ain\'t broke, add more horsepower.', color: 0xff7a1c, accent: 0x6e4529, suit: 0x3d5f8f, skin: 0xb9773f, muzzle: 0xf3d6ad, glove: 0xf2c94c, head: 'helmet', accessory: 'bear', weightClass: 'heavy', stats: { speed: 5, accel: 2, weight: 5, handling: 1 } },
  { id: 4, name: 'Pixel', tagline: 'Nine lives, one racing line.', color: 0x1fd0f0, accent: 0xff5aad, suit: 0xffffff, skin: 0xfff5ee, glove: 0xff5aad, head: 'helmet', accessory: 'cat', weightClass: 'light', stats: { speed: 2, accel: 4, weight: 2, handling: 5 } },
  { id: 5, name: 'Ohm', tagline: 'Resistance is futile.', color: 0x8b45ff, accent: 0xffc23a, suit: 0x3d1f7c, skin: 0xffd9b8, glove: 0xffc23a, head: 'helmet', accessory: 'wizard', weightClass: 'medium', stats: { speed: 3, accel: 3, weight: 3, handling: 4 } },
  { id: 6, name: 'Diode', tagline: 'One direction: forward. Fast.', color: 0xff2b3c, accent: 0x23262f, suit: 0x23262f, skin: 0xffcfa8, glove: 0xffffff, head: 'helmet', accessory: 'crest', weightClass: 'heavy', stats: { speed: 5, accel: 3, weight: 3, handling: 2 } },
  { id: 7, name: 'Qubit', tagline: 'Superposition: already at the finish line.', color: 0x00a9ae, accent: 0xeef6f6, suit: 0x0d5a5e, skin: 0x00a9ae, glove: 0xeef6f6, head: 'dome', accessory: 'antenna', led: 0x8afcff, weightClass: 'heavy', stats: { speed: 4, accel: 3, weight: 4, handling: 2 } },
];

/* ------------------------------------------------------------------ */
/* Caches & helpers                                                    */
/* ------------------------------------------------------------------ */
const GEO = new Map();
const MAT = new Map();
const TEX = new Map();
const MERGED = new Map();
const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const AX_Y = V3(0, 1, 0);
const AX_Z = V3(0, 0, 1);

function cg(key, fn) { let g = GEO.get(key); if (!g) { g = fn(); GEO.set(key, g); } return g; }
function cm(key, fn) { let m = MAT.get(key); if (!m) { m = fn(); m.userData.key = key; MAT.set(key, m); } return m; }
function ct(key, fn) { let t = TEX.get(key); if (!t) { t = fn(); TEX.set(key, t); } return t; }
function own(key, mat) { mat.userData.key = 'own:' + key; return mat; }
const css = (c) => '#' + (c >>> 0).toString(16).padStart(6, '0');
const smooth = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };

function paint(color) {
  return cm('paint|' + color, () => new THREE.MeshPhysicalMaterial({ color, metalness: 0.3, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.1 }));
}
function satin(color, rough = 0.5, metal = 0.1) {
  return cm(`satin|${color}|${rough}|${metal}`, () => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal }));
}
const chrome = () => cm('chrome', () => new THREE.MeshStandardMaterial({ color: 0xf2f4f8, metalness: 1, roughness: 0.25 }));
const darkChrome = () => cm('darkChrome', () => new THREE.MeshStandardMaterial({ color: 0x6d7380, metalness: 1, roughness: 0.32 }));
const graphite = () => cm('graphite', () => new THREE.MeshStandardMaterial({ color: 0x2a2e37, metalness: 0.55, roughness: 0.42 }));
const rubber = () => cm('rubber', () => new THREE.MeshStandardMaterial({ color: 0x1d1e22, metalness: 0, roughness: 0.9 }));
const rubberTread = () => cm('rubberTread', () => new THREE.MeshStandardMaterial({ color: 0x26272c, metalness: 0, roughness: 0.86 }));
const blackGloss = () => cm('blackGloss', () => new THREE.MeshPhysicalMaterial({ color: 0x0b0e16, metalness: 0.2, roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.03 }));
const visorMat = () => cm('visor', () => new THREE.MeshPhysicalMaterial({ color: 0x101a2e, metalness: 0.35, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.02, sheen: 0.4, sheenColor: new THREE.Color(0x66aaff) }));
const glassMat = () => cm('glass', () => new THREE.MeshPhysicalMaterial({ color: 0xbfe6ff, metalness: 0, roughness: 0.02, transparent: true, opacity: 0.32, clearcoat: 1, depthWrite: false, side: THREE.DoubleSide }));
const eyeWhite = () => cm('eyeWhite', () => new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.25, clearcoat: 0.6 }));
const pupilMat = () => cm('pupil', () => new THREE.MeshPhysicalMaterial({ color: 0x141a2c, roughness: 0.1, clearcoat: 1, clearcoatRoughness: 0.02 }));
const glintMat = () => cm('glint', () => new THREE.MeshBasicMaterial({ color: 0xffffff }));
const blushMat = () => cm('blush', () => new THREE.MeshStandardMaterial({ color: 0xff8d9e, roughness: 0.7 }));
const mouthMat = () => cm('mouth', () => new THREE.MeshStandardMaterial({ color: 0x6e1f2e, roughness: 0.5 }));

function glowMat(key, color, intensity = 2, base = 0x000000) {
  return own(key, new THREE.MeshStandardMaterial({ color: base || color, emissive: color, emissiveIntensity: intensity, roughness: 0.3, metalness: 0 }));
}

function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function rrPath(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}

/* ---------- shapes ---------- */
function roundedRectShape(w, h, r) {
  const s = new THREE.Shape(); const x = -w / 2, y = -h / 2;
  r = Math.max(1e-4, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4));
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h); s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r); s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
function starShape(ro, ri, n = 5) {
  const s = new THREE.Shape();
  for (let i = 0; i < n * 2; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / n, r = i % 2 ? ri : ro;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    i ? s.lineTo(x, y) : s.moveTo(x, y);
  }
  return s;
}
function boltShape(k = 1) {
  const p = [[0.03, 0.17], [-0.08, -0.01], [-0.005, -0.01], [-0.045, -0.17], [0.09, 0.035], [0.015, 0.035], [0.07, 0.17]];
  const s = new THREE.Shape(); p.forEach(([x, y], i) => (i ? s.lineTo(x * k, y * k) : s.moveTo(x * k, y * k))); return s;
}

function segs(n, q, min = 3) { return Math.max(min, Math.round(n * q)); }
function boxGeo(w, h, d) { return cg(`box|${w}|${h}|${d}`, () => new THREE.BoxGeometry(w, h, d)); }
function crease(g, a = 0.8) { g.deleteAttribute('uv'); const out = BGU.toCreasedNormals(g, a); g.dispose(); return out; }
function roundedBoxGeo(w, h, d, r, seg = 1) {
  return cg(`rbox|${w}|${h}|${d}|${r}|${seg}`, () => {
    r = Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3);
    const iw = w - 2 * r, ih = h - 2 * r;
    const sh = roundedRectShape(iw, ih, Math.min(iw, ih) * 0.3);
    const g = new THREE.ExtrudeGeometry(sh, { depth: d - 2 * r, bevelEnabled: true, bevelThickness: r, bevelSize: r, bevelSegments: seg, curveSegments: Math.max(1, seg) });
    g.translate(0, 0, -(d - 2 * r) / 2);
    return crease(g, 0.9);
  });
}

// Extrude a side-profile shape (shape x -> world z, shape y -> world y) along X, centred on x=0.
function profileExtrude(shape, depth, bt, bs, bseg, cseg) {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bt > 0, bevelThickness: bt, bevelSize: bs, bevelSegments: bseg, curveSegments: cseg });
  g.rotateY(-Math.PI / 2);
  g.translate(depth / 2, 0, 0);
  return g;
}

// x' = s(z) * x, with correct normal transform.
function taperGeo(g, fn) {
  const p = g.attributes.position, n = g.attributes.normal, e = 1e-3; const v = V3();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i), s = fn(z), ds = (fn(z + e) - fn(z - e)) / (2 * e);
    p.setX(i, x * s);
    const nx = n.getX(i), ny = n.getY(i), nz = n.getZ(i);
    v.set(nx / s, ny, nz - (ds * x * nx) / s).normalize();
    n.setXYZ(i, v.x, v.y, v.z);
  }
  p.needsUpdate = true; n.needsUpdate = true;
  return g;
}
const bodyTaper = (z) => {
  if (z > 0.42) return 1 - 0.33 * smooth((z - 0.42) / 0.86);
  if (z < -0.72) return 1 - 0.12 * smooth((-0.72 - z) / 0.36);
  return 1;
};

function sphereGeo(r, w, h) { return cg(`sph|${r}|${w}|${h}`, () => new THREE.SphereGeometry(r, w, h)); }
function cylGeo(rt, rb, h, seg, open = false) { return cg(`cyl|${rt}|${rb}|${h}|${seg}|${open}`, () => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open)); }
function torusGeo(r, t, rs, ts, arc = Math.PI * 2) { return cg(`tor|${r}|${t}|${rs}|${ts}|${arc}`, () => new THREE.TorusGeometry(r, t, rs, ts, arc)); }
function capsuleGeo(r, l, cs, rs) { return cg(`cap|${r}|${l}|${cs}|${rs}`, () => new THREE.CapsuleGeometry(r, l, cs, rs)); }
function coneGeo(r, h, seg) { return cg(`cone|${r}|${h}|${seg}`, () => new THREE.ConeGeometry(r, h, seg)); }

function mesh(geo, mat, parent, pos, rot, scl) {
  const m = new THREE.Mesh(geo, mat);
  if (pos) m.position.copy(pos);
  if (rot) m.rotation.set(rot[0], rot[1], rot[2], rot[3] || 'XYZ');
  if (scl) (typeof scl === 'number' ? m.scale.setScalar(scl) : m.scale.copy(scl));
  m.castShadow = true;
  if (parent) parent.add(m);
  return m;
}
// Cylinder/capsule between two points.
function limb(geo, mat, parent, a, b) {
  const m = mesh(geo, mat, parent, a.clone().add(b).multiplyScalar(0.5));
  m.quaternion.setFromUnitVectors(AX_Y, b.clone().sub(a).normalize());
  return m;
}

/* ---------- merge static meshes per material (fewer draw calls) ---------- */
function mergeStatic(root, cacheKey, receive = false) {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  const buckets = new Map(); const victims = [];
  (function walk(o) {
    for (const c of o.children) {
      if (c.userData.noMerge) continue;
      if (c.isMesh && c.material.userData.key && c.children.length === 0) {
        let b = buckets.get(c.material); if (!b) { b = []; buckets.set(c.material, b); }
        b.push(c); victims.push(c);
      } else walk(c);
    }
  })(root);
  victims.forEach((v) => v.parent.remove(v));
  const out = [];
  for (const [mat, items] of buckets) {
    const key = cacheKey + '|' + mat.userData.key;
    let geo = MERGED.get(key);
    if (!geo) {
      const list = items.map((it) => {
        const src = it.geometry; const g = new THREE.BufferGeometry();
        g.setAttribute('position', src.attributes.position.clone());
        g.setAttribute('normal', src.attributes.normal.clone());
        g.setAttribute('uv', src.attributes.uv ? src.attributes.uv.clone() : new THREE.BufferAttribute(new Float32Array(src.attributes.position.count * 2), 2));
        if (src.index) g.setIndex(src.index.clone());
        else { const n = src.attributes.position.count; const idx = new (n > 65535 ? Uint32Array : Uint16Array)(n); for (let i = 0; i < n; i++) idx[i] = i; g.setIndex(new THREE.BufferAttribute(idx, 1)); }
        g.applyMatrix4(inv.clone().multiply(it.matrixWorld));
        return g;
      });
      geo = BGU.mergeGeometries(list, false);
      list.forEach((g) => g.dispose());
      geo.computeBoundingSphere();
      MERGED.set(key, geo);
    }
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = !mat.userData.noShadow; m.receiveShadow = receive;
    root.add(m); out.push(m);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Textures                                                            */
/* ------------------------------------------------------------------ */
function plateTex(num, accent) {
  return ct(`plate|${num}|${accent}`, () => canvasTex(256, 192, (ctx, w, h) => {
    ctx.fillStyle = css(accent); rrPath(ctx, 4, 4, w - 8, h - 8, 40); ctx.fill();
    const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#e4e8ef');
    ctx.fillStyle = g; rrPath(ctx, 20, 20, w - 40, h - 40, 28); ctx.fill();
    ctx.font = 'italic 900 132px "Arial Black", Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 10; ctx.strokeStyle = css(accent); ctx.strokeText(String(num), w / 2 + 4, h / 2 + 8);
    ctx.fillStyle = '#121520'; ctx.fillText(String(num), w / 2 + 4, h / 2 + 8);
  }));
}
function roundelTex(num, accent, primary) {
  return ct(`roundel|${num}|${accent}|${primary}`, () => canvasTex(256, 256, (ctx, w) => {
    ctx.fillStyle = css(accent); ctx.beginPath(); ctx.arc(w / 2, w / 2, 124, 0, 7); ctx.fill();
    ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(w / 2, w / 2, 104, 0, 7); ctx.fill();
    ctx.font = 'italic 900 140px "Arial Black", Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#121520'; ctx.fillText(String(num), w / 2 + 4, w / 2 + 10);
  }));
}
function carbonTex() {
  return ct('carbon', () => {
    const t = canvasTex(64, 64, (ctx) => {
      ctx.fillStyle = '#1c1f26'; ctx.fillRect(0, 0, 64, 64);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const g = ctx.createLinearGradient(x * 8, y * 8, x * 8 + 8, y * 8 + 8);
        const odd = (x + y) % 2; g.addColorStop(0, odd ? '#2c313b' : '#15171c'); g.addColorStop(1, odd ? '#191c22' : '#2a2e37');
        ctx.fillStyle = g; ctx.fillRect(x * 8, y * 8, 8, 8);
      }
    });
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(5, 5); return t;
  });
}
function carbonMat() { return cm('carbon', () => new THREE.MeshStandardMaterial({ color: 0xffffff, map: carbonTex(), metalness: 0.4, roughness: 0.45 })); }

/* ------------------------------------------------------------------ */
/* Wheels                                                              */
/* ------------------------------------------------------------------ */
function tireGeo(R, W, q) {
  return cg(`tire|${R}|${W}|${q}`, () => {
    const ri = R * 0.6, h = W / 2, c = Math.min(0.075, W * 0.3), arcN = q > 0.6 ? 2 : 1;
    const pts = [V2(ri, h * 0.88), V2((ri + R - c) * 0.5, h * 1.04)];
    pts.push(V2(R - c, h));
    for (let i = 1; i <= arcN; i++) { const a = Math.PI / 2 - (i / arcN) * (Math.PI / 2); pts.push(V2(R - c + c * Math.cos(a), h - c + c * Math.sin(a))); }
    pts.push(V2(R, -h + c));
    for (let i = 1; i <= arcN; i++) { const a = -(i / arcN) * (Math.PI / 2); pts.push(V2(R - c + c * Math.cos(a), -h + c + c * Math.sin(a))); }
    pts.push(V2((ri + R - c) * 0.5, -h * 1.04), V2(ri, -h * 0.88));
    pts.reverse();
    const g = new THREE.LatheGeometry(pts, segs(18, q));
    g.rotateZ(-Math.PI / 2);
    return g;
  });
}
function V2(x, y) { return new THREE.Vector2(x, y); }

function lugGeo(R, W, q) {
  return cg(`lugs|${R}|${W}|${q}`, () => {
    const N = q > 0.6 ? 10 : 6, list = [];
    const box = new THREE.BoxGeometry(W * 0.4, 0.03, 0.065);
    const m = new THREE.Matrix4(), tw = new THREE.Matrix4(), basis = new THREE.Matrix4();
    for (let i = 0; i < N; i++) for (const side of [-1, 1]) {
      const a = ((i + (side > 0 ? 0.5 : 0)) / N) * Math.PI * 2;
      const radial = V3(0, Math.cos(a), Math.sin(a)), tang = V3(0, -Math.sin(a), Math.cos(a));
      basis.makeBasis(V3(1, 0, 0), radial, tang);
      tw.makeRotationY(side * 0.45);
      m.copy(basis).multiply(tw); m.setPosition(side * W * 0.23, radial.y * (R - 0.004), radial.z * (R - 0.004));
      const g = box.clone(); g.applyMatrix4(m); list.push(g);
    }
    const out = BGU.mergeGeometries(list, false); list.forEach((g) => g.dispose()); box.dispose(); return out;
  });
}

function buildWheelContent(R, W, ch, q) {
  const root = new THREE.Group();
  const rs = segs(24, q), ri = R * 0.6, h = W / 2;
  mesh(tireGeo(R, W, q), rubber(), root);
  if (q > 0.5) mesh(lugGeo(R, W, q), rubberTread(), root);
  // rim back (recessed dish)
  mesh(cylGeo(ri * 0.98, ri * 0.98, W * 0.8, segs(16, q)), graphite(), root, null, [0, 0, -Math.PI / 2]);
  // chrome lip
  mesh(torusGeo(ri * 0.94, 0.02, 4, segs(14, q)), chrome(), root, V3(h * 0.82, 0, 0), [0, Math.PI / 2, 0]);
  // spokes
  const rimMat = cm('rim|' + ch.accent, () => new THREE.MeshPhysicalMaterial({ color: ch.accent, metalness: 0.7, roughness: 0.28, clearcoat: 0.6 }));
  const spoke = cg(`spoke|${ri}`, () => new THREE.BoxGeometry(0.045, ri * 0.82, 0.065));
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const s = mesh(spoke, rimMat, root, V3(h * 0.46, Math.cos(a) * ri * 0.45, Math.sin(a) * ri * 0.45));
    s.rotation.x = a;
  }
  // hub + cap
  mesh(cylGeo(ri * 0.34, ri * 0.38, 0.07, segs(14, q)), paint(ch.color), root, V3(h * 0.5, 0, 0), [0, 0, -Math.PI / 2]);
  mesh(sphereGeo(ri * 0.22, segs(8, q), segs(5, q)), chrome(), root, V3(h * 0.55, 0, 0), null, V3(0.6, 1, 1));
  return root;
}

/* ------------------------------------------------------------------ */
/* Chassis                                                             */
/* ------------------------------------------------------------------ */
function bodyShape() {
  const s = new THREE.Shape();
  s.moveTo(1.2, 0.17);
  s.quadraticCurveTo(1.28, 0.18, 1.27, 0.3);
  s.quadraticCurveTo(1.26, 0.4, 1.16, 0.4);
  s.lineTo(0.62, 0.55);
  s.quadraticCurveTo(0.5, 0.6, 0.4, 0.58);
  s.quadraticCurveTo(0.3, 0.58, 0.24, 0.44);
  s.lineTo(-0.16, 0.4);
  s.quadraticCurveTo(-0.4, 0.4, -0.4, 0.7);
  s.quadraticCurveTo(-0.5, 0.84, -0.6, 0.7);
  s.quadraticCurveTo(-0.72, 0.62, -0.72, 0.52);
  s.lineTo(-0.98, 0.5);
  s.quadraticCurveTo(-1.06, 0.5, -1.06, 0.38);
  s.lineTo(-1.04, 0.17);
  s.lineTo(1.2, 0.17);
  return s;
}
function podShape() {
  const s = new THREE.Shape();
  s.moveTo(0.42, 0.18);
  s.quadraticCurveTo(0.48, 0.18, 0.48, 0.28);
  s.quadraticCurveTo(0.48, 0.4, 0.38, 0.42);
  s.lineTo(-0.2, 0.5);
  s.quadraticCurveTo(-0.3, 0.5, -0.3, 0.4);
  s.lineTo(-0.3, 0.24);
  s.quadraticCurveTo(-0.3, 0.18, -0.24, 0.18);
  s.lineTo(0.42, 0.18);
  return s;
}
function wingShape() {
  const s = new THREE.Shape();
  s.moveTo(0.16, 0);
  s.quadraticCurveTo(0.17, 0.05, 0.08, 0.055);
  s.quadraticCurveTo(-0.05, 0.055, -0.16, 0.025);
  s.lineTo(-0.16, 0);
  s.quadraticCurveTo(0, -0.025, 0.16, 0);
  return s;
}

function buildChassis(ch, q, refs) {
  const c = new THREE.Group(); c.name = 'chassis';
  const cs = Math.max(3, segs(8, q)), bseg = q > 0.6 ? 3 : 1;
  const P = paint(ch.color), A = paint(ch.accent);

  const tub = cg(`tub|${q}`, () => taperGeo(crease(profileExtrude(bodyShape(), 0.4, 0.14, 0.09, bseg, Math.max(3, cs - 3)), 0.75), bodyTaper));
  mesh(tub, P, c).receiveShadow = true;
  // racing stripes (same profile, sitting just proud of the tub)
  for (const sx of [-1, 1]) {
    const sg = cg(`stripe|${q}|${sx}`, () => { const g = crease(profileExtrude(bodyShape(), 0.07, 0.004, 0.098, 1, Math.max(2, cs - 5)), 0.75); g.translate(sx * 0.12, 0, 0); return taperGeo(g, bodyTaper); });
    mesh(sg, A, c);
  }
  // side pods with intakes and roundels
  const pod = cg(`pod|${q}`, () => crease(profileExtrude(podShape(), 0.14, 0.05, 0.05, q > 0.5 ? 2 : 1, Math.max(2, cs - 4)), 0.8));
  const round = roundelTex(ch.id + 1, ch.accent, ch.color);
  const roundMat = cm('roundel|' + ch.id, () => new THREE.MeshPhysicalMaterial({ map: round, roughness: 0.3, clearcoat: 1, polygonOffset: true, polygonOffsetFactor: -2 }));
  for (const sx of [-1, 1]) {
    mesh(pod, P, c, V3(sx * 0.46, 0, 0)).receiveShadow = true;
    mesh(roundedBoxGeo(0.15, 0.11, 0.06, 0.03), blackGloss(), c, V3(sx * 0.46, 0.31, 0.51));
    mesh(roundedBoxGeo(0.17, 0.025, 0.05, 0.01), A, c, V3(sx * 0.46, 0.385, 0.5));
    const d = mesh(cg('roundelGeo', () => new THREE.CircleGeometry(0.105, 24)), roundMat, c, V3(sx * 0.583, 0.33, 0.07));
    d.rotation.y = sx * Math.PI / 2;
  }
  // floor pan
  const floor = cg(`floor|${q}`, () => {
    const s = new THREE.Shape();
    s.moveTo(-0.44, -1.06); s.lineTo(0.44, -1.06); s.quadraticCurveTo(0.6, -1.0, 0.6, -0.4);
    s.lineTo(0.62, 0.48); s.quadraticCurveTo(0.5, 0.56, 0.34, 0.58); s.lineTo(0.3, 1.2); s.quadraticCurveTo(0, 1.32, -0.3, 1.2);
    s.lineTo(-0.34, 0.58); s.quadraticCurveTo(-0.5, 0.56, -0.62, 0.48); s.lineTo(-0.6, -0.4); s.quadraticCurveTo(-0.6, -1.0, -0.44, -1.06);
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.05, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.015, bevelSegments: 1, curveSegments: cs });
    g.rotateX(Math.PI / 2); g.translate(0, 0.17, 0); return g;
  });
  mesh(floor, carbonMat(), c).receiveShadow = true;

  // front bumper
  const fb = cg(`fbump|${q}`, () => new THREE.TubeGeometry(new THREE.CatmullRomCurve3([V3(-0.52, 0.19, 1.16), V3(-0.44, 0.19, 1.34), V3(0, 0.19, 1.43), V3(0.44, 0.19, 1.34), V3(0.52, 0.19, 1.16)]), segs(16, q), 0.055, segs(7, q)));
  mesh(fb, A, c);
  for (const sx of [-1, 1]) limb(cylGeo(0.03, 0.03, 1, 8), graphite(), c, V3(sx * 0.16, 0.19, 1.25), V3(sx * 0.17, 0.19, 1.4)).scale.y = 0.16;
  for (const sx of [-1, 1]) mesh(sphereGeo(0.056, 7, 4), A, c, V3(sx * 0.52, 0.19, 1.16));
  // rear bumper + diffuser
  const rb = cg(`rbump|${q}`, () => new THREE.TubeGeometry(new THREE.CatmullRomCurve3([V3(-0.78, 0.24, -1.2), V3(-0.62, 0.24, -1.28), V3(0, 0.24, -1.31), V3(0.62, 0.24, -1.28), V3(0.78, 0.24, -1.2)]), segs(14, q), 0.06, segs(6, q)));
  mesh(rb, graphite(), c);
  for (const sx of [-1, 1]) mesh(sphereGeo(0.061, 7, 4), graphite(), c, V3(sx * 0.78, 0.24, -1.2));
  for (const sx of [-1, 1]) limb(cylGeo(0.03, 0.03, 1, 8), darkChrome(), c, V3(sx * 0.2, 0.24, -1.05), V3(sx * 0.2, 0.24, -1.3)).scale.y = 0.25;
  const dif = mesh(roundedBoxGeo(0.56, 0.035, 0.26, 0.012, 1), carbonMat(), c, V3(0, 0.15, -1.13)); dif.rotation.x = 0.32;
  for (let i = -2; i <= 2; i++) if (q > 0.5 || i % 2 === 0) mesh(boxGeo(0.018, 0.09, 0.24), graphite(), c, V3(i * 0.12, 0.13, -1.14), [0.32, 0, 0]);

  // tail lights
  refs.tailMat = glowMat('tail', 0xff1a2a, 1.4, 0x550008);
  for (const sx of [-1, 1]) {
    mesh(roundedBoxGeo(0.17, 0.085, 0.04, 0.02), graphite(), c, V3(sx * 0.17, 0.33, -1.135));
    mesh(roundedBoxGeo(0.14, 0.06, 0.03, 0.02), refs.tailMat, c, V3(sx * 0.17, 0.33, -1.153));
  }
  // headlights
  refs.headMat = glowMat('head', 0xfff2c8, 2.2, 0xffffff);
  for (const sx of [-1, 1]) {
    const hp = V3(sx * 0.13, 0.315, 1.325);
    mesh(cylGeo(0.068, 0.072, 0.07, 10), darkChrome(), c, hp, [Math.PI / 2 - 0.15, 0, 0]);
    const lens = mesh(cg('lens', () => new THREE.SphereGeometry(0.056, 10, 3, 0, Math.PI * 2, 0, Math.PI / 2)), refs.headMat, c, hp.clone().add(V3(0, 0.005, 0.03)));
    lens.rotation.x = Math.PI / 2 - 0.15;
  }
  // number plate on the nose (slope ~0.271 rad)
  const plateMat = cm('plate|' + ch.id, () => new THREE.MeshPhysicalMaterial({ map: plateTex(ch.id + 1, ch.accent), roughness: 0.3, clearcoat: 1, polygonOffset: true, polygonOffsetFactor: -2 }));
  const pl = mesh(cg('plateGeo', () => new THREE.PlaneGeometry(0.34, 0.255)), plateMat, c, V3(0, 0.562, 0.947));
  pl.rotation.x = -(Math.PI / 2 - 0.271);
  pl.castShadow = false;

  // cockpit details: seat, windscreen, steering wheel
  mesh(roundedBoxGeo(0.4, 0.06, 0.3, 0.03), graphite(), c, V3(0, 0.5, -0.2));
  const wsG = new THREE.Group(); wsG.position.set(0, 0.7, 0.1); wsG.rotation.x = -0.38; c.add(wsG);
  const ws = mesh(cg(`ws|${q}`, () => new THREE.CylinderGeometry(0.34, 0.34, 0.17, segs(16, q), 1, true, -0.8, 1.6)), glassMat(), wsG);
  ws.castShadow = false; ws.material.userData.noShadow = true;
  mesh(cg(`wsf|${q}`, () => new THREE.TorusGeometry(0.34, 0.013, 5, segs(16, q), 1.6)), graphite(), wsG, V3(0, 0.085, 0), [Math.PI / 2, 0, Math.PI / 2 - 0.8]);
  const sw = new THREE.Group(); sw.position.set(0, 0.75, 0.2); sw.rotation.x = -0.62; c.add(sw);
  mesh(torusGeo(0.118, 0.024, 6, segs(18, q)), satin(0x1b1d24, 0.6), sw);
  mesh(cylGeo(0.04, 0.045, 0.035, 12), A, sw, null, [Math.PI / 2, 0, 0]);
  for (const a of [Math.PI / 2 * 0, Math.PI, -Math.PI / 2]) {
    const sp = mesh(boxGeo(0.11, 0.022, 0.014), graphite(), sw, V3(Math.cos(a) * 0.06, Math.sin(a) * 0.06, 0)); sp.rotation.z = a;
  }
  limb(cylGeo(0.018, 0.018, 1, 8), graphite(), c, V3(0, 0.62, 0.4), V3(0, 0.75, 0.2)).scale.y = 0.24;
  sw.updateMatrixWorld(true);
  refs.grips = [-1, 1].map((sx) => V3(sx * 0.112 * Math.cos(0.4), 0.112 * Math.sin(0.4), 0.015).applyMatrix4(sw.matrix));

  // engine
  mesh(roundedBoxGeo(0.46, 0.2, 0.3, 0.05, 2), graphite(), c, V3(0, 0.67, -0.86));
  mesh(roundedBoxGeo(0.34, 0.07, 0.22, 0.03), A, c, V3(0, 0.795, -0.86));
  for (let i = 0; i < (q > 0.5 ? 4 : 2); i++) for (const sx of [-1, 1]) mesh(boxGeo(0.03, 0.014, 0.26), darkChrome(), c, V3(sx * 0.235, 0.61 + i * (q > 0.5 ? 0.035 : 0.07), -0.86));
  for (const sx of [-1, 1]) {
    mesh(cylGeo(0.042, 0.03, 0.09, segs(16, q, 6), true), chrome(), c, V3(sx * 0.08, 0.87, -0.86));
    mesh(torusGeo(0.042, 0.009, 3, 9), chrome(), c, V3(sx * 0.08, 0.915, -0.86), [Math.PI / 2, 0, 0]);
  }
  // exhausts (chrome) with flared tips
  refs.exhausts = []; refs.exhaustDirs = [];
  for (const sx of [-1, 1]) {
    const pts = [V3(sx * 0.16, 0.6, -0.96), V3(sx * 0.17, 0.55, -1.1), V3(sx * 0.18, 0.59, -1.26), V3(sx * 0.19, 0.66, -1.36)];
    const curve = new THREE.CatmullRomCurve3(pts);
    mesh(cg(`exh|${sx}|${q}`, () => new THREE.TubeGeometry(curve, segs(12, q), 0.038, segs(8, q))), chrome(), c);
    const dir = curve.getTangent(1).normalize();
    const flare = mesh(cylGeo(0.058, 0.04, 0.1, segs(16, q), true), cm('chromeDS', () => new THREE.MeshStandardMaterial({ color: 0xf2f4f8, metalness: 1, roughness: 0.25, side: THREE.DoubleSide })), c, pts[3].clone().addScaledVector(dir, 0.045));
    flare.quaternion.setFromUnitVectors(AX_Y, dir);
    const soot = mesh(cg('soot', () => new THREE.CircleGeometry(0.045, 10)), satin(0x050505, 0.9), c, pts[3].clone().addScaledVector(dir, 0.03));
    soot.quaternion.setFromUnitVectors(AX_Z, dir);
    refs.exhausts.push(pts[3].clone().addScaledVector(dir, 0.1));
    refs.exhaustDirs.push(dir);
  }
  // rear wing
  const wing = mesh(cg(`wing|${q}`, () => crease(profileExtrude(wingShape(), 1.14, 0.012, 0.012, 1, Math.max(3, cs - 3)), 0.9)), A, c, V3(0, 0.97, -1.13));
  wing.rotation.x = 0.16;
  mesh(boxGeo(1.12, 0.03, 0.03), P, c, V3(0, 1.0, -1.28));
  for (const sx of [-1, 1]) {
    mesh(cg(`endplate|${q}`, () => crease(profileExtrude(roundedRectShape(0.42, 0.27, 0.07), 0.025, 0.01, 0.01, 1, Math.max(3, cs - 4)), 0.9)), P, c, V3(sx * 0.6, 0.95, -1.13));
    const st = mesh(roundedBoxGeo(0.035, 0.42, 0.1, 0.015, 1), graphite(), c, V3(sx * 0.29, 0.75, -1.05)); st.rotation.x = -0.34;
  }
  return c;
}

/* ------------------------------------------------------------------ */
/* Driver                                                              */
/* ------------------------------------------------------------------ */
const HEAD_R = 0.52;
function facePoint(E, x, y) {
  const dx = (x - E.c.x) / E.r.x, dy = (y - E.c.y) / E.r.y;
  const z = E.c.z + E.r.z * Math.sqrt(Math.max(0, 1 - dx * dx - dy * dy));
  const n = V3((x - E.c.x) / (E.r.x * E.r.x), (y - E.c.y) / (E.r.y * E.r.y), (z - E.c.z) / (E.r.z * E.r.z)).normalize();
  return { p: V3(x, y, z), n };
}
function onSurface(obj, parent, sp, push = 0) {
  obj.position.copy(sp.p).addScaledVector(sp.n, push);
  obj.quaternion.setFromUnitVectors(AX_Z, sp.n);
  if (obj.userData.tilt) obj.rotateZ(obj.userData.tilt);
  parent.add(obj); return obj;
}
function faceRimGeo(E, q) {
  return cg(`faceRim|${q}`, () => {
    const pts = [], n = segs(28, q);
    const zE = (x, y) => { const dx = (x - E.c.x) / E.r.x, dy = (y - E.c.y) / E.r.y, k = 1 - dx * dx - dy * dy; return k <= 0 ? -1 : E.c.z + E.r.z * Math.sqrt(k); };
    const zS = (x, y) => Math.sqrt(Math.max(0, HEAD_R * HEAD_R - x * x - y * y));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, dx = Math.cos(a), dy = Math.sin(a);
      let lo = 0, hi = 0.45;
      for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; const x = dx * m, y = E.c.y + dy * m; (zE(x, y) > zS(x, y) ? (lo = m) : (hi = m)); }
      const x = dx * lo, y = E.c.y + dy * lo; pts.push(V3(x, y, zS(x, y)));
    }
    return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), Math.round(n * 1.4), 0.024, 4, true);
  });
}
function cartoonEye(q, side, tilt, scale = 1) {
  const g = new THREE.Group(); const s = segs(12, q), s2 = segs(9, q);
  const u = sphereGeo(1, s, s2), u2 = sphereGeo(1, segs(12, q), segs(8, q)), u3 = sphereGeo(1, q > 0.5 ? 6 : 5, q > 0.5 ? 4 : 3);
  mesh(u, eyeWhite(), g, null, null, V3(0.082 * scale, 0.108 * scale, 0.035));
  mesh(u2, pupilMat(), g, V3(-side * 0.008, -0.01, 0.018), null, V3(0.056 * scale, 0.078 * scale, 0.028));
  mesh(u3, glintMat(), g, V3(side * 0.012 * scale + 0.004, 0.032 * scale, 0.042), null, V3(0.022, 0.026, 0.01));
  mesh(u3, glintMat(), g, V3(-side * 0.012, -0.03 * scale, 0.042), null, V3(0.01, 0.01, 0.006));
  g.userData.tilt = side * tilt;
  return g;
}

function buildHead(ch, q, refs) {
  const head = new THREE.Group(); head.name = 'head';
  const P = paint(ch.color), A = paint(ch.accent);
  const s1 = segs(26, q), s2 = segs(18, q);

  if (ch.head === 'robot') {
    mesh(roundedBoxGeo(0.94, 0.8, 0.84, 0.15, q > 0.6 ? 3 : 2), P, head, V3(0, 0, 0));
    mesh(roundedBoxGeo(0.76, 0.54, 0.06, 0.07), blackGloss(), head, V3(0, -0.01, 0.41));
    const led = refs.ledMat = glowMat('led', ch.led, 2.4, 0x1a4b55);
    refs.glow.push(led);
    for (const sx of [-1, 1]) {
      mesh(roundedBoxGeo(0.12, 0.17, 0.03, 0.05), led, head, V3(sx * 0.16, 0.04, 0.445));
      mesh(roundedBoxGeo(0.07, 0.03, 0.02, 0.012), led, head, V3(sx * 0.16 + sx * 0.01, 0.17, 0.445), [0, 0, -sx * 0.25]);
      // ear bolts
      mesh(cylGeo(0.1, 0.1, 0.06, 18), paint(ch.accent), head, V3(sx * 0.49, 0, 0), [0, 0, Math.PI / 2]);
      mesh(cylGeo(0.05, 0.05, 0.08, 6), chrome(), head, V3(sx * 0.51, 0, 0), [0, 0, Math.PI / 2]);
      // little antenna stubs
      mesh(cylGeo(0.015, 0.015, 0.16, 8), darkChrome(), head, V3(sx * 0.25, 0.47, -0.05));
      mesh(sphereGeo(0.035, 10, 8), led, head, V3(sx * 0.25, 0.56, -0.05));
    }
    // pixel smile
    for (let i = -2; i <= 2; i++) mesh(roundedBoxGeo(0.045, 0.045, 0.02, 0.01, 1), led, head, V3(i * 0.05, -0.16 + Math.abs(i) * Math.abs(i) * 0.012, 0.445));
    // top vent + accent band
    mesh(roundedBoxGeo(0.96, 0.06, 0.86, 0.03), A, head, V3(0, -0.3, 0));
    mesh(roundedBoxGeo(0.3, 0.05, 0.3, 0.02), darkChrome(), head, V3(0, 0.41, -0.05));
    return head;
  }

  if (ch.head === 'dome') {
    mesh(sphereGeo(0.5, s1, s2), P, head);
    const scr = mesh(cg(`screen|${q}`, () => new THREE.SphereGeometry(0.512, s1, segs(12, q), Math.PI / 2 - 1.05, 2.1, 1.0, 1.15)), blackGloss(), head);
    const led = refs.ledMat = glowMat('led', ch.led, 2.6, 0x0b4b4d);
    refs.glow.push(led);
    const E = { c: V3(0, 0, 0), r: V3(0.52, 0.52, 0.52) };
    for (const sx of [-1, 1]) {
      onSurface(mesh(capsuleGeo(0.045, 0.07, 4, 10), led, null), head, facePoint(E, sx * 0.15, 0.04));
      // ear discs
      mesh(cylGeo(0.12, 0.12, 0.08, 20), paint(ch.accent), head, V3(sx * 0.48, 0, 0), [0, 0, Math.PI / 2]);
      mesh(torusGeo(0.1, 0.016, 6, 18), led, head, V3(sx * 0.525, 0, 0), [0, Math.PI / 2, 0]);
    }
    const smile = onSurface(mesh(torusGeo(0.085, 0.016, 6, 16, Math.PI), led, null), head, facePoint(E, 0, -0.12));
    smile.rotateZ(Math.PI);
    // antenna with glowing sphere
    mesh(cylGeo(0.06, 0.08, 0.06, 16), paint(ch.accent), head, V3(0, 0.5, -0.04));
    limb(cylGeo(0.016, 0.016, 1, 8), darkChrome(), head, V3(0, 0.5, -0.04), V3(0, 0.82, -0.12)).scale.y = 0.33;
    const tip = refs.antMat = glowMat('antenna', 0x7dfcff, 3.2, 0x7dfcff);
    refs.glow.push(tip);
    mesh(sphereGeo(0.07, segs(16, q, 6), segs(12, q, 4)), tip, head, V3(0, 0.86, -0.13));
    const halo = mesh(sphereGeo(0.12, 16, 12), haloMat(0x7dfcff), head, V3(0, 0.86, -0.13));
    halo.userData.noMerge = true; halo.castShadow = false;
    // accent band
    mesh(torusGeo(0.49, 0.03, 8, s1), A, head, V3(0, -0.13, 0), [Math.PI / 2, 0, 0]);
    return head;
  }

  // ---- helmeted cartoon heads ----
  mesh(sphereGeo(HEAD_R, s1, s2), P, head);
  const E = { c: V3(0, -0.05, 0.15), r: V3(0.4, 0.36, 0.4) };
  const skinM = satin(ch.skin, 0.55, 0);
  mesh(sphereGeo(1, segs(20, q), segs(14, q)), skinM, head, E.c, null, E.r);
  // smooth rim along the face opening (ellipsoid / helmet intersection)
  mesh(faceRimGeo(E, q), A, head);
  // accent rim around the helmet base
  if (ch.accessory !== 'wizard') mesh(torusGeo(0.43, 0.03, 5, segs(28, q, 8)), A, head, V3(0, -0.29, -0.02), [Math.PI / 2 + 0.25, 0, 0]);
  // visor band (tinted, flipped up)
  if (ch.accessory !== 'wizard') {
    mesh(cg(`visor|${q}`, () => new THREE.SphereGeometry(HEAD_R + 0.016, s1, segs(8, q), Math.PI / 2 - 1.0, 2.0, 0.72, 0.45)), visorMat(), head);
    mesh(cg(`visorRim|${q}`, () => new THREE.TorusGeometry(0.49, 0.022, 4, segs(18, q), 2.0)), A, head, V3(0, 0.21, 0), [Math.PI / 2, 0, Math.PI / 2 - 1.0]);
  }
  const tilt = ch.accessory === 'crest' ? 0.22 : ch.accessory === 'fox' ? 0.12 : 0;
  for (const sx of [-1, 1]) {
    onSurface(cartoonEye(q, sx, tilt, ch.accessory === 'bear' ? 0.9 : 1), head, facePoint(E, sx * 0.135, -0.015), -0.012);
    if (ch.accessory !== 'bear') onSurface(mesh(sphereGeo(1, 8, 4), blushMat(), null, null, null, V3(0.05, 0.03, 0.012)), head, facePoint(E, sx * 0.235, -0.14));
  }
  if (ch.accessory === 'bear') {
    const muzzleM = satin(ch.muzzle, 0.6, 0);
    onSurface(mesh(sphereGeo(1, 18, 12), muzzleM, null, null, null, V3(0.15, 0.1, 0.08)), head, facePoint(E, 0, -0.17), -0.035);
    onSurface(mesh(sphereGeo(1, 14, 10), blackGloss(), null, null, null, V3(0.055, 0.038, 0.035)), head, facePoint(E, 0, -0.12), 0.03);
    const m = onSurface(mesh(torusGeo(0.04, 0.01, 6, 12, Math.PI), mouthMat(), null), head, facePoint(E, 0, -0.22), 0.035); m.rotateZ(Math.PI);
  } else if (ch.accessory === 'cat') {
    onSurface(mesh(coneGeo(0.03, 0.03, 3), blushMat(), null, null, null, V3(1, 1, 0.6)), head, facePoint(E, 0, -0.1), 0.005).rotateZ(Math.PI);
    for (const sx of [-1, 1]) {
      const m = onSurface(mesh(torusGeo(0.026, 0.008, 5, 10, Math.PI), mouthMat(), null), head, facePoint(E, sx * 0.026, -0.155)); m.rotateZ(Math.PI);
      for (let k = -1; k <= 1; k++) {
        const a = facePoint(E, sx * 0.17, -0.12 + k * 0.025).p.addScaledVector(V3(0, 0, 1), 0.005);
        limb(cylGeo(0.005, 0.005, 1, 4), satin(0x30333d, 0.5), head, a, a.clone().add(V3(sx * 0.2, k * 0.05 + 0.01, -0.02))).scale.y = 0.2;
      }
    }
  } else {
    const m = onSurface(mesh(torusGeo(0.05, 0.012, 5, 10, Math.PI), mouthMat(), null), head, facePoint(E, 0, -0.17)); m.rotateZ(Math.PI);
  }

  const ears = (geo, inner, outerM, innerM, x, y, z, tiltZ, tiltX = -0.1) => {
    for (const sx of [-1, 1]) {
      const e = new THREE.Group(); e.position.set(sx * x, y, z); e.rotation.set(tiltX, 0, -sx * tiltZ); head.add(e);
      mesh(geo, outerM, e, null, null, V3(1, 1, 0.55));
      if (inner) mesh(inner, innerM, e, V3(0, -0.02, 0.04), null, V3(1, 1, 0.35));
    }
  };
  switch (ch.accessory) {
    case 'fox': {
      ears(coneGeo(0.17, 0.4, segs(14, q)), coneGeo(0.1, 0.26, 10), P, satin(0xfff0d8, 0.6), 0.27, 0.48, -0.04, 0.42);
      for (const sx of [-1, 1]) {
        const b = mesh(cg('bolt', () => new THREE.ExtrudeGeometry(boltShape(1.2), { depth: 0.02, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 1 })), A, head, V3(sx * 0.505, 0.02, -0.07));
        b.rotation.y = sx * Math.PI / 2;
      }
      break;
    }
    case 'star': {
      mesh(sphereGeo(0.06, 14, 10), A, head, V3(0, 0.5, -0.06));
      limb(cylGeo(0.016, 0.016, 1, 8), darkChrome(), head, V3(0, 0.5, -0.06), V3(0, 0.82, -0.16)).scale.y = 0.34;
      const sm = refs.starMat = glowMat('star', 0xffcf3a, 1.6, 0xffd84a); refs.glow.push(sm);
      const star = mesh(cg('star3d', () => { const g = new THREE.ExtrudeGeometry(starShape(0.13, 0.06), { depth: 0.035, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.012, bevelSegments: 2 }); g.translate(0, 0, -0.0175); return g; }), sm, head, V3(0, 0.9, -0.18));
      star.rotation.x = -0.3;
      for (const sx of [-1, 1]) { const st = mesh(cg('starDecal', () => new THREE.ExtrudeGeometry(starShape(0.07, 0.032), { depth: 0.02, bevelEnabled: false })), paint(0xffd84a), head, V3(sx * 0.508, 0.0, -0.08)); st.rotation.y = sx * Math.PI / 2; }
      break;
    }
    case 'bear': {
      const fur = satin(ch.skin, 0.7), inner = satin(ch.muzzle, 0.7);
      for (const sx of [-1, 1]) {
        const e = new THREE.Group(); e.position.set(sx * 0.33, 0.39, -0.06); e.rotation.z = -sx * 0.6; head.add(e);
        mesh(sphereGeo(0.15, 18, 12), fur, e, null, null, V3(1, 1, 0.55));
        mesh(sphereGeo(0.09, 14, 10), inner, e, V3(0, 0, 0.05), null, V3(1, 1, 0.4));
      }
      break;
    }
    case 'cat':
      ears(coneGeo(0.15, 0.34, segs(14, q)), coneGeo(0.085, 0.22, 10), P, blushMat(), 0.27, 0.45, -0.02, 0.32);
      break;
    case 'wizard': {
      const hatM = paint(ch.color === 0x8b45ff ? 0x5a2ad0 : ch.color);
      const bend = (t) => 0.32 * t * t * t;
      const hat = cg(`hat|${q}`, () => {
        const pts = []; const n = segs(12, q) + 2;
        for (let i = 0; i <= n; i++) { const t = i / n; pts.push(V2(0.44 * Math.pow(1 - t, 1.25) + 0.001, t * 0.9)); }
        const g = new THREE.LatheGeometry(pts, segs(24, q));
        const p = g.attributes.position; for (let i = 0; i < p.count; i++) { const t = p.getY(i) / 0.9; p.setZ(i, p.getZ(i) - bend(t)); }
        g.computeVertexNormals(); return g;
      });
      const hg = new THREE.Group(); hg.position.set(0, 0.28, -0.03); hg.rotation.x = -0.12; head.add(hg);
      mesh(hat, hatM, hg);
      mesh(cylGeo(0.68, 0.68, 0.035, segs(32, q)), hatM, hg);
      mesh(torusGeo(0.68, 0.025, 6, segs(32, q)), A, hg, null, [Math.PI / 2, 0, 0]);
      mesh(cylGeo(0.415, 0.44, 0.09, segs(24, q), true), A, hg, V3(0, 0.06, 0));
      const sm = refs.starMat = glowMat('star', 0xffd34a, 1.4, 0xffd84a); refs.glow.push(sm);
      const sg = cg('hatStar', () => new THREE.ExtrudeGeometry(starShape(0.06, 0.027), { depth: 0.015, bevelEnabled: false }));
      for (const [t, a, s] of [[0.32, 0.3, 1], [0.55, -0.6, 0.8], [0.2, -1.1, 0.7], [0.75, 0.9, 0.6]]) {
        const r = 0.44 * Math.pow(1 - t, 1.25) + 0.005;
        const st = mesh(sg, sm, hg, V3(Math.sin(a) * r, t * 0.9, Math.cos(a) * r - bend(t)), null, s);
        st.rotation.y = a; st.rotation.x = -0.35;
      }
      mesh(sphereGeo(0.05, 12, 8), sm, hg, V3(0, 0.9, -bend(1)));
      // beard
      mesh(coneGeo(0.17, 0.3, 16), satin(0xf4f1ea, 0.8), head, V3(0, -0.4, 0.33), [Math.PI + 0.5, 0, 0]);
      break;
    }
    case 'crest': {
      const fin = cg(`fin|${q}`, () => {
        const s = new THREE.Shape();
        s.moveTo(0.33, 0.28); s.quadraticCurveTo(0.26, 0.64, -0.04, 0.76); s.lineTo(-0.44, 0.74);
        s.quadraticCurveTo(-0.58, 0.6, -0.42, 0.2); s.quadraticCurveTo(0, 0.3, 0.33, 0.28);
        return crease(profileExtrude(s, 0.05, 0.02, 0.02, 2, segs(6, q)), 0.9);
      });
      mesh(fin, A, head);
      const rr = Math.sqrt(HEAD_R * HEAD_R - 0.12 * 0.12) + 0.004;
      for (const sx of [-1, 1]) mesh(torusGeo(rr, 0.022, 5, s1, Math.PI * 0.9), paint(0xffffff), head, V3(sx * 0.12, 0, 0), [0, Math.PI / 2, -Math.PI * 0.1]);
      break;
    }
  }
  return head;
}

function haloMat(color) {
  return cm('halo|' + color, () => {
    const m = fresnelMaterial(color, 1.0, 1.4, null);
    m.userData.noShadow = true; return m;
  });
}

function buildDriver(ch, q, refs) {
  const D = new THREE.Group(); D.name = 'driver'; D.position.set(0, 0.45, -0.2);
  const head = buildHead(ch, q, refs);
  head.position.set(0, 0.91, 0);
  D.add(head);
  const heavy = ch.accessory === 'bear' ? 1.22 : ch.head === 'dome' ? 1.1 : 1;
  const suit = ch.head === 'robot' || ch.head === 'dome' ? satin(ch.suit, 0.4, 0.6) : satin(ch.suit, 0.55, 0.05);
  const A = paint(ch.accent), glove = satin(ch.glove, 0.6, 0);
  const torso = mesh(capsuleGeo(0.19, 0.16, segs(4, q), segs(14, q)), suit, D, V3(0, 0.24, 0.0), [0.15, 0, 0], V3(heavy, 1, heavy));
  void torso;
  mesh(torusGeo(0.15, 0.04, 4, segs(18, q, 8)), A, D, V3(0, 0.43, 0.02), [Math.PI / 2 + 0.15, 0, 0]);
  // chest emblem / core
  if (ch.head === 'dome') {
    const core = refs.coreMat = glowMat('core', 0x8afcff, 3, 0x8afcff); refs.glow.push(core);
    mesh(sphereGeo(0.065, segs(16, q, 6), segs(12, q, 4)), core, D, V3(0, 0.27, 0.19 * heavy + 0.02));
    mesh(torusGeo(0.08, 0.018, 6, 18), chrome(), D, V3(0, 0.27, 0.19 * heavy + 0.02), [-0.15, 0, 0]);
    const h = mesh(sphereGeo(0.11, segs(14, q, 6), segs(10, q, 4)), haloMat(0x8afcff), D, V3(0, 0.27, 0.19 * heavy + 0.04)); h.userData.noMerge = true; h.castShadow = false;
  } else if (ch.head === 'robot') {
    mesh(roundedBoxGeo(0.2, 0.12, 0.04, 0.02), graphite(), D, V3(0, 0.25, 0.2));
    for (let i = 0; i < 3; i++) mesh(sphereGeo(0.018, 8, 6), [paint(0xff4d4d), paint(0xffd23a), refs.ledMat || paint(0x5ffcff)][i], D, V3(-0.05 + i * 0.05, 0.25, 0.225));
  } else {
    const em = mesh(roundedBoxGeo(0.14, 0.14, 0.03, 0.05), A, D, V3(0, 0.27, 0.19 * heavy + 0.005));
    em.rotation.x = 0.15;
    mesh(boxGeo(0.06, 0.3, 0.02), satin(0x1b1d24, 0.6), D, V3(-0.1, 0.24, 0.17 * heavy + 0.02), [0.15, 0, 0.05]);
    mesh(boxGeo(0.06, 0.3, 0.02), satin(0x1b1d24, 0.6), D, V3(0.1, 0.24, 0.17 * heavy + 0.02), [0.15, 0, -0.05]);
  }
  // arms reaching the wheel
  const armR = 0.062 * heavy;
  const armG = capsuleGeo(armR, 1, q > 0.5 ? 3 : 2, segs(9, q, 5));
  for (let i = 0; i < 2; i++) {
    const sx = i ? 1 : -1;
    const sh = V3(sx * 0.21 * heavy, 0.38, 0.02);
    const hand = refs.grips[i].clone().sub(D.position);
    const elbow = V3(sx * 0.3 * heavy, 0.24, 0.2);
    mesh(sphereGeo(0.085 * heavy, 7, 4), suit, D, sh);
    const u = limb(armG, suit, D, sh, elbow); u.scale.y = 1 / 1; u.scale.set(1, (sh.distanceTo(elbow)) / (1 + 2 * armR), 1);
    const f = limb(armG, suit, D, elbow, hand); f.scale.set(1, elbow.distanceTo(hand) / (1 + 2 * armR), 1);
    mesh(sphereGeo(0.072 * heavy, 7, 4), suit, D, elbow, null, 0.9);
    // glove + cuff
    mesh(sphereGeo(0.07 * Math.sqrt(heavy), segs(14, q, 7), segs(10, q, 5)), glove, D, hand, null, V3(1, 0.9, 1.1));
    const cuffPos = hand.clone().lerp(elbow, 0.22);
    limb(cylGeo(0.065 * heavy, 0.06 * heavy, 1, segs(14, q, 6)), glove, D, cuffPos, hand.clone().lerp(elbow, 0.12)).scale.y = elbow.distanceTo(hand) * 0.1;
  }
  return { D, head };
}

/* ------------------------------------------------------------------ */
/* Boost flames                                                        */
/* ------------------------------------------------------------------ */
function flameGeo(r, h, seg, core) {
  return cg(`flame|${r}|${h}|${seg}|${core}`, () => {
    const g = new THREE.ConeGeometry(r, h, seg, 4, true);
    const p = g.attributes.position, col = new Float32Array(p.count * 3);
    const blue = new THREE.Color(0.55, 0.75, 1.0), orange = new THREE.Color(1.0, 0.48, 0.08), white = new THREE.Color(1, 1, 1), tmp = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      const t = Math.min(1, Math.max(0, (p.getY(i) + h / 2) / h)); // 0 base .. 1 tip (clamped: pow of a tiny negative is NaN)
      if (core) tmp.copy(white).lerp(blue, smooth(t * 1.6)).multiplyScalar(Math.pow(1 - t, 0.8) * 1.4);
      else tmp.copy(blue).lerp(orange, smooth(t * 2.6)).multiplyScalar(Math.pow(1 - t, 1.3) * 1.2);
      col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.rotateX(-Math.PI / 2); g.translate(0, 0, -h / 2);
    return g;
  });
}

/* ------------------------------------------------------------------ */
/* Public: buildKart                                                   */
/* ------------------------------------------------------------------ */
export function buildKart(characterId, opts = { quality: 'high' }) {
  const ch = CHARACTERS[((characterId | 0) % CHARACTERS.length + CHARACTERS.length) % CHARACTERS.length];
  const quality = (opts && opts.quality) || 'high';
  const q = quality === 'low' ? 0.32 : 0.66;
  const tag = `${ch.id}|${quality}`;
  const refs = { glow: [] };

  const group = new THREE.Group(); group.name = 'kart_' + ch.name;
  const body = new THREE.Group(); body.name = 'body'; group.add(body);

  const chassis = buildChassis(ch, q, refs);
  body.add(chassis);
  const { D: driver, head } = buildDriver(ch, q, refs);
  body.add(driver);

  // flames
  const boostFlames = [];
  refs.exhausts.forEach((tip, i) => {
    const fm = own('flame', new THREE.MeshBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
    const outer = new THREE.Mesh(flameGeo(0.085, 0.75, segs(14, q), false), fm);
    const inner = new THREE.Mesh(flameGeo(0.045, 0.4, segs(10, q), true), fm);
    outer.add(inner);
    outer.position.copy(tip); outer.quaternion.setFromUnitVectors(V3(0, 0, -1), refs.exhaustDirs[i]);
    outer.visible = false; outer.userData.noMerge = true; outer.renderOrder = 10; outer.frustumCulled = false;
    body.add(outer); boostFlames.push(outer);
  });

  // running gear (not part of body so suspension pitch/roll doesn't move wheels)
  const gear = new THREE.Group(); gear.name = 'gear'; group.add(gear);
  const RR = 0.36, RW = 0.34, FR = 0.28, FW = 0.26;
  const rear = { z: -0.8, x: 0.67 }, front = { z: 0.86, x: 0.62 };
  const axleBar = mesh(cylGeo(0.035, 0.035, rear.x * 2 - 0.1, 10), darkChrome(), gear, V3(0, RR, rear.z), [0, 0, Math.PI / 2]);
  void axleBar;
  for (const sx of [-1, 1]) {
    mesh(cylGeo(0.03, 0.03, 0.34, 10), darkChrome(), gear, V3(sx * (front.x - 0.2), FR, front.z), [0, 0, Math.PI / 2]);
    mesh(roundedBoxGeo(0.05, 0.05, 0.24, 0.02, 1), graphite(), gear, V3(sx * (front.x - 0.32), FR + 0.02, front.z - 0.1), [0, sx * 0.4, 0]);
  }
  const wheelTemplate = (front, sx) => {
    const R = front ? FR : RR, W = front ? FW : RW;
    const wheel = new THREE.Object3D(); wheel.name = 'wheel';
    const flip = buildWheelContent(R, W, ch, q);
    if (sx < 0) flip.rotation.y = Math.PI;
    wheel.add(flip);
    mergeStatic(flip, `wheel|${front}|${tag}`);
    return wheel;
  };
  const steerFL = new THREE.Object3D(); steerFL.name = 'steerFL'; steerFL.position.set(front.x, FR, front.z);
  const steerFR = new THREE.Object3D(); steerFR.name = 'steerFR'; steerFR.position.set(-front.x, FR, front.z);
  gear.add(steerFL, steerFR);
  const fl = wheelTemplate(true, 1), fr = wheelTemplate(true, -1), rl = wheelTemplate(false, 1), rr = wheelTemplate(false, -1);
  steerFL.add(fl); steerFR.add(fr);
  for (const o of [steerFL, steerFR, fl, fr, rl, rr]) o.userData.noMerge = true;
  rl.position.set(rear.x, RR, rear.z); rr.position.set(-rear.x, RR, rear.z);
  gear.add(rl, rr);

  // merge static parts per material
  mergeStatic(chassis, `chassis|${tag}`, true);
  mergeStatic(head, `head|${tag}`);
  head.userData.noMerge = true;
  mergeStatic(driver, `driver|${tag}`);
  mergeStatic(gear, `gear|${tag}`);

  refs.glow.push(refs.headMat, refs.tailMat);
  const shadowCasters = [];
  group.traverse((o) => {
    if (o.isMesh) {
      if (o.material.blending === THREE.AdditiveBlending || o.material.userData.noShadow) { o.castShadow = false; return; }
      o.castShadow = true; shadowCasters.push(o);
    }
  });
  body.traverse((o) => { if (o.isMesh && !o.material.transparent) o.receiveShadow = true; });

  const tail = refs.tailMat;
  group.userData = {
    characterId: ch.id, character: ch, quality,
    body, driver, head, chassis,
    wheels: { fl, fr, rl, rr }, steerFL, steerFR,
    exhausts: refs.exhausts.map((v) => v.clone()),
    exhaustDirs: refs.exhaustDirs.map((v) => v.clone()),
    driftSparkPoints: [V3(rear.x, 0.02, rear.z), V3(-rear.x, 0.02, rear.z)],
    boostFlames,
    shadowCasters,
    glowMaterials: refs.glow.filter(Boolean),
    headlightMaterial: refs.headMat, tailLightMaterial: tail,
    wheelRadius: { front: FR, rear: RR },
    setBrake(on) {
      tail.emissiveIntensity = on ? 6 : 1.4;
      tail.color.setHex(on ? 0xff3344 : 0x550008);
    },
  };
  return group;
}

/* ------------------------------------------------------------------ */
/* Shared fresnel shader                                               */
/* ------------------------------------------------------------------ */
function fresnelMaterial(color, power = 2.2, intensity = 1, hexTex = null) {
  return new THREE.ShaderMaterial({
    uniforms: {
      color: { value: new THREE.Color(color) }, power: { value: power }, intensity: { value: intensity },
      time: { value: 0 }, opacity: { value: 1 }, hexTex: { value: hexTex }, useHex: { value: hexTex ? 1 : 0 },
    },
    vertexShader: `varying vec3 vN; varying vec3 vV; varying vec2 vUv;
      void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `uniform vec3 color; uniform float power; uniform float intensity; uniform float time; uniform float opacity; uniform sampler2D hexTex; uniform float useHex;
      varying vec3 vN; varying vec3 vV; varying vec2 vUv;
      void main(){
        float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), power);
        float a = f;
        if (useHex > 0.5) {
          float hx = texture2D(hexTex, vUv * vec2(14.0, 4.0)).r;
          float sweep = 0.5 + 0.5 * sin(vUv.y * 18.0 - time * 3.0);
          a = f * 0.95 + hx * (0.12 + 0.55 * f) * (0.6 + 0.4 * sweep) + 0.04;
        }
        a *= intensity * opacity;
        gl_FragColor = vec4(color * a, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.FrontSide,
  });
}

/* ------------------------------------------------------------------ */
/* Item icons (2D HUD)                                                 */
/* ------------------------------------------------------------------ */
function glossyBall(ctx, x, y, r, c0, c1, c2, outline) {
  const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
  g.addColorStop(0, c0); g.addColorStop(0.45, c1); g.addColorStop(1, c2);
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  ctx.lineWidth = 4; ctx.strokeStyle = outline; ctx.stroke();
  // rim light
  ctx.save(); ctx.beginPath(); ctx.arc(x, y, r - 3, 0.2 * Math.PI, 0.8 * Math.PI); ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 3; ctx.stroke(); ctx.restore();
  // specular
  const s = ctx.createRadialGradient(x - r * 0.35, y - r * 0.45, 0, x - r * 0.35, y - r * 0.45, r * 0.55);
  s.addColorStop(0, 'rgba(255,255,255,0.95)'); s.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = s; ctx.beginPath(); ctx.ellipse(x - r * 0.32, y - r * 0.42, r * 0.5, r * 0.32, -0.6, 0, Math.PI * 2); ctx.fill();
}
function boltPath(ctx, x, y, k) {
  const p = [[6, -34], [-16, 4], [-2, 4], [-9, 34], [17, -8], [3, -8], [12, -34]];
  ctx.beginPath(); p.forEach(([px, py], i) => (i ? ctx.lineTo(x + px * k, y + py * k) : ctx.moveTo(x + px * k, y + py * k))); ctx.closePath();
}
function drawCell(ctx, x, y, k, rot) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(k, k);
  ctx.shadowColor = 'rgba(255,190,0,0.9)'; ctx.shadowBlur = 18;
  const body = ctx.createLinearGradient(-20, 0, 20, 0);
  body.addColorStop(0, '#ff7a00'); body.addColorStop(0.35, '#ffe45c'); body.addColorStop(0.6, '#ffb000'); body.addColorStop(1, '#d95b00');
  rrPath(ctx, -20, -34, 40, 70, 13); ctx.fillStyle = body; ctx.fill(); ctx.shadowBlur = 0;
  ctx.lineWidth = 4; ctx.strokeStyle = '#3d1a00'; ctx.stroke();
  // metal caps
  for (const [cy, h] of [[-34, 12], [24, 12]]) {
    const mg = ctx.createLinearGradient(-20, 0, 20, 0); mg.addColorStop(0, '#6b7280'); mg.addColorStop(0.4, '#f5f7fa'); mg.addColorStop(1, '#4b5260');
    ctx.save(); rrPath(ctx, -20, -34, 40, 70, 13); ctx.clip(); ctx.fillStyle = mg; ctx.fillRect(-22, cy, 44, h); ctx.restore();
  }
  rrPath(ctx, -8, -42, 16, 9, 3); const tg = ctx.createLinearGradient(-8, 0, 8, 0); tg.addColorStop(0, '#7b828f'); tg.addColorStop(0.5, '#ffffff'); tg.addColorStop(1, '#5a606c');
  ctx.fillStyle = tg; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = '#3d1a00'; ctx.stroke();
  rrPath(ctx, -20, -34, 40, 70, 13); ctx.lineWidth = 4; ctx.strokeStyle = '#3d1a00'; ctx.stroke();
  // bolt
  ctx.shadowColor = '#fffbe0'; ctx.shadowBlur = 10;
  boltPath(ctx, 0, 1, 0.62); ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.shadowBlur = 0; ctx.lineWidth = 2.5; ctx.strokeStyle = '#b34700'; ctx.stroke();
  // glass highlight
  rrPath(ctx, -14, -20, 6, 40, 3); ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.fill();
  ctx.restore();
}
function starPath(ctx, x, y, ro, ri, n = 5, rot = -Math.PI / 2) {
  ctx.beginPath();
  for (let i = 0; i < n * 2; i++) { const a = rot + (i * Math.PI) / n, r = i % 2 ? ri : ro; const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
  ctx.closePath();
}
function sparkle(ctx, x, y, r, color = '#ffffff') {
  ctx.save(); ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 8;
  ctx.beginPath(); ctx.moveTo(x, y - r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.quadraticCurveTo(x, y, x, y + r); ctx.quadraticCurveTo(x, y, x - r, y); ctx.quadraticCurveTo(x, y, x, y - r); ctx.fill(); ctx.restore();
}

const ICONS = {
  turbo(ctx) { drawCell(ctx, 64, 66, 1.05, 0.18); sparkle(ctx, 98, 30, 9); sparkle(ctx, 28, 98, 6); },
  triple(ctx) { drawCell(ctx, 34, 74, 0.68, -0.3); drawCell(ctx, 94, 74, 0.68, 0.3); drawCell(ctx, 64, 58, 0.74, 0); sparkle(ctx, 106, 26, 7); },
  orb(ctx) {
    ctx.save(); ctx.translate(64, 66);
    const ring = (front) => { ctx.save(); ctx.rotate(-0.35); ctx.beginPath(); ctx.ellipse(0, 0, 54, 15, 0, front ? 0 : Math.PI, front ? Math.PI : Math.PI * 2); ctx.lineWidth = 9; ctx.strokeStyle = '#0a4a14'; ctx.stroke(); ctx.lineWidth = 5; ctx.strokeStyle = '#b8ff6a'; ctx.stroke(); ctx.restore(); };
    ring(false);
    ctx.shadowColor = 'rgba(80,255,80,0.9)'; ctx.shadowBlur = 20; glossyBall(ctx, 0, 0, 36, '#e7ffc4', '#3fe03a', '#0a6b1d', '#053d10'); ctx.shadowBlur = 0;
    ring(true);
    ctx.restore();
    ctx.strokeStyle = 'rgba(190,255,140,0.8)'; ctx.lineWidth = 4; ctx.lineCap = 'round';
    for (const [x1, y1, x2] of [[8, 50, 20], [4, 66, 16], [10, 82, 22]]) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y1); ctx.stroke(); }
  },
  seeker(ctx) {
    ctx.save(); ctx.translate(64, 64);
    ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 4; ctx.setLineDash([10, 7]); ctx.beginPath(); ctx.arc(0, 0, 54, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    ctx.lineWidth = 5; ctx.lineCap = 'round';
    for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + Math.PI / 4; ctx.beginPath(); ctx.moveTo(Math.cos(a) * 46, Math.sin(a) * 46); ctx.lineTo(Math.cos(a) * 60, Math.sin(a) * 60); ctx.stroke(); }
    ctx.shadowColor = 'rgba(255,40,40,0.9)'; ctx.shadowBlur = 20; glossyBall(ctx, 0, 0, 36, '#ffd0c4', '#ff2a2a', '#6b0000', '#3d0000'); ctx.shadowBlur = 0;
    // eye
    ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.ellipse(4, 4, 17, 14, 0, 0, Math.PI * 2); ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = '#3d0000'; ctx.stroke();
    const ig = ctx.createRadialGradient(8, 6, 1, 8, 6, 9); ig.addColorStop(0, '#ffef5a'); ig.addColorStop(1, '#c40000');
    ctx.fillStyle = ig; ctx.beginPath(); ctx.arc(8, 6, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#120000'; ctx.beginPath(); ctx.arc(8, 6, 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(11, 2, 2.5, 0, Math.PI * 2); ctx.fill();
    // angry brow
    ctx.strokeStyle = '#3d0000'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(-14, -14); ctx.lineTo(20, -8); ctx.stroke();
    ctx.restore();
  },
  slick(ctx) {
    const blob = () => { ctx.beginPath(); const n = 14; for (let i = 0; i <= n; i++) { const a = (i / n) * Math.PI * 2; const r = 48 + Math.sin(a * 3 + 1) * 6 + Math.cos(a * 5) * 4; const x = 64 + Math.cos(a) * r, y = 74 + Math.sin(a) * r * 0.55; i ? ctx.quadraticCurveTo(64 + Math.cos(a - 0.22) * (r + 4), 74 + Math.sin(a - 0.22) * (r + 4) * 0.55, x, y) : ctx.moveTo(x, y); } ctx.closePath(); };
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 4; blob(); ctx.fillStyle = '#07070a'; ctx.fill(); ctx.restore();
    ctx.save(); blob(); ctx.clip();
    const bg = ctx.createRadialGradient(56, 66, 4, 64, 74, 56); bg.addColorStop(0, '#2a2a34'); bg.addColorStop(1, '#050507'); ctx.fillStyle = bg; ctx.fillRect(0, 0, 128, 128);
    ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = 0.75;
    const rb = ctx.createLinearGradient(20, 50, 108, 96);
    ['#ff3b6b', '#ffb83b', '#f6ff4a', '#3bff8a', '#3bc8ff', '#8a5bff', '#ff4ad8'].forEach((c, i, a) => rb.addColorStop(i / (a.length - 1), c));
    ctx.strokeStyle = rb; ctx.lineWidth = 7;
    for (let k = 0; k < 3; k++) { ctx.beginPath(); ctx.ellipse(60 + k * 4, 72, 34 - k * 10, 14 - k * 4, -0.15, 0, Math.PI * 2); ctx.stroke(); }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.beginPath(); ctx.ellipse(44, 62, 12, 4, -0.2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    blob(); ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.stroke();
    // drop
    ctx.save(); ctx.translate(96, 26); ctx.beginPath(); ctx.moveTo(0, -16); ctx.bezierCurveTo(10, -2, 12, 6, 0, 12); ctx.bezierCurveTo(-12, 6, -10, -2, 0, -16); ctx.fillStyle = '#0a0a10'; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.stroke();
    ctx.fillStyle = 'rgba(140,200,255,0.9)'; ctx.beginPath(); ctx.ellipse(-3, 2, 2.5, 5, 0.3, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  },
  shield(ctx) {
    const hex = (r) => { ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; const x = 64 + Math.cos(a) * r, y = 64 + Math.sin(a) * r; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.closePath(); };
    ctx.save(); ctx.shadowColor = 'rgba(60,170,255,0.95)'; ctx.shadowBlur = 22; hex(54);
    const g = ctx.createRadialGradient(54, 50, 6, 64, 64, 58); g.addColorStop(0, 'rgba(210,240,255,0.9)'); g.addColorStop(0.5, 'rgba(70,160,255,0.75)'); g.addColorStop(1, 'rgba(20,70,220,0.95)');
    ctx.fillStyle = g; ctx.fill(); ctx.restore();
    ctx.save(); hex(54); ctx.clip(); ctx.strokeStyle = 'rgba(220,245,255,0.45)'; ctx.lineWidth = 2;
    const R = 10, w = Math.sqrt(3) * R;
    for (let row = -1; row < 10; row++) for (let col = -1; col < 10; col++) {
      const cx = col * w + (row % 2 ? w / 2 : 0), cy = row * R * 1.5;
      ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; const x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.closePath(); ctx.stroke();
    }
    const hl = ctx.createLinearGradient(0, 10, 0, 64); hl.addColorStop(0, 'rgba(255,255,255,0.7)'); hl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hl; ctx.beginPath(); ctx.ellipse(56, 34, 34, 18, -0.3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    hex(54); ctx.lineWidth = 5; ctx.strokeStyle = '#0b2f8a'; ctx.stroke(); hex(50); ctx.lineWidth = 2.5; ctx.strokeStyle = '#d4f0ff'; ctx.stroke();
    sparkle(ctx, 90, 36, 8);
  },
  bomb(ctx) {
    glossyBall(ctx, 58, 74, 40, '#7d8094', '#262833', '#000000', '#000000');
    ctx.save(); ctx.translate(86, 44); ctx.rotate(0.75); rrPath(ctx, -12, -10, 24, 18, 4);
    const cg2 = ctx.createLinearGradient(-12, 0, 12, 0); cg2.addColorStop(0, '#5b606c'); cg2.addColorStop(0.5, '#e8ecf2'); cg2.addColorStop(1, '#474b55');
    ctx.fillStyle = cg2; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = '#000'; ctx.stroke(); ctx.restore();
    ctx.lineCap = 'round'; ctx.lineWidth = 7; ctx.strokeStyle = '#3a2410'; ctx.beginPath(); ctx.moveTo(92, 38); ctx.bezierCurveTo(100, 22, 112, 30, 108, 18); ctx.stroke();
    ctx.lineWidth = 4; ctx.strokeStyle = '#c99a5b'; ctx.stroke();
    ctx.save(); ctx.shadowColor = '#ffb400'; ctx.shadowBlur = 16;
    starPath(ctx, 108, 16, 14, 5, 8, 0.2); const sg = ctx.createRadialGradient(108, 16, 0, 108, 16, 14); sg.addColorStop(0, '#ffffff'); sg.addColorStop(0.4, '#fff06a'); sg.addColorStop(1, '#ff6a00');
    ctx.fillStyle = sg; ctx.fill(); ctx.restore();
    for (const [x, y] of [[96, 8], [122, 26], [118, 4]]) { ctx.fillStyle = '#ffd23a'; ctx.beginPath(); ctx.arc(x, y, 2, 0, 7); ctx.fill(); }
  },
  mega(ctx) {
    ctx.save(); ctx.translate(64, 64);
    for (let i = 0; i < 16; i++) { ctx.rotate(Math.PI / 8); ctx.beginPath(); ctx.moveTo(-5, 0); ctx.lineTo(0, -62); ctx.lineTo(5, 0); ctx.fillStyle = i % 2 ? 'rgba(255,220,90,0.55)' : 'rgba(255,170,30,0.4)'; ctx.fill(); }
    ctx.restore();
    ctx.save(); ctx.shadowColor = 'rgba(255,200,0,1)'; ctx.shadowBlur = 22;
    starPath(ctx, 64, 67, 50, 22); const g = ctx.createRadialGradient(56, 54, 4, 64, 67, 52); g.addColorStop(0, '#fffbd6'); g.addColorStop(0.45, '#ffd21a'); g.addColorStop(1, '#e07800');
    ctx.fillStyle = g; ctx.fill(); ctx.restore();
    starPath(ctx, 64, 67, 50, 22); ctx.lineJoin = 'round'; ctx.lineWidth = 4.5; ctx.strokeStyle = '#7a3d00'; ctx.stroke();
    starPath(ctx, 64, 67, 30, 13); ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.beginPath(); ctx.ellipse(52, 44, 8, 4, -0.7, 0, Math.PI * 2); ctx.fill();
    sparkle(ctx, 104, 22, 9); sparkle(ctx, 22, 30, 6); sparkle(ctx, 106, 104, 5);
  },
  storm(ctx) {
    ctx.save(); ctx.shadowColor = 'rgba(255,230,60,0.95)'; ctx.shadowBlur = 16;
    boltPath(ctx, 66, 92, 0.95); const bg = ctx.createLinearGradient(50, 60, 80, 124); bg.addColorStop(0, '#fffbd0'); bg.addColorStop(1, '#ffc400');
    ctx.fillStyle = bg; ctx.fill(); ctx.restore(); boltPath(ctx, 66, 92, 0.95); ctx.lineWidth = 3.5; ctx.strokeStyle = '#7a4a00'; ctx.stroke();
    const cloud = () => { ctx.beginPath(); ctx.arc(40, 56, 22, Math.PI * 0.5, Math.PI * 1.5); ctx.arc(60, 36, 24, Math.PI, Math.PI * 1.85); ctx.arc(88, 42, 21, Math.PI * 1.25, Math.PI * 0.1); ctx.arc(94, 62, 15, Math.PI * 1.6, Math.PI * 0.5); ctx.closePath(); };
    ctx.save(); ctx.shadowColor = 'rgba(150,80,255,0.9)'; ctx.shadowBlur = 18; cloud();
    const g = ctx.createLinearGradient(0, 14, 0, 80); g.addColorStop(0, '#d9c2ff'); g.addColorStop(0.5, '#7a43e6'); g.addColorStop(1, '#341478');
    ctx.fillStyle = g; ctx.fill(); ctx.restore();
    cloud(); ctx.lineWidth = 4; ctx.strokeStyle = '#1e0a4a'; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.beginPath(); ctx.ellipse(54, 30, 14, 6, -0.3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffffff'; for (const [x, y] of [[48, 54], [74, 54]]) { ctx.beginPath(); ctx.ellipse(x, y, 4.5, 6, 0, 0, 7); ctx.fill(); ctx.fillStyle = '#1e0a4a'; ctx.beginPath(); ctx.arc(x + 1, y + 1.5, 2.6, 0, 7); ctx.fill(); ctx.fillStyle = '#ffffff'; }
    ctx.strokeStyle = '#1e0a4a'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(42, 44); ctx.lineTo(54, 48); ctx.moveTo(80, 44); ctx.lineTo(68, 48); ctx.stroke();
  },
};

export function buildItemIcon(name, size = 128) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d'); ctx.scale(size / 128, size / 128);
  ctx.lineJoin = 'round';
  (ICONS[name] || ICONS.orb)(ctx);
  return c;
}

/* ------------------------------------------------------------------ */
/* Item meshes (3D)                                                    */
/* ------------------------------------------------------------------ */
function hexTexture() {
  return ct('hexTex', () => {
    const R = 74, w = Math.sqrt(3) * R;
    const t = canvasTex(128, 222, (ctx, W, H) => {
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); ctx.strokeStyle = '#fff'; ctx.lineWidth = 7;
      const centers = [[0, 0], [w, 0], [w / 2, 1.5 * R], [0, 3 * R], [w, 3 * R], [w / 2, -1.5 * R]];
      for (const [cx, cy] of centers) { ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3 + Math.PI / 2 * 0; const x = cx + Math.cos(a + Math.PI / 2) * R * 0.98, y = cy + Math.sin(a + Math.PI / 2) * R * 0.98; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.closePath(); ctx.stroke(); }
    }, false);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
  });
}
function glowSpriteTex(inner, outer) {
  return ct(`glow|${inner}|${outer}`, () => canvasTex(64, 64, (ctx) => {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32); g.addColorStop(0, inner); g.addColorStop(0.3, outer); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
  }));
}
function rainbowTex() {
  return ct('rainbow', () => canvasTex(256, 256, (ctx) => {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 256, 256); ctx.globalCompositeOperation = 'lighter';
    const cols = ['#ff2d6b', '#ff9b2d', '#e9ff3a', '#2dff86', '#2dc4ff', '#7a4dff', '#ff3ad1'];
    for (let k = 0; k < 4; k++) {
      ctx.save(); ctx.translate(128 + k * 9 - 14, 128 + k * 6 - 8); ctx.rotate(k * 0.7);
      cols.forEach((c, i) => { ctx.strokeStyle = c; ctx.globalAlpha = 0.35; ctx.lineWidth = 7; ctx.beginPath(); ctx.ellipse(0, 0, 40 + i * 8 + k * 12, 22 + i * 5 + k * 6, 0, 0, Math.PI * 2); ctx.stroke(); });
      ctx.restore();
    }
    ctx.globalCompositeOperation = 'destination-in'; const m = ctx.createRadialGradient(128, 128, 30, 128, 128, 128); m.addColorStop(0, 'rgba(0,0,0,1)'); m.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = m; ctx.fillRect(0, 0, 256, 256);
  }));
}

function energyOrb(color, light, dark, eye) {
  const g = new THREE.Group();
  const core = new THREE.Mesh(sphereGeo(0.45, 32, 24), new THREE.MeshPhysicalMaterial({ color: light, emissive: color, emissiveIntensity: 1.1, roughness: 0.15, clearcoat: 1, metalness: 0.1 }));
  core.position.y = 0.6; core.castShadow = true; g.add(core);
  const shell = new THREE.Mesh(sphereGeo(0.6, 32, 24), fresnelMaterial(color, 1.8, 1.6));
  shell.position.y = 0.6; g.add(shell);
  const ringPivot = new THREE.Group(); ringPivot.position.y = 0.6; ringPivot.rotation.set(1.2, 0, 0.35); g.add(ringPivot);
  const ring = new THREE.Mesh(torusGeo(0.66, 0.035, 8, 48), new THREE.MeshStandardMaterial({ color: light, emissive: color, emissiveIntensity: 2.2, roughness: 0.3 }));
  ringPivot.add(ring);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowSpriteTex('rgba(255,255,255,1)', css(color)), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.6 }));
  glow.scale.setScalar(2.2); glow.position.y = 0.6; g.add(glow);
  if (eye) {
    const e = new THREE.Group(); e.position.set(0, 0.6, 0.43); g.add(e);
    mesh(sphereGeo(1, 20, 14), eyeWhite(), e, null, null, V3(0.2, 0.17, 0.08));
    mesh(sphereGeo(1, 16, 12), new THREE.MeshStandardMaterial({ color: 0xffd23a, emissive: 0xff6a00, emissiveIntensity: 1.2 }), e, V3(0, 0, 0.05), null, V3(0.1, 0.1, 0.05));
    mesh(sphereGeo(1, 12, 8), pupilMat(), e, V3(0, 0, 0.085), null, V3(0.05, 0.05, 0.03));
    mesh(roundedBoxGeo(0.34, 0.06, 0.06, 0.025), paint(dark), e, V3(0, 0.18, 0.02), [0, 0, -0.15]);
    for (const sx of [-1, 1]) mesh(roundedBoxGeo(0.04, 0.3, 0.22, 0.02), paint(dark), g, V3(sx * 0.44, 0.6, -0.2), [0.3, 0, 0]);
  }
  g.userData = { core, shell, ring: ringPivot, glow, radius: 0.6, centerY: 0.6 };
  return g;
}

export function buildItemMesh(name) {
  switch (name) {
    case 'orb': return energyOrb(0x3cff4a, 0xb9ff9a, 0x0b6b1d, false);
    case 'seeker': return energyOrb(0xff2a2a, 0xffa08a, 0x6b0000, true);
    case 'slick': {
      const g = new THREE.Group();
      const s = new THREE.Shape(); const n = 40;
      for (let i = 0; i <= n; i++) { const a = (i / n) * Math.PI * 2; const r = 1.3 + Math.sin(a * 3 + 1) * 0.12 + Math.cos(a * 5) * 0.08; const x = Math.cos(a) * r, y = Math.sin(a) * r; i ? s.lineTo(x, y) : s.moveTo(x, y); }
      const geo = new THREE.ExtrudeGeometry(s, { depth: 0.01, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.06, bevelSegments: 3, curveSegments: 6 });
      geo.rotateX(-Math.PI / 2); geo.translate(0, 0.0, 0);
      const oil = new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial({ color: 0x050508, roughness: 0.04, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.02, iridescence: 1, iridescenceIOR: 1.6, iridescenceThicknessMinimum: 180, iridescenceThicknessMaximum: 650 }));
      oil.position.y = 0.01; oil.receiveShadow = true; g.add(oil);
      const sheen = new THREE.Mesh(cg('sheenGeo', () => new THREE.CircleGeometry(1.3, 40).rotateX(-Math.PI / 2)), new THREE.MeshBasicMaterial({ map: rainbowTex(), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0.7, toneMapped: false }));
      sheen.position.y = 0.055; g.add(sheen);
      for (const [x, z, r] of [[1.55, 0.4, 0.16], [-1.4, -0.7, 0.12], [0.5, -1.55, 0.1]]) {
        const d = new THREE.Mesh(sphereGeo(1, 16, 8), oil.material); d.scale.set(r, 0.03, r); d.position.set(x, 0.02, z); g.add(d);
      }
      g.userData = { oil, sheen, radius: 1.4 };
      return g;
    }
    case 'bomb': {
      const g = new THREE.Group();
      const ball = mesh(sphereGeo(0.5, 32, 24), new THREE.MeshPhysicalMaterial({ color: 0x15161c, roughness: 0.25, metalness: 0.4, clearcoat: 1, clearcoatRoughness: 0.08 }), g, V3(0, 0.5, 0));
      const capP = V3(0.2, 0.96, 0); const capDir = V3(0.35, 1, 0).normalize();
      const cap = mesh(cylGeo(0.13, 0.15, 0.14, 20), chrome(), g, V3(0, 0.5, 0).addScaledVector(capDir, 0.5)); cap.quaternion.setFromUnitVectors(AX_Y, capDir);
      const top = V3(0, 0.5, 0).addScaledVector(capDir, 0.57);
      const fuseCurve = new THREE.CatmullRomCurve3([top, top.clone().add(V3(0.05, 0.12, 0)), top.clone().add(V3(0.18, 0.18, 0.04)), top.clone().add(V3(0.24, 0.3, 0.02))]);
      mesh(new THREE.TubeGeometry(fuseCurve, 16, 0.025, 8), satin(0xb08350, 0.8), g);
      const sparkP = fuseCurve.getPoint(1);
      const sparkM = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffb020, emissiveIntensity: 4 });
      const spark = mesh(sphereGeo(0.05, 12, 8), sparkM, g, sparkP);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowSpriteTex('rgba(255,255,220,1)', 'rgba(255,140,0,0.8)'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
      glow.scale.setScalar(0.6); glow.position.copy(sparkP); g.add(glow);
      // cute face
      const E = { c: V3(0, 0.5, 0), r: V3(0.5, 0.5, 0.5) };
      for (const sx of [-1, 1]) onSurface(cartoonEye(1, sx, 0.2 * sx, 1.1), g, facePoint(E, sx * 0.14, 0.55), -0.01);
      const m = onSurface(mesh(torusGeo(0.06, 0.014, 6, 14, Math.PI), satin(0xffffff, 0.5), null), g, facePoint(E, 0, 0.36)); m.rotateZ(Math.PI);
      g.userData = { ball, spark, sparkMaterial: sparkM, glow, radius: 0.5, centerY: 0.5 };
      return g;
    }
    case 'shield': {
      const g = new THREE.Group();
      const mat = fresnelMaterial(0x4fb4ff, 2.0, 1.25, hexTexture());
      const s = new THREE.Mesh(sphereGeo(1.6, 48, 32), mat); s.position.y = 0.85; s.renderOrder = 20; g.add(s);
      g.userData = { bubble: s, material: mat, radius: 1.6, centerY: 0.85, update(t) { mat.uniforms.time.value = t; } };
      return g;
    }
    default: {
      const g = energyOrb(0xffd23a, 0xfff3b0, 0x7a4d00, false);
      return g;
    }
  }
}
