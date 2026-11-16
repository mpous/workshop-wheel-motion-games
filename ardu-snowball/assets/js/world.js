// Ardu Snowball — the alpine arena: terrain, sky, lights, blue and red snow
// forts, mid-field walls, frozen pond, pines, mountains, snowfall and the two
// stars. Also the collision world (oriented boxes + circles) used by players,
// bots and snowballs.
import * as THREE from '../libs/three.bundle.js';
import { clamp, smoothstep, makeRng, makeNoise2D } from './util.js';

export const ARENA = { halfW: 34, halfL: 58, baseZ: 48 };
export const TEAM_COLOR = [0x2f8bff, 0xff4141];
export const TEAM_CSS = ['#3b8cff', '#ff4b4b'];
export const TEAM_NAME = ['BLUE', 'RED'];
// team 0 (blue) defends z < 0, team 1 (red) z > 0
export const teamSign = (team) => (team === 0 ? -1 : 1);
export const starHome = (team) => new THREE.Vector3(0, 1.25, teamSign(team) * 49);
export function spawnPoint(team, slot) {
  const s = teamSign(team);
  const x = [-3.2, 3.2, 0, -5.5, 5.5, -1.6, 1.6, 0][slot % 8];
  return { x, z: s * (52.5 - (slot >= 3 ? 1.6 : 0)), yaw: s < 0 ? Math.PI : 0 };
}
// capture zone: inside the own fort
export function inBase(team, x, z) {
  const s = teamSign(team);
  return Math.abs(x) < 8.6 && z * s > 44.9 && z * s < 55.4;
}

const FIELD_SNOW = 0xf2f6ff;

// ---------------------------------------------------------------- textures
function canvasTex(size, draw, { repeat = 1, srgb = true } = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// normal map from a tileable value-noise height field (soft snow drifts + sparkle grain)
function snowNormals(size = 256, seed = 3) {
  const noise = makeNoise2D(seed);
  const h = new Float32Array(size * size);
  const per = size / 32;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      // tileable: sample the noise on a torus
      const a = (x / size) * Math.PI * 2, b = (y / size) * Math.PI * 2;
      const nx = Math.cos(a) * per, ny = Math.sin(a) * per, nz = Math.cos(b) * per, nw = Math.sin(b) * per;
      h[y * size + x] = noise.fbm(nx + nz * 0.7, ny + nw * 0.7, 4) * 0.8 + noise.fbm(nx * 4 + nw, ny * 4 + nz, 2) * 0.2;
    }
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const at = (x, y) => h[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 6;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 6;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      img.data[i] = (-dx / l * 0.5 + 0.5) * 255;
      img.data[i + 1] = (-dy / l * 0.5 + 0.5) * 255;
      img.data[i + 2] = (1 / l * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function brickTex() {
  return canvasTex(256, (g, s) => {
    g.fillStyle = '#eef3fb';
    g.fillRect(0, 0, s, s);
    const rng = makeRng(11);
    const rows = 4, bh = s / rows;
    for (let r = 0; r < rows; r++) {
      const off = r % 2 ? s / 6 : 0;
      for (let k = -1; k < 3; k++) {
        const x = off + k * (s / 3);
        const shade = 232 + rng.int(0, 16);
        g.fillStyle = `rgb(${shade - 6},${shade},${Math.min(255, shade + 8)})`;
        g.fillRect(x + 3, r * bh + 3, s / 3 - 6, bh - 6);
      }
      g.fillStyle = 'rgba(150,175,210,0.55)';
      g.fillRect(0, r * bh, s, 3);
      for (let k = -1; k < 4; k++) g.fillRect(off + k * (s / 3) - 1, r * bh, 3, bh);
    }
    for (let i = 0; i < 900; i++) {
      g.fillStyle = `rgba(${rng.int(170, 210)},${rng.int(195, 225)},255,${rng.range(0.05, 0.2)})`;
      g.fillRect(rng.int(0, s), rng.int(0, s), 2, 2);
    }
  });
}

function woodTex() {
  return canvasTex(256, (g, s) => {
    const rng = makeRng(5);
    for (let i = 0; i < 8; i++) {
      const y = i * (s / 8);
      g.fillStyle = `hsl(28, ${38 + rng.int(0, 12)}%, ${30 + rng.int(0, 10)}%)`;
      g.fillRect(0, y, s, s / 8);
      g.fillStyle = 'rgba(30,15,5,0.6)';
      g.fillRect(0, y, s, 2);
      for (let k = 0; k < 14; k++) {
        g.strokeStyle = `rgba(60,30,10,${rng.range(0.1, 0.35)})`;
        g.beginPath();
        const yy = y + rng.range(4, s / 8 - 4);
        g.moveTo(0, yy);
        g.bezierCurveTo(s * 0.3, yy + rng.range(-3, 3), s * 0.6, yy + rng.range(-3, 3), s, yy);
        g.stroke();
      }
    }
    // dusting of snow
    for (let i = 0; i < 500; i++) {
      g.fillStyle = `rgba(245,250,255,${rng.range(0.2, 0.7)})`;
      g.beginPath();
      g.arc(rng.range(0, s), rng.range(0, s), rng.range(1, 4), 0, Math.PI * 2);
      g.fill();
    }
  }, { repeat: 2 });
}

function iceTex() {
  return canvasTex(512, (g, s) => {
    const grad = g.createRadialGradient(s / 2, s / 2, 10, s / 2, s / 2, s / 2);
    grad.addColorStop(0, '#9fd3ef');
    grad.addColorStop(0.7, '#7fb8dc');
    grad.addColorStop(1, '#d9eefa');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
    const rng = makeRng(21);
    // cracks
    for (let i = 0; i < 26; i++) {
      let x = rng.range(0, s), y = rng.range(0, s), a = rng.range(0, Math.PI * 2);
      g.strokeStyle = `rgba(255,255,255,${rng.range(0.25, 0.7)})`;
      g.lineWidth = rng.range(0.6, 1.8);
      g.beginPath();
      g.moveTo(x, y);
      for (let k = 0; k < 9; k++) {
        a += rng.range(-0.7, 0.7);
        x += Math.cos(a) * rng.range(8, 26);
        y += Math.sin(a) * rng.range(8, 26);
        g.lineTo(x, y);
      }
      g.stroke();
    }
    for (let i = 0; i < 60; i++) {
      g.fillStyle = `rgba(255,255,255,${rng.range(0.05, 0.25)})`;
      g.beginPath();
      g.ellipse(rng.range(0, s), rng.range(0, s), rng.range(6, 40), rng.range(2, 8), rng.range(0, 3), 0, Math.PI * 2);
      g.fill();
    }
  });
}

export function glowTexture(inner = 'rgba(255,255,255,1)', mid = 'rgba(255,255,255,0.35)') {
  return canvasTex(128, (g, s) => {
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, inner);
    grad.addColorStop(0.25, mid);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  }, { repeat: 1 });
}

export function starShape(outer = 0.55, inner = 0.24) {
  const shape = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? inner : outer;
    const a = Math.PI / 2 + (i * Math.PI) / 5;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
  }
  shape.closePath();
  return shape;
}

export function starGeometry(outer = 0.55, depth = 0.18) {
  const g = new THREE.ExtrudeGeometry(starShape(outer, outer * 0.44), {
    depth, bevelEnabled: true, bevelThickness: depth * 0.4, bevelSize: outer * 0.07, bevelSegments: 2,
  });
  g.center();
  return g;
}

// ---------------------------------------------------------------- collision helpers
function boxContains(b, x, z, pad = 0) {
  const dx = x - b.x, dz = z - b.z;
  const c = Math.cos(b.rot || 0), s = Math.sin(b.rot || 0);
  const lx = dx * c - dz * s, lz = dx * s + dz * c;
  return Math.abs(lx) < b.hw + pad && Math.abs(lz) < b.hd + pad;
}

// ---------------------------------------------------------------- world
export class World {
  constructor(app) {
    this.app = app;
    this.scene = app.scene;
    this.q = app.q;
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.boxes = [];
    this.circles = [];
    this.ice = [];           // {x, z, r} slippery, no snow
    this.decks = [];         // {x, z, hw, hd} wooden floors, no snow
    this.flags = [];
    this.time = 0;
    this.bloomThreshold = 1.45;
    const el = 17 * Math.PI / 180, az = -0.55;
    this.sunDir = new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize();
    this.noise = makeNoise2D(7);
    this.mat = this._materials();
    this._sky();
    this._lights();
    this._terrain();
    this._layout();
    this._pond();
    this._forest();
    this._mountains();
    this._snowfall();
    this._stars();
  }

  // ------------------------------------------------------------------ materials
  _materials() {
    const n = snowNormals(256);
    const snow = new THREE.MeshStandardMaterial({ color: FIELD_SNOW, roughness: 0.82, metalness: 0, normalMap: n, normalScale: new THREE.Vector2(0.6, 0.6) });
    snow.normalMap.repeat.set(40, 40);
    const wallN = n.clone();
    wallN.repeat.set(1, 1);
    const wall = new THREE.MeshStandardMaterial({ color: 0xcfdbea, map: brickTex(), roughness: 0.78, normalMap: wallN, normalScale: new THREE.Vector2(0.35, 0.35) });
    const cap = new THREE.MeshStandardMaterial({ color: 0xe2eaf5, roughness: 0.9 });
    const wood = new THREE.MeshStandardMaterial({ map: woodTex(), roughness: 0.85 });
    const darkWood = new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.9 });
    const ice = new THREE.MeshPhysicalMaterial({ color: 0xffffff, map: iceTex(), roughness: 0.06, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.3 });
    const rock = new THREE.MeshStandardMaterial({ color: 0x7e8794, roughness: 0.95, flatShading: true });
    return { snow, wall, cap, wood, darkWood, ice, rock };
  }

  _sky() {
    const sky = (this.sky = new THREE.Sky());
    sky.scale.setScalar(4500);
    const u = sky.material.uniforms;
    u.turbidity.value = 2.2;
    u.rayleigh.value = 1.1;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.82;
    u.sunPosition.value.copy(this.sunDir);
    if (u.cloudCoverage) { u.cloudCoverage.value = 0.45; u.cloudDensity.value = 0.5; u.cloudElevation.value = 0.5; }
    this.group.add(sky);
    const pm = new THREE.PMREMGenerator(this.app.renderer);
    const envScene = new THREE.Scene();
    const s2 = new THREE.Sky();
    s2.scale.setScalar(900);
    for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG']) s2.material.uniforms[k].value = u[k].value;
    s2.material.uniforms.sunPosition.value.copy(this.sunDir);
    if (s2.material.uniforms.showSunDisc) s2.material.uniforms.showSunDisc.value = 0;
    envScene.add(s2);
    // a bright snowy floor in the environment so the ice reflects the field
    const floor = new THREE.Mesh(new THREE.CircleGeometry(800, 16).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xc8d6ea }));
    floor.position.y = -5;
    envScene.add(floor);
    this.envMap = pm.fromScene(envScene, 0, 0.1, 1000).texture;
    this.scene.environment = this.envMap;
    this.scene.environmentIntensity = 0.6;
    pm.dispose();
    this.scene.fog = new THREE.FogExp2(0xcfdcf0, 0.0034);
  }

  _lights() {
    this.hemi = new THREE.HemisphereLight(0xcfe2ff, 0x8796b0, 0.75);
    this.group.add(this.hemi);
    const sun = (this.sun = new THREE.DirectionalLight(0xfff0dc, 2.0));
    sun.castShadow = !!this.q.shadows;
    if (sun.castShadow) {
      const sz = this.q.shadowSize || 1024;
      sun.shadow.mapSize.set(sz, sz);
      const c = sun.shadow.camera;
      const e = 46;
      c.left = -e; c.right = e; c.top = e; c.bottom = -e; c.near = 1; c.far = 320;
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 0.04;
    }
    this.group.add(sun, sun.target);
    this._shadowFocus = new THREE.Vector3();
    this._placeSun(new THREE.Vector3());
  }

  _placeSun(focus) {
    // follow the camera, snapped to shadow texels so the shadows do not swim
    const step = 2;
    const fx = Math.round(focus.x / step) * step, fz = Math.round(focus.z / step) * step;
    this.sun.target.position.set(fx, 0, fz);
    this.sun.position.set(fx, 0, fz).addScaledVector(this.sunDir, 150);
    this.sun.target.updateMatrixWorld();
  }

  // ------------------------------------------------------------------ terrain
  groundHeight(x, z) {
    // flat playfield, rising into snowy hills outside the perimeter banks
    const ox = Math.max(0, Math.abs(x) - (ARENA.halfW + 3));
    const oz = Math.max(0, Math.abs(z) - (ARENA.halfL + 3));
    const d = Math.hypot(ox, oz);
    if (d <= 0) return 0;
    const n = this.noise.fbm(x * 0.012, z * 0.012, 4) * 0.5 + 0.5;
    return smoothstep(0, 60, d) * (6 + n * 26) + d * 0.08;
  }

  _terrain() {
    const size = 900, seg = 150;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg).rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const col = new Float32Array(pos.count * 3);
    const cA = new THREE.Color(FIELD_SNOW), cB = new THREE.Color(0xdbe6f6), cC = new THREE.Color(0xb9c9e2);
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const h = this.groundHeight(x, z);
      pos.setY(i, h - 0.001);
      const n = this.noise.fbm(x * 0.05, z * 0.05, 2) * 0.5 + 0.5;
      tmp.copy(cA).lerp(cB, clamp(n * 0.8, 0, 1)).lerp(cC, clamp(h / 40, 0, 0.5));
      col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();
    const mat = this.mat.snow.clone();
    mat.vertexColors = true;
    mat.color.set(0xffffff);
    const m = new THREE.Mesh(geo, mat);
    m.receiveShadow = true;
    this.group.add(m);
    this.ground = m;
  }

  // ------------------------------------------------------------------ colliders + meshes
  _addWall(x, z, hw, hd, h, rot = 0, { visible = true, cap = true } = {}) {
    const b = { x, z, hw, hd, h, rot };
    this.boxes.push(b);
    if (!visible) return b;
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(hw * 2, h, hd * 2), this.mat.wall);
    // texture scale per wall (UVs in metres)
    const uv = body.geometry.attributes.uv;
    const p = body.geometry.attributes.position;
    const nrm = body.geometry.attributes.normal;
    for (let i = 0; i < uv.count; i++) {
      const ax = Math.abs(nrm.getX(i)) > 0.5 ? p.getZ(i) : p.getX(i);
      uv.setXY(i, (ax + 10) / 1.8, (p.getY(i) + h / 2) / 1.6);
    }
    body.position.y = h / 2;
    body.castShadow = body.receiveShadow = true;
    g.add(body);
    if (cap) {
      // snow cap: a flat slab plus a rounded drift on top
      const capBox = new THREE.Mesh(new THREE.BoxGeometry(hw * 2 + 0.12, 0.16, hd * 2 + 0.12), this.mat.cap);
      capBox.position.y = h + 0.05;
      capBox.castShadow = true;
      g.add(capBox);
      const lump = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), this.mat.cap);
      lump.scale.set(hw + 0.06, 0.18, hd + 0.06);
      lump.position.y = h + 0.12;
      lump.castShadow = true;
      g.add(lump);
    }
    g.position.set(x, 0, z);
    g.rotation.y = -rot;
    this.group.add(g);
    return b;
  }

  _addTower(x, z, r, h, team) {
    this.circles.push({ x, z, r, h });
    const g = new THREE.Group();
    const geo = new THREE.CylinderGeometry(r, r * 1.08, h, 18, 1);
    const uv = geo.attributes.uv, p = geo.attributes.position;
    for (let i = 0; i < uv.count; i++) uv.setY(i, (p.getY(i) + h / 2) / 1.6);
    for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * 4.5);
    const body = new THREE.Mesh(geo, this.mat.wall);
    body.position.y = h / 2;
    body.castShadow = body.receiveShadow = true;
    g.add(body);
    // crenellations
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const c = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.45, 0.45), this.mat.cap);
      c.position.set(Math.cos(a) * (r - 0.15), h + 0.22, Math.sin(a) * (r - 0.15));
      c.rotation.y = -a;
      c.castShadow = true;
      g.add(c);
    }
    // flag pole + team flag
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 2.6, 6), this.mat.darkWood);
    pole.position.y = h + 1.3;
    g.add(pole);
    const fgeo = new THREE.PlaneGeometry(1.3, 0.8, 8, 2);
    fgeo.translate(0.65, 0, 0);
    const flag = new THREE.Mesh(fgeo, new THREE.MeshStandardMaterial({ color: TEAM_COLOR[team], side: THREE.DoubleSide, roughness: 0.7, emissive: TEAM_COLOR[team], emissiveIntensity: 0.25 }));
    flag.position.y = h + 2.15;
    flag.castShadow = true;
    flag.userData.base = Float32Array.from(fgeo.attributes.position.array);
    g.add(flag);
    this.flags.push(flag);
    g.position.set(x, 0, z);
    this.group.add(g);
  }

  _addSnowman(x, z, rot = 0) {
    this.circles.push({ x, z, r: 0.75, h: 2.1 });
    const g = new THREE.Group();
    const m = this.mat.cap;
    const s1 = new THREE.Mesh(new THREE.SphereGeometry(0.75, 18, 12), m); s1.position.y = 0.62;
    const s2 = new THREE.Mesh(new THREE.SphereGeometry(0.55, 18, 12), m); s2.position.y = 1.45;
    const s3 = new THREE.Mesh(new THREE.SphereGeometry(0.38, 18, 12), m); s3.position.y = 2.05;
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.38, 8).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.6 }));
    nose.position.set(0, 2.05, 0.48);
    const coal = new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.5 });
    for (const [px, py] of [[-0.13, 2.15], [0.13, 2.15]]) { const e = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), coal); e.position.set(px, py, 0.33); g.add(e); }
    for (let i = 0; i < 3; i++) { const b = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), coal); b.position.set(0, 1.25 + i * 0.2, 0.52 - Math.abs(i - 1) * 0.02); g.add(b); }
    const hat = new THREE.Group();
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.05, 16), coal);
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.4, 16), coal);
    top.position.y = 0.22;
    hat.add(brim, top);
    hat.position.y = 2.38;
    hat.rotation.z = 0.12;
    const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.09, 8, 18).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xffd23a, roughness: 0.8 }));
    scarf.position.y = 1.78;
    for (const o of [s1, s2, s3, nose, hat, scarf]) g.add(o);
    // stick arms
    for (const sgn of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.035, 0.9, 5), this.mat.darkWood);
      arm.position.set(sgn * 0.85, 1.6, 0);
      arm.rotation.z = sgn * -1.0;
      g.add(arm);
    }
    g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    g.position.set(x, 0, z);
    g.rotation.y = rot;
    this.group.add(g);
  }

  _fort(team) {
    const s = teamSign(team);
    const H = 1.6;
    this._addWall(0, s * 55.4, 9.3, 0.6, H);
    this._addWall(-9, s * 50, 0.6, 5.4, H);
    this._addWall(9, s * 50, 0.6, 5.4, H);
    this._addWall(-6.1, s * 44.6, 2.9, 0.6, H);
    this._addWall(6.1, s * 44.6, 2.9, 0.6, H);
    for (const x of [-9, 9]) for (const z of [44.6, 55.4]) this._addTower(x, s * z, 1.3, 3.2, team);
    // wooden deck (no snow to scoop here)
    const deck = new THREE.Mesh(new THREE.BoxGeometry(16.8, 0.14, 10.1), this.mat.wood);
    deck.position.set(0, 0.07, s * 50);
    deck.receiveShadow = true;
    this.group.add(deck);
    this.decks.push({ x: 0, z: s * 50, hw: 8.5, hd: 5.1 });
    // team banner rug at the gate
    const rug = new THREE.Mesh(new THREE.PlaneGeometry(5.4, 1.6).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: TEAM_COLOR[team], roughness: 0.9 }));
    rug.position.set(0, 0.145, s * 46);
    rug.receiveShadow = true;
    this.group.add(rug);
    // ice pedestal for the star
    this.circles.push({ x: 0, z: s * 49, r: 0.55, h: 0.9 });
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.75, 0.9, 8), this.mat.ice);
    ped.position.set(0, 0.45 + 0.14, s * 49);
    ped.castShadow = ped.receiveShadow = true;
    this.group.add(ped);
    // ring of team light on the deck around the pedestal
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.25, 1.55, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: TEAM_COLOR[team], transparent: true, opacity: 0.8, toneMapped: false }));
    ring.position.set(0, 0.15, s * 49);
    this.group.add(ring);
    (this.baseRings ||= [])[team] = ring;
    // ammo crates of snow (decoration) and a bench
    const crate = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.6, 0.8), this.mat.wood);
    crate.position.set(-6.5, 0.44, s * 53.5);
    crate.castShadow = true;
    this.group.add(crate);
    const pile = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), this.mat.cap);
    pile.scale.set(1, 0.5, 0.75);
    pile.position.set(-6.5, 0.74, s * 53.5);
    this.group.add(pile);
    this.boxes.push({ x: -6.5, z: s * 53.5, hw: 0.55, hd: 0.4, h: 0.75, rot: 0 });
  }

  _layout() {
    this._fort(0);
    this._fort(1);
    // mirrored mid-field cover (low 1.2 m walls can be thrown over)
    for (const s of [-1, 1]) {
      this._addWall(0, s * 31, 5, 0.5, 1.2);
      this._addWall(-16, s * 24, 3.5, 0.5, 1.6, s * 0.35);
      this._addWall(16, s * 24, 3.5, 0.5, 1.6, -s * 0.35);
      this._addWall(-25, s * 37, 0.5, 4, 1.6);
      this._addWall(25, s * 37, 0.5, 4, 1.6);
      this._addWall(-9, s * 13, 3, 0.5, 1.2, -s * 0.25);
      this._addWall(9, s * 13, 3, 0.5, 1.2, s * 0.25);
      this._addWall(s * 27.5, 0, 0.5, 5, 1.6);
      this._addSnowman(-6, s * 21, s < 0 ? 0 : Math.PI);
      this._addSnowman(6, s * 21, s < 0 ? 0 : Math.PI);
    }
    this._addSnowman(-15, 0, Math.PI / 2);
    this._addSnowman(15, 0, -Math.PI / 2);
    // perimeter snowbanks (invisible boxes + rounded drifts)
    const W = ARENA.halfW, L = ARENA.halfL;
    this._addWall(-(W + 1), 0, 1, L + 2, 2.4, 0, { visible: false });
    this._addWall(W + 1, 0, 1, L + 2, 2.4, 0, { visible: false });
    this._addWall(0, -(L + 1), W + 2, 1, 2.4, 0, { visible: false });
    this._addWall(0, L + 1, W + 2, 1, 2.4, 0, { visible: false });
    const bankGeo = new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    const banks = [];
    const rng = makeRng(99);
    const addBank = (x, z, sx, sz) => banks.push([x, z, sx, sz, rng.range(1.6, 2.6)]);
    for (let z = -L; z <= L; z += 5) { addBank(-(W + 1.6), z + rng.range(-1, 1), 2.4, 3.8); addBank(W + 1.6, z + rng.range(-1, 1), 2.4, 3.8); }
    for (let x = -W; x <= W; x += 5) { addBank(x + rng.range(-1, 1), -(L + 1.6), 3.8, 2.4); addBank(x + rng.range(-1, 1), L + 1.6, 3.8, 2.4); }
    const inst = new THREE.InstancedMesh(bankGeo, this.mat.cap, banks.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), ps = new THREE.Vector3();
    banks.forEach(([x, z, sx, sz, h], i) => {
      ps.set(x, -0.2, z); sc.set(sx, h, sz);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.range(0, Math.PI));
      inst.setMatrixAt(i, m4.compose(ps, q, sc));
    });
    inst.castShadow = inst.receiveShadow = true;
    this.group.add(inst);
    // ice patches
    this.ice.push({ x: 0, z: 0, r: 9 });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) this.ice.push({ x: sx * 20, z: sz * 14, r: 3.5 });
    // a few rock outcrops in the corners (circle colliders)
    for (const [x, z, r] of [[-30, -18, 1.4], [30, 18, 1.4], [-31, 26, 1.1], [31, -26, 1.1]]) {
      this.circles.push({ x, z, r, h: 1.4 });
      const rk = new THREE.Mesh(new THREE.DodecahedronGeometry(r * 1.05, 0), this.mat.rock);
      rk.position.set(x, r * 0.45, z);
      rk.scale.y = 0.75;
      rk.rotation.set(rng.range(0, 3), rng.range(0, 3), 0);
      rk.castShadow = rk.receiveShadow = true;
      const cap = new THREE.Mesh(new THREE.SphereGeometry(r * 0.9, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), this.mat.cap);
      cap.position.set(x, r * 0.9, z);
      cap.scale.y = 0.35;
      this.group.add(rk, cap);
    }
  }

  _pond() {
    for (const p of this.ice) {
      const m = new THREE.Mesh(new THREE.CircleGeometry(p.r, 48).rotateX(-Math.PI / 2), this.mat.ice);
      m.position.set(p.x, 0.02, p.z);
      m.receiveShadow = true;
      this.group.add(m);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(p.r + 0.05, 0.22, 6, 48).rotateX(Math.PI / 2), this.mat.cap);
      rim.position.set(p.x, 0.0, p.z);
      rim.scale.y = 0.5;
      rim.receiveShadow = true;
      this.group.add(rim);
    }
  }

  _pineGeometry() {
    const parts = [];
    const col = (geo, c) => {
      const n = geo.attributes.position.count, arr = new Float32Array(n * 3), cc = new THREE.Color(c);
      for (let i = 0; i < n; i++) { arr[i * 3] = cc.r; arr[i * 3 + 1] = cc.g; arr[i * 3 + 2] = cc.b; }
      geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      return geo;
    };
    const trunk = new THREE.CylinderGeometry(0.18, 0.26, 1.6, 6).translate(0, 0.8, 0);
    parts.push(col(trunk, 0x4a2e1b));
    const tiers = 4;
    for (let i = 0; i < tiers; i++) {
      const r = 2.1 - i * 0.42, h = 2.2 - i * 0.25, y = 1.2 + i * 1.25;
      const g = new THREE.ConeGeometry(r, h, 9, 1).translate(0, y + h / 2, 0);
      // snow on the upper side of each tier: colour by normal Y
      const n = g.attributes.position.count, arr = new Float32Array(n * 3);
      const green = new THREE.Color(0x1f4d33), white = new THREE.Color(0xeef4ff), tmp = new THREE.Color();
      const pos = g.attributes.position;
      for (let k = 0; k < n; k++) {
        const ly = (pos.getY(k) - y) / h;    // 0 bottom .. 1 tip
        tmp.copy(green).lerp(white, ly > 0.55 ? 0.9 : ly < 0.05 ? 0.55 : 0.12);
        arr[k * 3] = tmp.r; arr[k * 3 + 1] = tmp.g; arr[k * 3 + 2] = tmp.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      parts.push(g);
    }
    const merged = THREE.BufferGeometryUtils.mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)));
    merged.computeVertexNormals();
    return merged;
  }

  _forest() {
    const geo = this._pineGeometry();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
    const rng = makeRng(42);
    const spots = [];
    let tries = 0;
    while (spots.length < 420 && tries++ < 8000) {
      const x = rng.range(-220, 220), z = rng.range(-240, 240);
      const insideX = Math.abs(x) < ARENA.halfW + 5, insideZ = Math.abs(z) < ARENA.halfL + 5;
      if (insideX && insideZ) continue;
      // clusters: denser near the field, sparser far away
      const d = Math.max(Math.abs(x) - ARENA.halfW, Math.abs(z) - ARENA.halfL);
      if (rng.range(0, 1) < d / 260) continue;
      if (this.noise.fbm(x * 0.03, z * 0.03, 2) < -0.05) continue;
      spots.push([x, z]);
    }
    const inst = new THREE.InstancedMesh(geo, mat, spots.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    spots.forEach(([x, z], i) => {
      const s = rng.range(0.8, 1.7);
      p.set(x, this.groundHeight(x, z) - 0.2, z);
      q.setFromAxisAngle(up, rng.range(0, Math.PI * 2));
      sc.set(s, s * rng.range(0.9, 1.25), s);
      inst.setMatrixAt(i, m4.compose(p, q, sc));
    });
    inst.castShadow = !!this.q.shadows;
    inst.receiveShadow = true;
    this.group.add(inst);
    this.pines = inst;
  }

  _mountains() {
    const rng = makeRng(77);
    const noise = makeNoise2D(13);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true });
    const rockC = new THREE.Color(0x6d7889), snowC = new THREE.Color(0xf4f8ff), tmp = new THREE.Color();
    const parts = [];
    const count = 16;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + rng.range(-0.12, 0.12);
      const r = rng.range(290, 390);
      const R = rng.range(70, 120), H = rng.range(80, 150);
      const g = new THREE.IcosahedronGeometry(1, 3);
      const pos = g.attributes.position;
      for (let k = 0; k < pos.count; k++) {
        let x = pos.getX(k), y = pos.getY(k), z = pos.getZ(k);
        const n = noise.fbm(x * 2.1 + i * 3, z * 2.1 + y * 1.7, 4) * 0.5 + 0.5;
        const s = 1 + (n - 0.5) * 0.7;
        x *= R * s; z *= R * s;
        y = y < 0 ? -10 : Math.pow(y, 1.4) * H * (0.75 + n * 0.5);
        pos.setXYZ(k, x, y, z);
      }
      g.translate(Math.cos(a) * r, -6, Math.sin(a) * r);
      const ng = g.index ? g.toNonIndexed() : g;
      const p2 = ng.attributes.position;
      const col = new Float32Array(p2.count * 3);
      ng.computeVertexNormals();
      const nrm = ng.attributes.normal;
      for (let k = 0; k < p2.count; k += 3) {
        const y = (p2.getY(k) + p2.getY(k + 1) + p2.getY(k + 2)) / 3;
        const ny = (nrm.getY(k) + nrm.getY(k + 1) + nrm.getY(k + 2)) / 3;
        const snowy = y > H * 0.35 && ny > 0.45 ? 1 : y > H * 0.15 && ny > 0.7 ? 1 : y < 25 ? 1 : 0;
        tmp.copy(snowy ? snowC : rockC);
        for (let j = 0; j < 3; j++) { col[(k + j) * 3] = tmp.r; col[(k + j) * 3 + 1] = tmp.g; col[(k + j) * 3 + 2] = tmp.b; }
      }
      ng.setAttribute('color', new THREE.BufferAttribute(col, 3));
      ng.deleteAttribute('uv');
      parts.push(ng);
    }
    const merged = THREE.BufferGeometryUtils.mergeGeometries(parts);
    const m = new THREE.Mesh(merged, mat);
    this.group.add(m);
  }

  _snowfall() {
    const n = this.q.post ? 9000 : 4000;
    const B = 70;
    const pos = new Float32Array(n * 3), rnd = new Float32Array(n);
    const rng = makeRng(5);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = rng.range(0, B); pos[i * 3 + 1] = rng.range(0, 34); pos[i * 3 + 2] = rng.range(0, B);
      rnd[i] = rng.range(0, 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uSize: { value: 48 * (this.app.renderer.getPixelRatio() || 1) }, uWind: { value: new THREE.Vector2(0.6, 0.2) } },
      vertexShader: `
        uniform float uTime; uniform vec3 uCam; uniform float uSize; uniform vec2 uWind;
        attribute float aRand; varying float vA;
        void main(){
          vec3 p = position;
          float B = 70.0;
          p.y -= uTime * (0.9 + aRand * 0.9);
          p.x += uTime * uWind.x + sin(uTime * 0.8 + aRand * 31.0) * 0.7;
          p.z += uTime * uWind.y + cos(uTime * 0.6 + aRand * 17.0) * 0.5;
          vec3 base = uCam - vec3(B * 0.5, 8.0, B * 0.5);
          p.xz = mod(p.xz - base.xz, B) + base.xz;
          p.y = mod(p.y - base.y, 34.0) + base.y;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float d = -mv.z;
          vA = smoothstep(0.3, 2.0, d) * (1.0 - smoothstep(22.0, 34.0, d));
          gl_PointSize = uSize * (0.35 + aRand * 0.65) / max(d, 0.5);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying float vA;
        void main(){
          vec2 c = gl_PointCoord - 0.5;
          float a = smoothstep(0.5, 0.15, length(c)) * vA * 0.9;
          if (a < 0.01) discard;
          gl_FragColor = vec4(1.0, 1.0, 1.0, a);
        }`,
    });
    const pts = new THREE.Points(g, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 5;
    this.group.add(pts);
    this.snow = pts;
  }

  // ------------------------------------------------------------------ stars
  _stars() {
    const geo = starGeometry(0.55, 0.16);
    const glowT = glowTexture();
    this.stars = [0, 1].map((team) => {
      const g = new THREE.Group();
      const c = new THREE.Color(TEAM_COLOR[team]);
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 2.6, roughness: 0.3, metalness: 0.4 }));
      mesh.castShadow = true;
      g.add(mesh);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowT, color: c, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.9 }));
      glow.scale.setScalar(3.2);
      g.add(glow);
      // vertical beacon so the star can be found from anywhere
      const beamMat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        uniforms: { uColor: { value: c.clone() }, uTime: { value: 0 }, uOpacity: { value: 1 } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: `uniform vec3 uColor; uniform float uTime; uniform float uOpacity; varying vec2 vUv;
          void main(){ float edge = sin(vUv.x * 3.14159); float a = pow(1.0 - vUv.y, 1.6) * edge * 0.55;
          a *= 0.75 + 0.25 * sin(vUv.y * 40.0 - uTime * 4.0); gl_FragColor = vec4(uColor * 1.6, a * uOpacity); }`,
      });
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.42, 26, 16, 1, true).translate(0, 13, 0), beamMat);
      beam.renderOrder = 4;
      const root = new THREE.Group();
      root.add(g, beam);
      const light = new THREE.PointLight(c, 4, 9, 2);
      light.position.y = 0.2;
      g.add(light);
      this.group.add(root);
      const home = starHome(team);
      root.position.copy(home);
      return { root, spin: g, mesh, glow, beam, beamMat, light, team, state: 'home' };
    });
  }

  // state: 'home' | 'carried' | 'dropped'; pos in world space (carried = above the carrier head)
  setStar(team, state, pos) {
    const s = this.stars[team];
    s.state = state;
    s.root.position.copy(pos);
    s.beam.visible = true;
    s.beamMat.uniforms.uOpacity.value = state === 'carried' ? 0.75 : 1;
    s.root.scale.setScalar(state === 'carried' ? 0.7 : 1);
  }

  // ------------------------------------------------------------------ queries
  isIce(x, z) {
    for (const p of this.ice) if ((x - p.x) ** 2 + (z - p.z) ** 2 < p.r * p.r) return true;
    return false;
  }

  onDeck(x, z) {
    for (const d of this.decks) if (Math.abs(x - d.x) < d.hw && Math.abs(z - d.z) < d.hd) return true;
    return false;
  }

  isSnow(x, z) {
    if (Math.abs(x) > ARENA.halfW || Math.abs(z) > ARENA.halfL) return false;
    return !this.isIce(x, z) && !this.onDeck(x, z);
  }

  // push a circle (pos.x/pos.z, radius r) out of every collider; returns true if it touched one
  resolveCircle(pos, r) {
    let hit = false;
    for (let it = 0; it < 2; it++) {
      for (const b of this.boxes) {
        const dx = pos.x - b.x, dz = pos.z - b.z;
        const c = Math.cos(b.rot || 0), s = Math.sin(b.rot || 0);
        const lx = dx * c - dz * s, lz = dx * s + dz * c;
        if (Math.abs(lx) > b.hw + r || Math.abs(lz) > b.hd + r) continue;
        const cx = clamp(lx, -b.hw, b.hw), cz = clamp(lz, -b.hd, b.hd);
        let ox = lx - cx, oz = lz - cz;
        let d = Math.hypot(ox, oz);
        let nx, nz;
        if (d > 1e-5) {
          if (d >= r) continue;
          nx = ox / d; nz = oz / d;
          const push = r - d;
          const wx = nx * c + nz * s, wz = -nx * s + nz * c;
          pos.x += wx * push; pos.z += wz * push;
        } else {
          // centre inside the box: leave along the shortest axis
          const px = b.hw + r - Math.abs(lx), pz = b.hd + r - Math.abs(lz);
          if (px < pz) { nx = Math.sign(lx) || 1; nz = 0; d = px; } else { nx = 0; nz = Math.sign(lz) || 1; d = pz; }
          const wx = nx * c + nz * s, wz = -nx * s + nz * c;
          pos.x += wx * d; pos.z += wz * d;
        }
        hit = true;
      }
      for (const k of this.circles) {
        const dx = pos.x - k.x, dz = pos.z - k.z, d = Math.hypot(dx, dz), m = k.r + r;
        if (d >= m) continue;
        const nx = d > 1e-5 ? dx / d : 1, nz = d > 1e-5 ? dz / d : 0;
        pos.x = k.x + nx * m; pos.z = k.z + nz * m;
        hit = true;
      }
    }
    pos.x = clamp(pos.x, -ARENA.halfW + r, ARENA.halfW - r);
    pos.z = clamp(pos.z, -ARENA.halfL + r, ARENA.halfL - r);
    return hit;
  }

  // solid at point (x, y, z)? (snowball collision)
  solidAt(x, y, z, pad = 0) {
    if (y < this.groundHeight(x, z) + (this.onDeck(x, z) ? 0.14 : 0)) return true;
    for (const b of this.boxes) if (y < b.h + 0.1 && boxContains(b, x, z, pad)) return true;
    for (const k of this.circles) if (y < k.h && (x - k.x) ** 2 + (z - k.z) ** 2 < (k.r + pad) ** 2) return true;
    return false;
  }

  // is the straight line a -> b (Vector3) blocked by a wall or tower? (bot line of sight)
  segmentBlocked(a, b, step = 0.6) {
    const d = a.distanceTo(b);
    const n = Math.max(2, Math.ceil(d / step));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t, z = a.z + (b.z - a.z) * t;
      for (const bx of this.boxes) if (y < bx.h && boxContains(bx, x, z)) return true;
      for (const k of this.circles) if (y < k.h && (x - k.x) ** 2 + (z - k.z) ** 2 < k.r * k.r) return true;
    }
    return false;
  }

  // flat walking test used by the bot steering (ignores height)
  walkBlocked(x0, z0, x1, z1, r = 0.45) {
    const d = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(2, Math.ceil(d / 0.5));
    for (let i = 1; i <= n; i++) {
      const t = i / n, x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
      if (Math.abs(x) > ARENA.halfW - r || Math.abs(z) > ARENA.halfL - r) return true;
      for (const b of this.boxes) if (boxContains(b, x, z, r)) return true;
      for (const k of this.circles) if ((x - k.x) ** 2 + (z - k.z) ** 2 < (k.r + r) ** 2) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ per frame
  update(dt, camera) {
    this.time += dt;
    const t = this.time;
    if (camera) {
      this.snow.material.uniforms.uCam.value.copy(camera.position);
      if (this.sun.castShadow) {
        // shadows around the point the camera looks at
        const f = this._shadowFocus;
        camera.getWorldDirection(f);
        f.y = 0;
        f.normalize().multiplyScalar(18).add(camera.position);
        this._placeSun(f);
      }
    }
    this.snow.material.uniforms.uTime.value = t;
    for (const s of this.stars) {
      s.spin.rotation.y = t * 2.2;
      s.spin.position.y = s.state === 'carried' ? 0 : Math.sin(t * 2.4 + s.team) * 0.12;
      s.glow.material.opacity = 0.75 + Math.sin(t * 5 + s.team) * 0.2;
      s.beamMat.uniforms.uTime.value = t;
      s.light.intensity = 3.5 + Math.sin(t * 5) * 0.8;
    }
    if (this.baseRings) for (const r of this.baseRings) r.material.opacity = 0.55 + Math.sin(t * 3) * 0.25;
    // flags waving
    for (const f of this.flags) {
      const p = f.geometry.attributes.position, b = f.userData.base;
      for (let i = 0; i < p.count; i++) {
        const x = b[i * 3];
        p.setZ(i, Math.sin(x * 4 - t * 6 + f.id) * 0.12 * x);
      }
      p.needsUpdate = true;
    }
  }
}
