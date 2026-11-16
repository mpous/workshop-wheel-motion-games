// The lake: golden-hour sky, reflective water, terrain with a sandy shore and
// forested hills, distant mountains, a wooden dock, reeds, lily pads,
// fireflies, plus the shared water effects (splashes, ripples, sparkles).
// The angler stands at the end of the dock at the origin, facing -Z.
import * as THREE from '../libs/three.bundle.js';
import { makeRng, makeNoise2D, clamp, smoothstep, lerp } from './util.js';

const { mergeGeometries } = THREE.BufferGeometryUtils;

export const LAKE_CENTRE = new THREE.Vector2(0, -50);
const LAKE_R = 66;
const DOCK_Z0 = -1.2;     // end of the dock (where the angler stands)
const DOCK_Z1 = 26;
export const DOCK_Y = 0.95;
const SUN_EL = 6.5 * Math.PI / 180;
const SUN_AZ = -24 * Math.PI / 180;   // a little left of straight ahead: glitter path on the water

const noise = makeNoise2D(11);

export function lakeRadius(th) {
  // keep the shore round behind the dock so it always meets the land
  const dockW = Math.exp(-Math.pow(th - Math.PI / 2, 2) / 0.25);
  return LAKE_R + (noise(Math.cos(th) * 1.4 + 3, Math.sin(th) * 1.4) * 14 + Math.sin(3 * th + 1) * 6) * (1 - dockW);
}

// signed distance to the shore (negative = water)
export function shoreDist(x, z) {
  const dx = x - LAKE_CENTRE.x, dz = z - LAKE_CENTRE.y;
  return Math.hypot(dx, dz) - lakeRadius(Math.atan2(dz, dx));
}

export function terrainHeight(x, z) {
  const s = shoreDist(x, z);
  const d = Math.hypot(x - LAKE_CENTRE.x, z - LAKE_CENTRE.y);
  if (s < 0) return Math.max(-9, s * 0.22) - 0.4;
  const hills = (noise.fbm(x * 0.011, z * 0.011, 4) * 0.5 + 0.5) * 30 * smoothstep(0, 70, s);
  const ridge = 1 - Math.abs(noise.fbm(x * 0.006 + 9, z * 0.006 - 4, 4));
  const mountains = smoothstep(170, 340, d) * (ridge * ridge * 170 + 20);
  return 0.5 + s * 0.06 + hills + mountains;
}

// ------------------------------------------------------------------ textures
// Tileable water normal map: a sum of integer-frequency waves wraps perfectly.
function waterNormals(size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const rng = makeRng(5);
  const waves = Array.from({ length: 22 }, () => ({
    kx: rng.int(-9, 9), ky: rng.int(-9, 9), ph: rng() * Math.PI * 2, a: 0,
  })).filter((w) => w.kx || w.ky);
  for (const w of waves) w.a = 1 / Math.pow(Math.hypot(w.kx, w.ky), 1.2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let dx = 0, dy = 0;
      const u = (x / size) * Math.PI * 2, v = (y / size) * Math.PI * 2;
      for (const w of waves) {
        const c2 = Math.cos(w.kx * u + w.ky * v + w.ph) * w.a;
        dx += c2 * w.kx; dy += c2 * w.ky;
      }
      const n = new THREE.Vector3(-dx * 0.09, -dy * 0.09, 1).normalize();
      const i = (y * size + x) * 4;
      img.data[i] = (n.x * 0.5 + 0.5) * 255;
      img.data[i + 1] = (n.y * 0.5 + 0.5) * 255;
      img.data[i + 2] = (n.z * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function woodTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#8a6440';
  g.fillRect(0, 0, 256, 64);
  const rng = makeRng(3);
  for (let i = 0; i < 70; i++) {
    g.strokeStyle = `rgba(${rng() < 0.5 ? '60,38,20' : '170,130,90'},${0.15 + rng() * 0.25})`;
    g.lineWidth = 1 + rng() * 2;
    const y = rng() * 64;
    g.beginPath(); g.moveTo(0, y);
    for (let x = 0; x <= 256; x += 32) g.lineTo(x, y + Math.sin(x * 0.05 + i) * 2);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function softDot() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.35, 'rgba(255,255,255,0.6)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// ------------------------------------------------------------------ water FX
const POINT_VS = /* glsl */`
  attribute float size;
  attribute vec4 tint;
  varying vec4 vTint;
  uniform float scale;
  void main() {
    vTint = tint;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * scale / -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;
const POINT_FS = /* glsl */`
  uniform sampler2D map;
  varying vec4 vTint;
  void main() {
    vec4 t = texture2D(map, gl_PointCoord);
    gl_FragColor = vec4(vTint.rgb, vTint.a * t.a);
    if (gl_FragColor.a < 0.01) discard;
  }`;

class Particles {
  constructor(scene, max, { additive = false } = {}) {
    this.max = max;
    this.n = 0;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.age = new Float32Array(max);
    this.base = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.sizes = new Float32Array(max);
    this.tints = new Float32Array(max * 4);
    this.rgb = new Float32Array(max * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('tint', new THREE.BufferAttribute(this.tints, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: softDot() }, scale: { value: 600 } },
      vertexShader: POINT_VS, fragmentShader: POINT_FS,
      transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  emit(p, v, { life = 1, size = 0.2, color = [1, 1, 1], gravity = 9.8 } = {}) {
    let i = this.n < this.max ? this.n++ : (Math.random() * this.max) | 0;
    this.pos.set([p.x, p.y, p.z], i * 3);
    this.vel.set([v.x, v.y, v.z], i * 3);
    this.life[i] = life; this.age[i] = 0; this.base[i] = size; this.grav[i] = gravity;
    this.rgb.set(color, i * 3);
  }

  update(dt) {
    for (let i = 0; i < this.n; i++) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        // swap with the last live particle
        const j = --this.n;
        if (i !== j) {
          this.pos.copyWithin(i * 3, j * 3, j * 3 + 3); this.vel.copyWithin(i * 3, j * 3, j * 3 + 3);
          this.rgb.copyWithin(i * 3, j * 3, j * 3 + 3);
          this.life[i] = this.life[j]; this.age[i] = this.age[j]; this.base[i] = this.base[j]; this.grav[i] = this.grav[j];
          i--;
        }
        continue;
      }
      const k = i * 3;
      this.vel[k + 1] -= this.grav[i] * dt;
      this.pos[k] += this.vel[k] * dt; this.pos[k + 1] += this.vel[k + 1] * dt; this.pos[k + 2] += this.vel[k + 2] * dt;
      if (this.grav[i] > 0 && this.pos[k + 1] < 0) this.age[i] = this.life[i];   // back into the lake
      const f = this.age[i] / this.life[i];
      this.sizes[i] = this.base[i] * (1 - f * 0.4);
      this.tints[i * 4] = this.rgb[k]; this.tints[i * 4 + 1] = this.rgb[k + 1]; this.tints[i * 4 + 2] = this.rgb[k + 2];
      this.tints[i * 4 + 3] = Math.min(1, (1 - f) * 2);
    }
    for (let i = this.n; i < this.max; i++) this.sizes[i] = 0;
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.size.needsUpdate = true;
    this.geo.attributes.tint.needsUpdate = true;
  }
}

const RIPPLE_FS = /* glsl */`
  uniform float prog, alpha;
  uniform vec3 color;
  varying vec2 vUv;
  void main() {
    float r = length(vUv - 0.5) * 2.0;
    float ring = smoothstep(0.08, 0.0, abs(r - prog)) * (1.0 - prog);
    float ring2 = smoothstep(0.06, 0.0, abs(r - prog * 0.6)) * (1.0 - prog) * 0.5;
    float a = (ring + ring2) * alpha;
    if (a < 0.01) discard;
    gl_FragColor = vec4(color, a);
  }`;

class Ripples {
  constructor(scene, n = 40) {
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.pool = Array.from({ length: n }, () => {
      const m = new THREE.Mesh(geo, new THREE.ShaderMaterial({
        uniforms: { prog: { value: 0 }, alpha: { value: 0.7 }, color: { value: new THREE.Color(0xffffff) } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: RIPPLE_FS, transparent: true, depthWrite: false,
      }));
      m.visible = false;
      m.renderOrder = 2;
      m.userData = { t: 0, life: 1, size: 1 };
      scene.add(m);
      return m;
    });
    this.i = 0;
  }

  add(x, z, size = 2, life = 1.6, alpha = 0.65, color = 0xffffff) {
    const m = this.pool[this.i++ % this.pool.length];
    m.position.set(x, 0.04, z);
    m.visible = true;
    m.userData = { t: 0, life, size };
    m.material.uniforms.alpha.value = alpha;
    m.material.uniforms.color.value.set(color);
  }

  update(dt) {
    for (const m of this.pool) {
      if (!m.visible) continue;
      const u = m.userData;
      u.t += dt;
      const p = u.t / u.life;
      if (p >= 1) { m.visible = false; continue; }
      m.scale.setScalar(u.size * 2);
      m.material.uniforms.prog.value = 1 - Math.pow(1 - p, 1.8);
    }
  }
}

// ------------------------------------------------------------------ world
export class World {
  constructor(app) {
    this.app = app;
    this.scene = app.scene;
    this.q = app.q;
    this.time = 0;
    this.sunDir = new THREE.Vector3(Math.sin(SUN_AZ), Math.sin(SUN_EL), -Math.cos(SUN_AZ)).normalize();
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this._sky();
    this._lights();
    this._water();
    this._terrain();
    this._forest();
    this._shore();
    this._dock();
    this._fireflies();
    this.splash = new Particles(this.scene, 900);
    this.glow = new Particles(this.scene, 400, { additive: true });
    this.ripples = new Ripples(this.scene);
  }

  _sky() {
    const sky = (this.sky = new THREE.Sky());
    sky.scale.setScalar(4500);
    const u = sky.material.uniforms;
    u.turbidity.value = 6.5;
    u.rayleigh.value = 2.2;
    u.mieCoefficient.value = 0.006;
    u.mieDirectionalG.value = 0.86;
    u.sunPosition.value.copy(this.sunDir);
    if (u.cloudCoverage) { u.cloudCoverage.value = 0.38; u.cloudDensity.value = 0.45; u.cloudElevation.value = 0.55; }
    this.group.add(sky);
    // image-based lighting from the same sky
    const pm = new THREE.PMREMGenerator(this.app.renderer);
    const envScene = new THREE.Scene();
    const s2 = new THREE.Sky();
    s2.scale.setScalar(900);
    s2.material.uniforms.sunPosition.value.copy(this.sunDir);
    for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG']) s2.material.uniforms[k].value = u[k].value;
    if (s2.material.uniforms.showSunDisc) s2.material.uniforms.showSunDisc.value = 0;
    envScene.add(s2);
    this.envMap = pm.fromScene(envScene, 0, 0.1, 1000).texture;
    this.scene.environment = this.envMap;
    this.scene.environmentIntensity = 0.55;
    pm.dispose();
    this.scene.fog = new THREE.FogExp2(0xd7a27c, 0.0021);
  }

  _lights() {
    this.hemi = new THREE.HemisphereLight(0xffd6a8, 0x2c3a2a, 0.55);
    this.group.add(this.hemi);
    const sun = (this.sun = new THREE.DirectionalLight(0xffb36b, 2.6));
    sun.position.copy(this.sunDir).multiplyScalar(120).add(new THREE.Vector3(0, 0, -10));
    sun.target.position.set(0, 0, -10);
    sun.castShadow = !!this.q.shadows;
    if (sun.castShadow) {
      sun.shadow.mapSize.set(this.q.shadowSize || 1024, this.q.shadowSize || 1024);
      const c = sun.shadow.camera;
      c.left = -45; c.right = 45; c.top = 45; c.bottom = -45; c.near = 1; c.far = 300;
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 0.04;
    }
    this.group.add(sun, sun.target);
    // warm lantern at the dock
    this.lantern = new THREE.PointLight(0xffa04a, 6, 14, 2);
    this.lantern.position.set(1.4, DOCK_Y + 2.1, 2.2);
    this.group.add(this.lantern);
  }

  _water() {
    const geo = new THREE.PlaneGeometry(2400, 2400, 1, 1).rotateX(-Math.PI / 2);
    const normals = waterNormals(256);
    if (this.q.mirror) {
      const w = (this.water = new THREE.Water(geo, {
        textureWidth: this.q.mirror, textureHeight: this.q.mirror,
        waterNormals: normals, sunDirection: this.sunDir.clone(), sunColor: 0xffc58a,
        waterColor: 0x0d2f3a, distortionScale: 0.9, fog: true, alpha: 1,
      }));
      w.material.uniforms.size.value = 3.2;
      this.group.add(w);
    } else {
      normals.repeat.set(160, 160);
      const m = new THREE.MeshStandardMaterial({ color: 0x0e3442, roughness: 0.08, metalness: 0.9, normalMap: normals, normalScale: new THREE.Vector2(0.35, 0.35), envMapIntensity: 1.2 });
      this.water = new THREE.Mesh(geo, m);
      this.water.userData.flat = true;
      this.group.add(this.water);
    }
    this.water.receiveShadow = false;
  }

  _terrain() {
    const seg = this.q.terrain || 180;
    const size = 1000;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg).rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const col = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    const sand = new THREE.Color(0xc4a77a), grass = new THREE.Color(0x587f34), grass2 = new THREE.Color(0x7d9a3e), forest = new THREE.Color(0x34502a),
      rock = new THREE.Color(0x7c776c), snow = new THREE.Color(0xf1f4f8), bed = new THREE.Color(0x4b5236);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const h = terrainHeight(x, z);
      pos.setY(i, h);
      const s = shoreDist(x, z);
      const n = noise(x * 0.05, z * 0.05) * 0.5 + 0.5;
      if (s < 0) c.copy(bed);
      else if (s < 3.5 + n * 2) c.copy(sand).lerp(grass2, smoothstep(2, 5, s) * 0.4);
      else if (h > 95 + n * 25) c.copy(snow);
      else if (h > 45) c.copy(forest).lerp(rock, smoothstep(45, 90, h));
      else c.copy(grass).lerp(grass2, n).lerp(forest, smoothstep(10, 40, s) * 0.7);
      col.set([c.r, c.g, c.b], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
    this.terrain = new THREE.Mesh(geo, mat);
    this.terrain.receiveShadow = true;
    this.group.add(this.terrain);
  }

  _forest() {
    const rng = makeRng(21);
    const count = this.q.trees || 600;
    // pine: trunk + three cones, coloured per vertex
    const paint = (g, hex) => {
      const cc = new THREE.Color(hex);
      const a = new Float32Array(g.attributes.position.count * 3);
      for (let i = 0; i < a.length; i += 3) a.set([cc.r, cc.g, cc.b], i);
      g.setAttribute('color', new THREE.BufferAttribute(a, 3));
      return g;
    };
    const parts = [paint(new THREE.CylinderGeometry(0.18, 0.28, 2.2, 6).translate(0, 1.1, 0), 0x5a3d26)];
    [[2.2, 3.4, 1.8], [1.7, 3.0, 3.4], [1.15, 2.6, 4.9]].forEach(([r, h, y], i) => parts.push(paint(new THREE.ConeGeometry(r, h, 7).translate(0, y + h / 2 - 0.4, 0), [0x23452a, 0x2a5230, 0x315c35][i])));
    const pine = mergeGeometries(parts.map((g) => g.toNonIndexed()));
    const leafy = mergeGeometries([
      paint(new THREE.CylinderGeometry(0.2, 0.3, 2.6, 6).translate(0, 1.3, 0), 0x5e4630).toNonIndexed(),
      paint(new THREE.IcosahedronGeometry(2.1, 0).translate(0, 3.8, 0), 0x5d7f2e).toNonIndexed(),
      paint(new THREE.IcosahedronGeometry(1.5, 0).translate(0.9, 4.8, 0.4), 0x6f8f35).toNonIndexed(),
    ]);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
    this._sway(mat, 0.05);
    const make = (geo, n) => {
      const m = new THREE.InstancedMesh(geo, mat, n);
      m.castShadow = !!this.q.shadows;
      m.receiveShadow = false;
      return m;
    };
    const pines = make(pine, count), leaves = make(leafy, Math.floor(count * 0.35));
    const d = new THREE.Object3D();
    let ip = 0, il = 0, guard = 0;
    while ((ip < pines.count || il < leaves.count) && guard++ < count * 20) {
      const a = rng() * Math.PI * 2, r = 40 + Math.pow(rng(), 0.7) * 330;
      const x = LAKE_CENTRE.x + Math.cos(a) * r, z = LAKE_CENTRE.y + Math.sin(a) * r;
      const s = shoreDist(x, z);
      if (s < 5 || s > 200) continue;
      if (Math.abs(x) < 7 && z > 8 && z < 40) continue;   // keep the path to the dock clear
      const h = terrainHeight(x, z);
      if (h > 85) continue;
      const leafyOne = s < 40 && rng() < 0.35;
      d.position.set(x, h - 0.3, z);
      d.rotation.set((rng() - 0.5) * 0.08, rng() * Math.PI * 2, (rng() - 0.5) * 0.08);
      d.scale.setScalar(0.75 + rng() * 1.1 + smoothstep(20, 120, s) * 0.6);
      d.updateMatrix();
      if (leafyOne && il < leaves.count) leaves.setMatrixAt(il++, d.matrix);
      else if (ip < pines.count) pines.setMatrixAt(ip++, d.matrix);
    }
    pines.count = ip; leaves.count = il;
    this.group.add(pines, leaves);
  }

  // gentle wind on foliage: displace by height in the vertex shader
  _sway(mat, amount) {
    const u = (this._windU ||= { value: 0 });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uWind = u;
      sh.vertexShader = 'uniform float uWind;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 ip = instanceMatrix[3].xyz;
        #else
          vec3 ip = vec3(0.0);
        #endif
        float sw = max(position.y - 0.8, 0.0) * ${amount.toFixed(3)};
        transformed.x += sin(uWind * 1.3 + ip.x * 0.31 + ip.z * 0.17) * sw;
        transformed.z += cos(uWind * 1.1 + ip.z * 0.29) * sw * 0.6;`);
    };
  }

  _shore() {
    const rng = makeRng(33);
    const d = new THREE.Object3D();
    // rocks
    const rockGeo = new THREE.DodecahedronGeometry(1, 1);
    const p = rockGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(p, i);
      v.multiplyScalar(1 + noise(v.x * 2.1, v.z * 2.1 + v.y) * 0.35);
      p.setXYZ(i, v.x, v.y * 0.7, v.z);
    }
    rockGeo.computeVertexNormals();
    const rocks = new THREE.InstancedMesh(rockGeo, new THREE.MeshStandardMaterial({ color: 0x8a857a, roughness: 0.85, flatShading: true }), 140);
    rocks.castShadow = rocks.receiveShadow = !!this.q.shadows;
    let n = 0;
    for (let k = 0; k < 2000 && n < rocks.count; k++) {
      const th = rng() * Math.PI * 2;
      if (Math.abs(th - Math.PI / 2) < 0.18) continue;
      const r = lakeRadius(th) + (rng() - 0.4) * 8;
      const x = LAKE_CENTRE.x + Math.cos(th) * r, z = LAKE_CENTRE.y + Math.sin(th) * r;
      d.position.set(x, Math.max(terrainHeight(x, z), -0.6) - 0.2, z);
      d.rotation.set(rng() * 3, rng() * 3, rng() * 3);
      d.scale.set(0.5 + rng() * 1.6, 0.4 + rng() * 1.2, 0.5 + rng() * 1.6);
      d.updateMatrix();
      rocks.setMatrixAt(n++, d.matrix);
    }
    rocks.count = n;
    this.group.add(rocks);

    // reeds and cattails in the shallows
    const reed = mergeGeometries([
      new THREE.CylinderGeometry(0.015, 0.03, 2.2, 3).translate(0, 1.1, 0).toNonIndexed(),
      new THREE.CylinderGeometry(0.05, 0.05, 0.35, 5).translate(0, 2.0, 0).toNonIndexed(),
    ]);
    const reedMat = new THREE.MeshStandardMaterial({ color: 0x6f7f36, roughness: 0.8 });
    this._sway(reedMat, 0.12);
    const reeds = new THREE.InstancedMesh(reed, reedMat, this.q.reeds || 1400);
    n = 0;
    for (let k = 0; k < 20000 && n < reeds.count; k++) {
      const th = rng() * Math.PI * 2;
      if (Math.abs(th - Math.PI / 2) < 0.12) continue;
      // clumps
      const r = lakeRadius(th) + (rng() - 0.7) * 6;
      const x = LAKE_CENTRE.x + Math.cos(th) * r, z = LAKE_CENTRE.y + Math.sin(th) * r;
      if (noise(x * 0.08, z * 0.08) < -0.05) continue;
      d.position.set(x, Math.max(terrainHeight(x, z), -1.2), z);
      d.rotation.set((rng() - 0.5) * 0.3, rng() * 6, (rng() - 0.5) * 0.3);
      d.scale.set(1, 0.6 + rng() * 0.8, 1);
      d.updateMatrix();
      reeds.setMatrixAt(n++, d.matrix);
    }
    reeds.count = n;
    this.group.add(reeds);

    // lily pads with the odd flower
    const pad = new THREE.CircleGeometry(0.55, 14, 0.25, Math.PI * 2 - 0.5).rotateX(-Math.PI / 2);
    const pads = new THREE.InstancedMesh(pad, new THREE.MeshStandardMaterial({ color: 0x3f7a35, roughness: 0.55, side: THREE.DoubleSide }), 220);
    const flower = new THREE.InstancedMesh(new THREE.ConeGeometry(0.16, 0.2, 6, 1, true).rotateX(Math.PI), new THREE.MeshStandardMaterial({ color: 0xffc9e0, emissive: 0x552233, roughness: 0.5, side: THREE.DoubleSide }), 40);
    n = 0;
    let nf = 0;
    for (let k = 0; k < 4000 && n < pads.count; k++) {
      const th = rng() * Math.PI * 2;
      if (Math.abs(th - Math.PI / 2) < 0.3) continue;
      const r = lakeRadius(th) - 3 - rng() * 9;
      const x = LAKE_CENTRE.x + Math.cos(th) * r, z = LAKE_CENTRE.y + Math.sin(th) * r;
      if (noise(x * 0.06 + 5, z * 0.06) < 0.1) continue;
      d.position.set(x, 0.03, z);
      d.rotation.set(0, rng() * 6, 0);
      d.scale.setScalar(0.6 + rng() * 0.8);
      d.updateMatrix();
      pads.setMatrixAt(n++, d.matrix);
      if (nf < flower.count && rng() < 0.18) { d.position.y = 0.13; d.updateMatrix(); flower.setMatrixAt(nf++, d.matrix); }
    }
    pads.count = n; flower.count = nf;
    this.group.add(pads, flower);
  }

  _dock() {
    const g = new THREE.Group();
    const wood = woodTexture();
    const plankMat = new THREE.MeshStandardMaterial({ map: wood, color: 0xb38a5e, roughness: 0.85 });
    const postMat = new THREE.MeshStandardMaterial({ color: 0x4b3624, roughness: 0.9 });
    const rng = makeRng(8);
    const W = 2.6;
    for (let z = DOCK_Z0; z < DOCK_Z1; z += 0.34) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(W + (rng() - 0.5) * 0.12, 0.07, 0.3), plankMat);
      m.position.set((rng() - 0.5) * 0.05, DOCK_Y, z + 0.15);
      m.rotation.y = (rng() - 0.5) * 0.02;
      m.castShadow = m.receiveShadow = true;
      g.add(m);
    }
    for (const x of [-W / 2 + 0.1, W / 2 - 0.1]) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.18, DOCK_Z1 - DOCK_Z0), postMat);
      beam.position.set(x, DOCK_Y - 0.12, (DOCK_Z0 + DOCK_Z1) / 2);
      g.add(beam);
      for (let z = DOCK_Z0 + 0.1; z < DOCK_Z1; z += 3) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 3.2, 8), postMat);
        post.position.set(x, DOCK_Y - 1.4, z);
        post.castShadow = true;
        g.add(post);
      }
    }
    // end posts sticking up, a rope, a lantern, a tackle box and a bucket
    for (const x of [-W / 2 + 0.1, W / 2 - 0.1]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.13, 1.1, 8), postMat);
      p.position.set(x, DOCK_Y + 0.5, DOCK_Z0 + 0.15);
      p.castShadow = true;
      g.add(p);
    }
    const lampPost = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.2, 0.1), postMat);
    lampPost.position.set(1.4, DOCK_Y + 1.05, 2.2);
    const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 0.3, 8), new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xffa04a, emissiveIntensity: 3 }));
    lamp.position.set(1.4, DOCK_Y + 2.1, 2.2);
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.3, 0.35), new THREE.MeshStandardMaterial({ color: 0x2f6b3e, roughness: 0.5, metalness: 0.2 }));
    box.position.set(-0.85, DOCK_Y + 0.18, 1.6); box.rotation.y = 0.3; box.castShadow = true;
    const bucket = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.19, 0.4, 14, 1, true), new THREE.MeshStandardMaterial({ color: 0x9aa4ad, metalness: 0.7, roughness: 0.35, side: THREE.DoubleSide }));
    bucket.position.set(0.85, DOCK_Y + 0.22, 1.3); bucket.castShadow = true;
    g.add(lampPost, lamp, box, bucket);
    this.group.add(g);
  }

  _fireflies() {
    const n = this.q.fireflies ?? 160;
    const rng = makeRng(77);
    const pos = new Float32Array(n * 3), ph = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const th = rng() * Math.PI * 2;
      const r = lakeRadius(th) + (rng() - 0.3) * 14;
      const x = LAKE_CENTRE.x + Math.cos(th) * r, z = LAKE_CENTRE.y + Math.sin(th) * r;
      pos.set([x, Math.max(0, terrainHeight(x, z)) + 0.5 + rng() * 3, z], i * 3);
      ph[i] = rng() * 100;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('phase', new THREE.BufferAttribute(ph, 1));
    this.flyMat = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, map: { value: softDot() } },
      vertexShader: /* glsl */`
        attribute float phase; uniform float time; varying float vA;
        void main() {
          vec3 p = position + vec3(sin(time * 0.4 + phase) * 1.2, sin(time * 0.7 + phase * 1.3) * 0.5, cos(time * 0.35 + phase) * 1.2);
          vA = pow(max(sin(time * 1.6 + phase * 2.0), 0.0), 6.0);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = 260.0 / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D map; varying float vA;
        void main() { float a = texture2D(map, gl_PointCoord).a * vA; if (a < 0.01) discard; gl_FragColor = vec4(1.0, 0.9, 0.35, a); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(g, this.flyMat);
    pts.frustumCulled = false;
    this.group.add(pts);
  }

  // ------------------------------------------------------------------ effects
  splashAt(x, z, power = 1, color = [0.9, 0.96, 1]) {
    const n = Math.round(14 + power * 34);
    const v = new THREE.Vector3(), p = new THREE.Vector3(x, 0.05, z);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = (0.6 + Math.random() * 2.2) * (0.6 + power * 0.6);
      v.set(Math.cos(a) * s, 2 + Math.random() * 3.5 * (0.5 + power), Math.sin(a) * s);
      this.splash.emit(p, v, { life: 0.7 + Math.random() * 0.6, size: 0.12 + Math.random() * 0.2 * (0.6 + power), color });
    }
    this.ripples.add(x, z, 1.4 + power * 2.2, 1.6 + power * 0.6, 0.8);
    this.ripples.add(x, z, 0.8 + power * 1.2, 1.1, 0.6);
  }

  sparkle(p, n = 20, color = [1, 0.85, 0.3], spread = 1, up = 1.5) {
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      v.set((Math.random() - 0.5) * spread * 2, Math.random() * up, (Math.random() - 0.5) * spread * 2);
      this.glow.emit(p, v, { life: 0.6 + Math.random() * 0.9, size: 0.18 + Math.random() * 0.25, color, gravity: -0.3 });
    }
  }

  bubble(x, z) {
    const p = new THREE.Vector3(x + (Math.random() - 0.5) * 0.6, 0.06, z + (Math.random() - 0.5) * 0.6);
    this.splash.emit(p, new THREE.Vector3(0, 0.25, 0), { life: 0.5, size: 0.16, color: [0.85, 0.95, 1], gravity: 0.4 });
    this.ripples.add(p.x, p.z, 0.35, 0.8, 0.55);
  }

  setViewport(h) {
    this.splash.mat.uniforms.scale.value = h * 0.9;
    this.glow.mat.uniforms.scale.value = h * 0.9;
  }

  update(dt) {
    this.time += dt;
    const t = this.time;
    if (this.water.material.uniforms) this.water.material.uniforms.time.value = t * 0.45;
    else this.water.material.normalMap.offset.set(t * 0.004, t * 0.0025);
    if (this._windU) this._windU.value = t;
    this.flyMat.uniforms.time.value = t;
    if (this.sky.material.uniforms.time) this.sky.material.uniforms.time.value = t;
    this.lantern.intensity = 5.5 + Math.sin(t * 7.3) * 0.25 + Math.sin(t * 13.1) * 0.2;
    this.splash.update(dt);
    this.glow.update(dt);
    this.ripples.update(dt);
  }
}

export { lerp, clamp };
