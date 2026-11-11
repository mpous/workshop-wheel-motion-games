// CPU-simulated particle pools rendered as point sprites (one draw call per blend mode),
// plus a ring-buffer skid mark mesh. Pools never allocate after construction.
import * as THREE from '../libs/three.bundle.js';
import * as TEX from './textures.js';

const VERT = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  attribute float aRot;
  varying float vAlpha;
  varying vec3 vColor;
  varying float vRot;
  uniform float uScale;
  #include <fog_pars_vertex>
  void main() {
    vAlpha = aAlpha;
    vColor = aColor;
    vRot = aRot;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale / max(0.1, -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;

const FRAG = /* glsl */ `
  uniform sampler2D uMap;
  varying float vAlpha;
  varying vec3 vColor;
  varying float vRot;
  #include <fog_pars_fragment>
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float c = cos(vRot), s = sin(vRot);
    uv = mat2(c, -s, s, c) * uv + 0.5;
    vec4 tex = texture2D(uMap, uv);
    gl_FragColor = vec4(vColor * tex.rgb, tex.a * vAlpha);
    if (gl_FragColor.a < 0.003) discard;
    #include <fog_fragment>
  }`;

class Pool {
  constructor(max, { additive, map }) {
    this.max = max;
    this.n = 0;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.rot = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size0 = new Float32Array(max);
    this.size1 = new Float32Array(max);
    this.alpha0 = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.spin = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    this.aAlpha = new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage);
    this.aRot = new THREE.BufferAttribute(this.rot, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('aColor', this.aCol);
    g.setAttribute('aSize', this.aSize);
    g.setAttribute('aAlpha', this.aAlpha);
    g.setAttribute('aRot', this.aRot);
    g.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uMap: { value: map }, uScale: { value: 600 } }]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: true,
    });
    this.mat.uniforms.uMap.value = map;
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 3 : 2;
    this.geo = g;
  }

  emit(x, y, z, vx, vy, vz, r, gg, b, { life = 0.6, size = 1, size1 = null, alpha = 1, grav = 0, drag = 0, spin = 0 } = {}) {
    let i = this.n;
    if (i >= this.max) {
      // overwrite the oldest-ish slot
      i = (Math.random() * this.max) | 0;
    } else this.n++;
    const k = i * 3;
    this.pos[k] = x; this.pos[k + 1] = y; this.pos[k + 2] = z;
    this.vel[k] = vx; this.vel[k + 1] = vy; this.vel[k + 2] = vz;
    this.col[k] = r; this.col[k + 1] = gg; this.col[k + 2] = b;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size0[i] = size;
    this.size1[i] = size1 == null ? size : size1;
    this.alpha0[i] = alpha;
    this.grav[i] = grav;
    this.drag[i] = drag;
    this.spin[i] = spin;
    this.rot[i] = Math.random() * 6.28;
    this.size[i] = size;
    this.alpha[i] = alpha;
  }

  update(dt) {
    let n = this.n;
    for (let i = 0; i < n; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        // swap-remove
        n--;
        this._move(n, i);
        i--;
        continue;
      }
      const k = i * 3;
      const d = Math.exp(-this.drag[i] * dt);
      this.vel[k] *= d; this.vel[k + 1] = this.vel[k + 1] * d - this.grav[i] * dt; this.vel[k + 2] *= d;
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
      const t = 1 - this.life[i] / this.maxLife[i];
      this.size[i] = this.size0[i] + (this.size1[i] - this.size0[i]) * t;
      // quick fade in, smooth fade out
      this.alpha[i] = this.alpha0[i] * Math.min(1, t * 10) * (1 - t * t);
      this.rot[i] += this.spin[i] * dt;
    }
    this.n = n;
    this.geo.setDrawRange(0, n);
    this.aPos.needsUpdate = this.aCol.needsUpdate = this.aSize.needsUpdate = this.aAlpha.needsUpdate = this.aRot.needsUpdate = true;
  }

  _move(from, to) {
    if (from === to) return;
    const a = from * 3, b = to * 3;
    for (let c = 0; c < 3; c++) {
      this.pos[b + c] = this.pos[a + c];
      this.vel[b + c] = this.vel[a + c];
      this.col[b + c] = this.col[a + c];
    }
    for (const arr of [this.size, this.alpha, this.rot, this.life, this.maxLife, this.size0, this.size1, this.alpha0, this.grav, this.drag, this.spin]) arr[to] = arr[from];
  }
}

const tmpC = new THREE.Color();

export class Particles {
  constructor(scene, { quality = 'high' } = {}) {
    const scale = quality === 'low' ? 0.4 : quality === 'medium' ? 0.7 : 1;
    this.density = scale;
    this.glow = new Pool(Math.round(3000 * scale), { additive: true, map: TEX.softDotTexture() });
    this.spark = new Pool(Math.round(1500 * scale), { additive: true, map: TEX.starTexture() });
    this.smoke = new Pool(Math.round(1600 * scale), { additive: false, map: TEX.smokeTexture() });
    this.group = new THREE.Group();
    this.group.add(this.glow.points, this.spark.points, this.smoke.points);
    scene.add(this.group);
    this.skids = new SkidMarks(scene, quality === 'low' ? 300 : 900);
  }

  setViewport(heightPx) {
    // point size is in world units * pixels-per-unit at distance 1
    const s = heightPx * 0.9;
    this.glow.mat.uniforms.uScale.value = s;
    this.spark.mat.uniforms.uScale.value = s;
    this.smoke.mat.uniforms.uScale.value = s;
  }

  update(dt) {
    this.glow.update(dt);
    this.spark.update(dt);
    this.smoke.update(dt);
  }

  // ---- effect helpers -------------------------------------------------------
  driftSpark(p, level, side, heading) {
    const cols = [[1, 1, 1], [0.25, 0.65, 1], [1, 0.55, 0.1], [0.85, 0.3, 1]];
    const [r, g, b] = cols[level] || cols[0];
    const n = level > 0 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const a = heading + Math.PI + (Math.random() - 0.5) * 1.4 + side * 0.4;
      const sp = 3 + Math.random() * 5;
      this.spark.emit(p.x, p.y, p.z, Math.sin(a) * sp, 2 + Math.random() * 4, Math.cos(a) * sp, r, g, b, {
        life: 0.25 + Math.random() * 0.2, size: level > 0 ? 0.5 : 0.3, size1: 0.05, grav: 18, drag: 2,
      });
    }
    if (level > 0) this.glow.emit(p.x, p.y + 0.05, p.z, 0, 0, 0, r, g, b, { life: 0.08, size: level * 0.6 + 0.9, alpha: 0.8 });
  }

  boostFlame(p, heading, intensity = 1, color = 0xff8a2a) {
    // additive sprites stack up fast right in front of the chase camera: keep them sparse and dim
    if (Math.random() > 0.6 * this.density) return;
    tmpC.set(color).multiplyScalar(0.55);
    const back = heading + Math.PI;
    const sp = 6 + Math.random() * 4;
    this.glow.emit(p.x, p.y, p.z,
      Math.sin(back) * sp + (Math.random() - 0.5), (Math.random() - 0.2) * 1.5, Math.cos(back) * sp + (Math.random() - 0.5),
      tmpC.r, tmpC.g, tmpC.b, { life: 0.16 + Math.random() * 0.08, size: 0.6 * intensity, size1: 0.15, drag: 3 });
    if (Math.random() < 0.5) this.glow.emit(p.x, p.y, p.z, Math.sin(back) * sp * 0.6, 0, Math.cos(back) * sp * 0.6, 0.5, 0.45, 0.32, { life: 0.07, size: 0.35 * intensity, size1: 0.1 });
  }

  exhaust(p, heading) {
    if (Math.random() > 0.35 * this.density) return;
    const back = heading + Math.PI;
    this.smoke.emit(p.x, p.y, p.z, Math.sin(back) * 1.5, 0.8, Math.cos(back) * 1.5, 0.6, 0.6, 0.65, {
      life: 0.6, size: 0.25, size1: 0.9, alpha: 0.25, drag: 1.2, spin: 1,
    });
  }

  dust(p, color = 0xd8c39a, amount = 1, vx = 0, vz = 0) {
    tmpC.set(color);
    if (Math.random() > amount * this.density) return;
    this.smoke.emit(p.x + (Math.random() - 0.5) * 0.6, p.y + 0.2, p.z + (Math.random() - 0.5) * 0.6,
      vx * 0.3 + (Math.random() - 0.5) * 2, 1 + Math.random() * 1.5, vz * 0.3 + (Math.random() - 0.5) * 2,
      tmpC.r, tmpC.g, tmpC.b, { life: 0.7 + Math.random() * 0.4, size: 0.6, size1: 2.2, alpha: 0.55, drag: 1.5, grav: -0.5, spin: 0.8 });
  }

  tireSmoke(p) {
    if (Math.random() > 0.5 * this.density) return;
    this.smoke.emit(p.x, p.y + 0.15, p.z, (Math.random() - 0.5), 0.6 + Math.random() * 0.5, (Math.random() - 0.5),
      0.85, 0.85, 0.88, { life: 0.8, size: 0.5, size1: 2.0, alpha: 0.3, drag: 1, spin: 1 });
  }

  burst(p, color, count = 30, speed = 10, { size = 0.7, life = 0.6, grav = 10, glow = true } = {}) {
    tmpC.set(color);
    count = Math.round(count * (0.5 + 0.5 * this.density));
    for (let i = 0; i < count; i++) {
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const s = speed * (0.4 + Math.random() * 0.6);
      this.spark.emit(p.x, p.y, p.z, Math.cos(a) * r * s, Math.abs(u) * s * 0.8 + 2, Math.sin(a) * r * s, tmpC.r, tmpC.g, tmpC.b, {
        life: life * (0.6 + Math.random() * 0.6), size, size1: 0.05, grav, drag: 1.5,
      });
    }
    if (glow) this.glow.emit(p.x, p.y, p.z, 0, 0, 0, tmpC.r, tmpC.g, tmpC.b, { life: 0.25, size: speed * 0.6, size1: speed * 0.9, alpha: 0.8 });
  }

  explosion(p) {
    this.glow.emit(p.x, p.y + 1, p.z, 0, 0, 0, 1, 0.8, 0.4, { life: 0.35, size: 6, size1: 16, alpha: 1 });
    for (let i = 0; i < 40 * this.density; i++) {
      const a = Math.random() * Math.PI * 2, s = 4 + Math.random() * 10;
      this.glow.emit(p.x, p.y + 1, p.z, Math.cos(a) * s, Math.random() * 8, Math.sin(a) * s, 1, 0.45 + Math.random() * 0.3, 0.1, {
        life: 0.5 + Math.random() * 0.3, size: 2.2, size1: 0.4, drag: 2.5, grav: -2,
      });
    }
    for (let i = 0; i < 30 * this.density; i++) {
      const a = Math.random() * Math.PI * 2, s = 2 + Math.random() * 6;
      this.smoke.emit(p.x, p.y + 1, p.z, Math.cos(a) * s, 2 + Math.random() * 5, Math.sin(a) * s, 0.25, 0.22, 0.22, {
        life: 1.4 + Math.random() * 0.8, size: 2, size1: 7, alpha: 0.7, drag: 2, grav: -1.2, spin: 0.6,
      });
    }
    this.burst(p, 0xffd27a, 40, 18, { size: 0.5, life: 0.9, grav: 14, glow: false });
  }

  confetti(p, count = 80) {
    const cols = [0xff4d6d, 0x4dd2ff, 0xffd84d, 0x7dff6a, 0xb06bff, 0xffffff];
    for (let i = 0; i < count * this.density; i++) {
      tmpC.set(cols[i % cols.length]);
      const a = Math.random() * Math.PI * 2, s = 2 + Math.random() * 6;
      this.spark.emit(p.x + (Math.random() - 0.5) * 6, p.y + 6 + Math.random() * 4, p.z + (Math.random() - 0.5) * 6,
        Math.cos(a) * s, 4 + Math.random() * 6, Math.sin(a) * s, tmpC.r, tmpC.g, tmpC.b,
        { life: 2.5 + Math.random(), size: 0.45, grav: 4, drag: 1.2, spin: 6 });
    }
  }

  ring(p, color, radius = 4, count = 28) {
    tmpC.set(color);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      this.glow.emit(p.x, p.y + 0.3, p.z, Math.cos(a) * radius * 4, 0.5, Math.sin(a) * radius * 4, tmpC.r, tmpC.g, tmpC.b, {
        life: 0.3, size: 1.2, size1: 0.2, drag: 5,
      });
    }
  }

  sparkle(p, color = 0xffe066) {
    tmpC.set(color);
    this.spark.emit(p.x + (Math.random() - 0.5) * 1.6, p.y + Math.random() * 1.5, p.z + (Math.random() - 0.5) * 1.6,
      0, 1.5, 0, tmpC.r, tmpC.g, tmpC.b, { life: 0.5, size: 0.6, size1: 0.0, spin: 3 });
  }

  dispose(scene) {
    scene.remove(this.group);
    for (const p of [this.glow, this.spark, this.smoke]) { p.geo.dispose(); p.mat.dispose(); }
    this.skids.dispose(scene);
  }
}

// Dark tyre marks left while drifting. Each wheel feeds segments into a shared ring buffer.
export class SkidMarks {
  constructor(scene, maxSeg) {
    this.max = maxSeg;
    this.head = 0;
    const pos = new Float32Array(maxSeg * 4 * 3);
    const alpha = new Float32Array(maxSeg * 4);
    const idx = new Uint32Array(maxSeg * 6);
    for (let i = 0; i < maxSeg; i++) {
      const v = i * 4;
      idx.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], i * 6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uColor: { value: new THREE.Color(0x111114) } }]),
      fog: true,
      vertexShader: `attribute float aAlpha; varying float vA;
        #include <fog_pars_vertex>
        void main(){ vA = aAlpha; vec4 mvPosition = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
        }`,
      fragmentShader: `uniform vec3 uColor; varying float vA;
        #include <fog_pars_fragment>
        void main(){ gl_FragColor = vec4(uColor, vA * 0.55);
        #include <fog_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
    this.last = new Map(); // key -> {x,y,z,lx,lz}
  }

  // call every frame for each wheel; active=false breaks the strip
  add(key, x, y, z, heading, active, strength = 1) {
    const prev = this.last.get(key);
    if (!active) { if (prev) this.last.delete(key); return; }
    const w = 0.22;
    const lx = Math.cos(heading) * w, lz = -Math.sin(heading) * w;
    const cur = { x, y: y + 0.03, z, lx, lz };
    if (!prev) { this.last.set(key, cur); return; }
    const dx = x - prev.x, dz = z - prev.z;
    if (dx * dx + dz * dz < 0.36) return; // segment length ~0.6
    if (dx * dx + dz * dz > 25) { this.last.set(key, cur); return; } // teleport
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    const p = this.geo.attributes.position.array;
    const a = this.geo.attributes.aAlpha.array;
    const o = i * 12;
    p[o] = prev.x - prev.lx; p[o + 1] = prev.y; p[o + 2] = prev.z - prev.lz;
    p[o + 3] = prev.x + prev.lx; p[o + 4] = prev.y; p[o + 5] = prev.z + prev.lz;
    p[o + 6] = x - lx; p[o + 7] = cur.y; p[o + 8] = z - lz;
    p[o + 9] = x + lx; p[o + 10] = cur.y; p[o + 11] = z + lz;
    a[i * 4] = a[i * 4 + 1] = a[i * 4 + 2] = a[i * 4 + 3] = strength;
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
    this.last.set(key, cur);
  }

  clear() {
    this.geo.attributes.aAlpha.array.fill(0);
    this.geo.attributes.aAlpha.needsUpdate = true;
    this.last.clear();
  }

  dispose(scene) {
    scene.remove(this.mesh);
    this.geo.dispose();
    this.mat.dispose();
  }
}
