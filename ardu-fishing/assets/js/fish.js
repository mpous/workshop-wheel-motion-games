// Species table, weighted rolls and the procedural fish model (body, fins,
// a painted skin per species and a swimming tail).
import * as THREE from '../libs/three.bundle.js';
import { makeRng } from './util.js';

export const RARITY = {
  common: { label: 'COMMON', color: '#cfd8dc' },
  uncommon: { label: 'UNCOMMON', color: '#7ee081' },
  rare: { label: 'RARE', color: '#4fc3ff' },
  epic: { label: 'EPIC', color: '#c58bff' },
  legendary: { label: 'LEGENDARY', color: '#ffcf26' },
};

// strength: how hard it pulls · stamina: how long it keeps running · jumpy: leaps during the fight
export const SPECIES = [
  { id: 'perch', name: 'Perch', rarity: 'common', kg: [0.2, 0.8], w: 30, len: 0.28, strength: 0.45, stamina: 0.5, jumpy: 0.1,
    skin: { back: '#3d5a1e', side: '#b6b23a', belly: '#f1e3b0', bars: '#26351a', fins: '#e0602a' } },
  { id: 'trout', name: 'Rainbow Trout', rarity: 'common', kg: [0.5, 2.5], w: 26, len: 0.45, strength: 0.6, stamina: 0.6, jumpy: 0.7,
    skin: { back: '#4f6b5a', side: '#c9c8b8', belly: '#f6f1ea', stripe: '#e0607e', spots: '#2b2b2b', fins: '#a7a090' } },
  { id: 'bass', name: 'Bass', rarity: 'uncommon', kg: [0.8, 4], w: 18, len: 0.5, strength: 0.75, stamina: 0.7, jumpy: 0.6,
    skin: { back: '#2e4a24', side: '#7d9a4a', belly: '#e9e6c8', blotch: '#24351c', fins: '#6c7d48' } },
  { id: 'carp', name: 'Carp', rarity: 'uncommon', kg: [2, 9], w: 13, len: 0.65, strength: 0.85, stamina: 0.95, jumpy: 0.05,
    skin: { back: '#5a4a24', side: '#b8913c', belly: '#ecd49a', scales: '#7a5d22', fins: '#8f5a2a' } },
  { id: 'pike', name: 'Pike', rarity: 'rare', kg: [3, 12], w: 8, len: 0.95, strength: 1.05, stamina: 0.8, jumpy: 0.35, slim: true,
    skin: { back: '#2f4026', side: '#6f8a48', belly: '#efe9c4', spots: '#d9d59a', fins: '#9a6b36' } },
  { id: 'catfish', name: 'Catfish', rarity: 'epic', kg: [8, 30], w: 4, len: 1.15, strength: 1.3, stamina: 1.2, jumpy: 0, whiskers: true,
    skin: { back: '#2a2a2e', side: '#55545a', belly: '#c9c4bb', mottle: '#1c1c20', fins: '#3a3a40' } },
  { id: 'koi', name: 'Golden Koi', rarity: 'legendary', kg: [1, 5], w: 1.5, len: 0.6, strength: 0.9, stamina: 0.9, jumpy: 0.4, glow: true,
    skin: { back: '#ff9d1a', side: '#ffc64a', belly: '#fff1c2', patches: '#ffffff', fins: '#ffb347' } },
];
export const SPECIES_BY_ID = Object.fromEntries(SPECIES.map((s) => [s.id, s]));

export function rollSpecies(rng, { kind = null } = {}) {
  if (kind === 'golden') return SPECIES_BY_ID.koi;
  let pool = SPECIES.filter((s) => s.id !== 'koi' || kind !== 'wander');
  if (kind === 'shadow') pool = pool.filter((s) => s.id === 'carp' || s.id === 'catfish' || s.id === 'pike');
  if (kind === 'jump') pool = pool.filter((s) => s.jumpy >= 0.35);
  if (kind === 'wander') pool = pool.filter((s) => s.rarity === 'common' || s.rarity === 'uncommon');
  const tot = pool.reduce((a, s) => a + s.w, 0);
  let r = rng() * tot;
  for (const s of pool) { r -= s.w; if (r <= 0) return s; }
  return pool[pool.length - 1];
}

// weight skewed towards the light end; bigger fish are rarer
export function rollWeight(rng, sp) {
  const [a, b] = sp.kg;
  return Math.round((a + (b - a) * Math.pow(rng(), 1.8)) * 100) / 100;
}

// ------------------------------------------------------------------ skin
const skins = {};
function skinTexture(sp) {
  if (skins[sp.id]) return skins[sp.id];
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  const k = sp.skin;
  // u runs nose (0) to tail (1); v runs back (0) to belly (1) on one side, mirrored on the other
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, k.belly); grad.addColorStop(0.18, k.side); grad.addColorStop(0.36, k.back);
  grad.addColorStop(0.5, k.back); grad.addColorStop(0.64, k.back); grad.addColorStop(0.82, k.side); grad.addColorStop(1, k.belly);
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 256);
  const rng = makeRng(sp.id.length * 97 + 3);
  const both = (fn) => { fn(false); fn(true); };
  const Y = (v, flip) => (flip ? 256 - v : v);
  if (k.bars) for (let i = 0; i < 7; i++) both((f) => { g.fillStyle = k.bars; g.globalAlpha = 0.55; g.fillRect(90 + i * 50, Y(52, f) - (f ? 50 : 0), 18, 50); });
  if (k.stripe) both((f) => { g.globalAlpha = 0.7; g.fillStyle = k.stripe; g.fillRect(40, Y(78, f) - 9, 440, 18); });
  if (k.blotch) both((f) => { g.globalAlpha = 0.6; g.fillStyle = k.blotch; for (let i = 0; i < 9; i++) { g.beginPath(); g.ellipse(80 + i * 45, Y(80 + Math.sin(i) * 8, f), 22, 12, 0, 0, 7); g.fill(); } });
  if (k.spots) { g.fillStyle = k.spots; g.globalAlpha = 0.8; for (let i = 0; i < 160; i++) { g.beginPath(); g.arc(rng() * 512, 20 + rng() * 216, 2 + rng() * 4, 0, 7); g.fill(); } }
  if (k.scales) { g.strokeStyle = k.scales; g.globalAlpha = 0.45; g.lineWidth = 2; for (let y = 10; y < 250; y += 14) for (let x = (y / 14) % 2 * 9; x < 512; x += 18) { g.beginPath(); g.arc(x, y, 9, 0.2, Math.PI - 0.2); g.stroke(); } }
  if (k.mottle) { g.fillStyle = k.mottle; g.globalAlpha = 0.35; for (let i = 0; i < 90; i++) { g.beginPath(); g.ellipse(rng() * 512, 40 + rng() * 176, 6 + rng() * 16, 4 + rng() * 9, rng() * 3, 0, 7); g.fill(); } }
  if (k.patches) { g.fillStyle = k.patches; g.globalAlpha = 0.85; for (let i = 0; i < 7; i++) { g.beginPath(); g.ellipse(60 + rng() * 380, 60 + rng() * 136, 20 + rng() * 34, 14 + rng() * 22, rng() * 3, 0, 7); g.fill(); } }
  // fine scale sheen over every species
  g.globalAlpha = 0.08; g.strokeStyle = '#ffffff'; g.lineWidth = 1;
  for (let y = 6; y < 256; y += 8) for (let x = (y / 8) % 2 * 5; x < 512; x += 10) { g.beginPath(); g.arc(x, y, 5, 0.3, Math.PI - 0.3); g.stroke(); }
  g.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return (skins[sp.id] = t);
}

// ------------------------------------------------------------------ model
// Built along +X (nose at +X), unit length, then scaled to the species length.
export class FishModel {
  constructor(sp, kg = null) {
    this.sp = sp;
    this.root = new THREE.Group();
    this.body = new THREE.Group();
    this.root.add(this.body);
    const len = sp.len * (kg ? Math.cbrt(kg / ((sp.kg[0] + sp.kg[1]) / 2)) : 1);
    this.len = len;
    const deep = sp.slim ? 0.13 : sp.id === 'carp' ? 0.24 : 0.19;
    const wide = sp.slim ? 0.08 : 0.1;
    const skin = skinTexture(sp);
    const mat = new THREE.MeshStandardMaterial({
      map: skin, roughness: 0.32, metalness: 0.25,
      emissive: sp.glow ? 0xff9a20 : 0x000000, emissiveIntensity: sp.glow ? 0.35 : 0,
    });
    // body: a sphere reshaped into a fish profile; tail vertices sway in the shader
    const geo = new THREE.SphereGeometry(0.5, 28, 16);
    const p = geo.attributes.position, uv = geo.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const u = x + 0.5;                                    // 0 tail .. 1 nose
      const prof = Math.pow(Math.sin(Math.PI * Math.min(1, u * 0.92 + 0.08)), 0.75) * (0.55 + 0.45 * u);
      const r = Math.hypot(y, z) || 1e-6;
      y = (y / r) * prof * deep * (y > 0 ? 1 : 0.92);
      z = (z / r) * prof * wide;
      p.setXYZ(i, x, y, z);
      uv.setXY(i, 1 - u, 0.5 - y / (deep * 2) * (z >= 0 ? 1 : -1) * 0.95);
    }
    geo.computeVertexNormals();
    this._swim = { value: 0 };
    this._amp = { value: 0.12 };
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uSwim = this._swim; sh.uniforms.uAmp = this._amp;
      sh.vertexShader = 'uniform float uSwim; uniform float uAmp;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        float back = clamp(0.2 - transformed.x, 0.0, 1.0);
        transformed.z += sin(uSwim - transformed.x * 6.0) * back * back * uAmp * 3.0;`);
    };
    const body = new THREE.Mesh(geo, mat);
    body.castShadow = true;
    this.body.add(body);
    // eyes
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.1, metalness: 0.2 });
    const ringMat = new THREE.MeshStandardMaterial({ color: sp.glow ? 0xfff2b0 : 0xe8d27a, roughness: 0.3 });
    for (const s of [-1, 1]) {
      const ring = new THREE.Mesh(new THREE.SphereGeometry(0.028, 10, 8), ringMat);
      ring.position.set(0.36, deep * 0.22, s * wide * 0.62);
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.018, 10, 8), eyeMat);
      eye.position.set(0.37, deep * 0.22, s * wide * 0.8);
      this.body.add(ring, eye);
    }
    // fins
    const finMat = new THREE.MeshStandardMaterial({ color: sp.skin.fins, roughness: 0.5, transparent: true, opacity: 0.88, side: THREE.DoubleSide, emissive: sp.glow ? 0x663300 : 0 });
    const tailShape = new THREE.Shape();
    tailShape.moveTo(0, 0); tailShape.quadraticCurveTo(-0.12, 0.12, -0.2, 0.2); tailShape.lineTo(-0.15, 0); tailShape.lineTo(-0.2, -0.2); tailShape.quadraticCurveTo(-0.12, -0.12, 0, 0);
    this.tail = new THREE.Mesh(new THREE.ShapeGeometry(tailShape), finMat);
    this.tailPivot = new THREE.Group();
    this.tailPivot.position.set(-0.47, 0, 0);
    this.tailPivot.add(this.tail);
    this.tail.scale.setScalar(sp.id === 'catfish' ? 0.8 : 1);
    this.body.add(this.tailPivot);
    const dorsal = new THREE.Shape();
    dorsal.moveTo(0.12, 0); dorsal.quadraticCurveTo(0.02, deep * 0.9, -0.18, deep * 0.6); dorsal.lineTo(-0.2, 0);
    const d = new THREE.Mesh(new THREE.ShapeGeometry(dorsal), finMat);
    d.position.set(sp.slim ? -0.18 : 0, deep * 0.45, 0);
    if (sp.slim) d.scale.set(0.6, 0.8, 1);
    this.body.add(d);
    const anal = new THREE.Mesh(new THREE.ShapeGeometry(dorsal), finMat);
    anal.position.set(-0.2, -deep * 0.4, 0); anal.scale.set(0.5, -0.5, 1);
    this.body.add(anal);
    this.pecs = [-1, 1].map((s) => {
      const m = new THREE.Mesh(new THREE.CircleGeometry(0.06, 8, 0, Math.PI), finMat);
      m.position.set(0.22, -deep * 0.25, s * wide * 0.8);
      m.rotation.set(0, s * 0.5, Math.PI * 0.75);
      this.body.add(m);
      return m;
    });
    if (sp.whiskers) {
      const wm = new THREE.LineBasicMaterial({ color: 0x1a1a1a });
      for (const s of [-1, 1]) for (const yy of [0.01, -0.03]) {
        const pts = [new THREE.Vector3(0.48, yy, s * 0.03), new THREE.Vector3(0.6, yy - 0.03, s * 0.12), new THREE.Vector3(0.66, yy - 0.08, s * 0.2)];
        this.body.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), wm));
      }
    }
    this.root.scale.setScalar(len);
    this.t = Math.random() * 10;
    this.mat = mat;
  }

  // speed 0 (still) .. 1 (thrashing)
  update(dt, speed = 0.4) {
    this.t += dt * (3 + speed * 14);
    this._swim.value = this.t;
    this._amp.value = 0.04 + speed * 0.12;
    this.tailPivot.rotation.y = Math.sin(this.t) * (0.25 + speed * 0.6);
    for (const [i, f] of this.pecs.entries()) f.rotation.x = Math.sin(this.t * 0.7 + i) * 0.4;
  }

  dispose() {
    this.root.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material && o.material !== this.mat) o.material.dispose?.(); });
    this.mat.dispose();
  }
}
