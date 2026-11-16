// Ardu Snowball — effects: snow particles (puffs, splats, footstep dust,
// sparkles), flying snowball meshes and the aiming arc + landing ring.
import * as THREE from '../libs/three.bundle.js';
import { snowballGeometry, SNOWBALL_MAT } from './models.js';

export const GRAVITY = 9.8;

// ---------------------------------------------------------------- particles
export class Particles {
  constructor(scene, max = 1500, { additive = false } = {}) {
    this.max = max;
    this.n = 0;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    this.life = new Float32Array(max);
    this.ttl = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.alpha0 = new Float32Array(max);
    const g = (this.geo = new THREE.BufferGeometry());
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('aColor', this.aCol);
    g.setAttribute('aSize', this.aSize);
    g.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { uScale: { value: 300 } },
      vertexShader: `attribute vec4 aColor; attribute float aSize; uniform float uScale; varying vec4 vC;
        void main(){ vC = aColor; vec4 mv = modelViewMatrix * vec4(position,1.0);
          float d = -mv.z;
          vC.a *= smoothstep(0.25, 0.9, d);   // fade out right in front of the lens instead of filling the screen
          gl_PointSize = min(aSize * uScale / max(d, 0.25), 160.0); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying vec4 vC; void main(){ vec2 c = gl_PointCoord - 0.5; float d = length(c);
        float a = smoothstep(0.5, 0.1, d) * vC.a; if (a < 0.01) discard; gl_FragColor = vec4(vC.rgb, a); }`,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    scene.add(this.points);
  }

  setScale(h) { this.mat.uniforms.uScale.value = h * 0.5; }

  spawn(x, y, z, vx, vy, vz, { size = 0.15, life = 0.8, color = [1, 1, 1], alpha = 0.9, gravity = 1, drag = 1.5 } = {}) {
    let i = this.n;
    if (i >= this.max) i = Math.floor(Math.random() * this.max);
    else this.n++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.col[i * 4] = color[0]; this.col[i * 4 + 1] = color[1]; this.col[i * 4 + 2] = color[2]; this.col[i * 4 + 3] = alpha;
    this.alpha0[i] = alpha;
    this.size[i] = size;
    this.life[i] = 0;
    this.ttl[i] = life;
    this.grav[i] = gravity;
    this.drag[i] = drag;
  }

  // radial burst of snow
  burst(p, n, { speed = 3, up = 2, size = 0.16, life = 0.9, color = [1, 1, 1], alpha = 0.95, gravity = 1, spread = 1 } = {}) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, s = speed * (0.3 + Math.random() * 0.7) * spread;
      this.spawn(p.x, p.y, p.z, Math.cos(a) * s, up * (0.4 + Math.random()), Math.sin(a) * s,
        { size: size * (0.6 + Math.random() * 0.8), life: life * (0.6 + Math.random() * 0.6), color, alpha, gravity });
    }
  }

  update(dt) {
    let n = this.n;
    for (let i = 0; i < n; i++) {
      this.life[i] += dt;
      if (this.life[i] >= this.ttl[i]) {
        // swap-remove
        n--;
        if (i !== n) {
          for (let k = 0; k < 3; k++) { this.pos[i * 3 + k] = this.pos[n * 3 + k]; this.vel[i * 3 + k] = this.vel[n * 3 + k]; }
          for (let k = 0; k < 4; k++) this.col[i * 4 + k] = this.col[n * 4 + k];
          this.size[i] = this.size[n]; this.life[i] = this.life[n]; this.ttl[i] = this.ttl[n];
          this.grav[i] = this.grav[n]; this.drag[i] = this.drag[n]; this.alpha0[i] = this.alpha0[n];
        }
        i--;
        continue;
      }
      const d = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= d; this.vel[i * 3 + 2] *= d;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d - GRAVITY * 0.35 * this.grav[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      if (this.pos[i * 3 + 1] < 0.02) { this.pos[i * 3 + 1] = 0.02; this.vel[i * 3 + 1] = 0; }
      const f = this.life[i] / this.ttl[i];
      this.col[i * 4 + 3] = this.alpha0[i] * (1 - f * f);
    }
    this.n = n;
    this.geo.setDrawRange(0, n);
    this.aPos.needsUpdate = this.aCol.needsUpdate = this.aSize.needsUpdate = true;
  }

  clear() { this.n = 0; this.geo.setDrawRange(0, 0); }
}

// ---------------------------------------------------------------- snowball meshes
export class BallPool {
  constructor(scene, max = 48) {
    this.mesh = new THREE.InstancedMesh(snowballGeometry(0.11), SNOWBALL_MAT, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.max = max;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3(1, 1, 1);
    this._e = new THREE.Euler();
    scene.add(this.mesh);
  }

  // balls: [{p: Vector3, spin}]
  draw(balls) {
    const n = Math.min(this.max, balls.length);
    for (let i = 0; i < n; i++) {
      const b = balls[i];
      this._e.set(b.age * 9, b.age * 7, 0);
      this._q.setFromEuler(this._e);
      this.mesh.setMatrixAt(i, this._m.compose(b.p, this._q, this._s));
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- aiming arc + landing ring
export class AimGuide {
  constructor(scene) {
    const N = 40;
    this.N = N;
    const g = new THREE.BufferGeometry();
    this.arr = new Float32Array(N * 3);
    g.setAttribute('position', new THREE.BufferAttribute(this.arr, 3).setUsage(THREE.DynamicDrawUsage));
    this.dots = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 0.07, transparent: true, opacity: 0.55, depthWrite: false }));
    this.dots.frustumCulled = false;
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.75, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x8fd8ff, transparent: true, opacity: 0.7, depthWrite: false, toneMapped: false }));
    this.inner = new THREE.Mesh(new THREE.CircleGeometry(0.18, 20).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false }));
    this.ring.renderOrder = this.inner.renderOrder = 2;
    scene.add(this.dots, this.ring, this.inner);
    this.visible = false;
    this.set(false);
  }

  set(v) {
    this.visible = v;
    this.dots.visible = this.ring.visible = this.inner.visible = v;
  }

  // simulate a throw (origin, velocity) against the world; shows the arc and the landing ring
  update(world, origin, vel, t, lock = false) {
    const p = origin.clone(), v = vel.clone();
    const dt = 0.03;
    let k = 0, landed = null;
    const every = 2;
    for (let i = 0; i < 160; i++) {
      v.y -= GRAVITY * dt;
      p.addScaledVector(v, dt);
      if (i % every === 0 && k < this.N) { this.arr[k * 3] = p.x; this.arr[k * 3 + 1] = p.y; this.arr[k * 3 + 2] = p.z; k++; }
      if (world.solidAt(p.x, p.y, p.z)) { landed = p; break; }
    }
    for (let j = k; j < this.N; j++) { this.arr[j * 3] = p.x; this.arr[j * 3 + 1] = p.y; this.arr[j * 3 + 2] = p.z; }
    this.dots.geometry.attributes.position.needsUpdate = true;
    if (landed) {
      const y = Math.max(0.03, Math.min(landed.y, 2.5)) + 0.03;
      this.ring.position.set(landed.x, y, landed.z);
      this.inner.position.copy(this.ring.position);
      const s = 1 + Math.sin(t * 6) * 0.08;
      this.ring.scale.setScalar(s);
      this.ring.material.color.setHex(lock ? 0xff6a4a : 0x8fd8ff);
    }
    this.ring.visible = this.inner.visible = this.visible && !!landed;
    return landed;
  }
}
