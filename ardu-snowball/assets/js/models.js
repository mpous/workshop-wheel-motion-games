// Ardu Snowball — characters: third-person snowsuit kids (other players and
// bots) and the first-person gloved hands of the local player.
import * as THREE from '../libs/three.bundle.js';
import { TEAM_COLOR } from './world.js';
import { clamp, lerp, smoothstep } from './util.js';

const SKINS = [0xf2c9a5, 0xd9a07a, 0xa86b4a, 0x7a4a30, 0xf6d7bd];
const SCARVES = [0xffd23a, 0xffffff, 0x29d17a, 0xff8a1f, 0xb46bff, 0x16c7e0];

const matCache = new Map();
function mat(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!matCache.has(key)) matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.75, ...opts }));
  return matCache.get(key);
}

const G = {
  capsule: (r, l) => new THREE.CapsuleGeometry(r, l, 4, 10),
  sphere: (r, w = 16, h = 12) => new THREE.SphereGeometry(r, w, h),
};

export function snowballGeometry(r = 0.075) {
  const g = new THREE.IcosahedronGeometry(r, 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(p, i);
    const n = 1 + Math.sin(v.x * 90) * Math.sin(v.y * 80) * Math.sin(v.z * 70) * 0.06;
    v.multiplyScalar(n);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}
export const SNOWBALL_MAT = new THREE.MeshStandardMaterial({ color: 0xfafcff, roughness: 0.7, emissive: 0x8ab0e0, emissiveIntensity: 0.08 });

function nameTag(name, team, isBot) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  const col = '#' + TEAM_COLOR[team].toString(16).padStart(6, '0');
  g.font = '700 30px system-ui, sans-serif';
  const label = (isBot ? '🤖 ' : '') + name;
  const w = Math.min(248, g.measureText(label).width + 28);
  g.fillStyle = 'rgba(8,14,30,0.72)';
  g.beginPath();
  g.roundRect((256 - w) / 2, 8, w, 48, 14);
  g.fill();
  g.fillStyle = col;
  g.fillRect((256 - w) / 2 + 10, 50, w - 20, 4);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, 128, 32, 236);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false }));
  s.scale.set(1.6, 0.4, 1);
  s.renderOrder = 6;
  return s;
}

// ---------------------------------------------------------------- avatar
export class Avatar {
  constructor({ team, name = 'Player', isBot = false, seed = 0 }) {
    this.team = team;
    const root = (this.root = new THREE.Group());
    const tc = new THREE.Color(TEAM_COLOR[team]);
    const jacket = mat(tc.getHex(), { roughness: 0.65 });
    const pants = mat(tc.clone().multiplyScalar(0.45).getHex(), { roughness: 0.8 });
    const skin = mat(SKINS[seed % SKINS.length], { roughness: 0.6 });
    const white = mat(0xf6f8ff, { roughness: 0.9 });
    const dark = mat(0x1a1d26, { roughness: 0.6 });
    const scarfM = mat(SCARVES[(seed >> 2) % SCARVES.length], { roughness: 0.85 });
    const mitten = mat(team === 0 ? 0x173a8a : 0x8a1a1a, { roughness: 0.8 });

    // hips pivot: the whole upper body leans from here
    const hips = (this.hips = new THREE.Group());
    hips.position.y = 0.62;
    root.add(hips);
    this.legs = [-1, 1].map((s) => {
      const pivot = new THREE.Group();
      pivot.position.set(s * 0.12, 0.62, 0);
      const leg = new THREE.Mesh(G.capsule(0.11, 0.36), pants);
      leg.position.y = -0.3;
      const boot = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.14, 0.3), dark);
      boot.position.set(0, -0.55, 0.05);
      pivot.add(leg, boot);
      root.add(pivot);
      return pivot;
    });
    const torso = new THREE.Mesh(G.capsule(0.25, 0.32), jacket);
    torso.position.y = 0.36;
    torso.scale.set(1, 1, 0.82);
    const zip = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.45, 0.02), white);
    zip.position.set(0, 0.36, 0.205);
    hips.add(torso, zip);
    // head
    const head = (this.head = new THREE.Group());
    head.position.y = 0.92;
    hips.add(head);
    const face = new THREE.Mesh(G.sphere(0.2), skin);
    head.add(face);
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(G.sphere(0.028, 8, 6), dark);
      eye.position.set(s * 0.07, 0.02, 0.18);
      const cheek = new THREE.Mesh(G.sphere(0.035, 8, 6), mat(0xff8f8f, { roughness: 0.9 }));
      cheek.position.set(s * 0.11, -0.05, 0.15);
      cheek.scale.z = 0.4;
      head.add(eye, cheek);
    }
    const beanie = new THREE.Mesh(new THREE.SphereGeometry(0.215, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), jacket);
    beanie.position.y = 0.03;
    beanie.scale.y = 1.05;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.045, 8, 20).rotateX(Math.PI / 2), white);
    rim.position.y = 0.05;
    const pom = new THREE.Mesh(G.sphere(0.075, 10, 8), white);
    pom.position.y = 0.27;
    head.add(beanie, rim, pom);
    const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.06, 8, 18).rotateX(Math.PI / 2), scarfM);
    scarf.position.y = 0.7;
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.28, 0.04), scarfM);
    tail.position.set(0.1, 0.56, 0.17);
    tail.rotation.z = 0.2;
    hips.add(scarf, tail);
    // arms
    this.arms = [-1, 1].map((s) => {
      const pivot = new THREE.Group();
      pivot.position.set(s * 0.32, 0.62, 0);
      const arm = new THREE.Mesh(G.capsule(0.08, 0.36), jacket);
      arm.position.y = -0.24;
      const hand = new THREE.Mesh(G.sphere(0.085, 10, 8), mitten);
      hand.position.y = -0.5;
      pivot.add(arm, hand);
      hips.add(pivot);
      pivot.rotation.z = s * 0.12;
      return pivot;
    });
    this.ball = new THREE.Mesh(snowballGeometry(0.08), SNOWBALL_MAT);
    this.ball.position.set(0, -0.58, 0.06);
    this.arms[1].add(this.ball);
    root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    // frozen ice block
    this.ice = new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.95, 0.95), new THREE.MeshPhysicalMaterial({
      color: 0xbfe8ff, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.55, clearcoat: 1, envMapIntensity: 1.5, emissive: 0x3a8ac0, emissiveIntensity: 0.25,
    }));
    this.ice.position.y = 0.98;
    this.ice.visible = false;
    root.add(this.ice);
    // spawn shield bubble
    this.shield = new THREE.Mesh(G.sphere(1.0, 20, 14), new THREE.MeshBasicMaterial({ color: TEAM_COLOR[team], transparent: true, opacity: 0.18, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.shield.position.y = 0.95;
    this.shield.visible = false;
    root.add(this.shield);
    this.tag = nameTag(name, team, isBot);
    this.tag.position.y = 2.15;
    root.add(this.tag);
    this.phase = seed;
    this.anim = { lean: 0, scoop: 0, pack: 0, throw: 0 };
  }

  // st: {speed, action ('scoop'|'pack'|'throw'|null), actionT 0..1, frozen, shield, ammo, t}
  update(dt, st) {
    const a = this.anim;
    const sp = st.frozen ? 0 : clamp(st.speed / 6, 0, 1.4);
    this.phase += dt * (3 + st.speed * 1.5) * (sp > 0.05 ? 1 : 0);
    const sw = Math.sin(this.phase) * 0.75 * Math.min(1, sp);
    const k = 1 - Math.exp(-dt * 14);
    a.scoop = lerp(a.scoop, st.action === 'scoop' ? 1 : 0, k);
    a.pack = lerp(a.pack, st.action === 'pack' ? 1 : 0, k);
    const thr = st.action === 'throw' ? st.actionT : 1;
    if (!st.frozen) {
      this.legs[0].rotation.x = sw;
      this.legs[1].rotation.x = -sw;
      this.hips.rotation.x = a.scoop * 0.9 + sp * 0.12;
      // left arm: swing / scoop / pack
      const L = this.arms[0], R = this.arms[1];
      L.rotation.x = -sw * 0.8 * (1 - a.scoop) - a.scoop * 0.9 - a.pack * 1.3;
      L.rotation.z = -0.12 + a.pack * 0.35;
      if (st.action === 'throw' && thr < 1) {
        // wind up behind the head, then whip forward
        const wind = smoothstep(0, 0.25, thr), whip = smoothstep(0.25, 0.6, thr);
        R.rotation.x = lerp(0, -2.7, wind) + whip * 3.6;
        R.rotation.z = 0.25;
      } else {
        R.rotation.x = sw * 0.8 * (1 - a.scoop) - a.scoop * 0.9 - a.pack * 1.3 + Math.sin(st.t * 18) * a.pack * 0.15;
        R.rotation.z = 0.12 - a.pack * 0.35;
      }
    }
    this.ball.visible = st.ammo > 0 && !(st.action === 'throw' && thr < 0.6);
    this.ice.visible = !!st.frozen;
    if (st.frozen) this.ice.rotation.y = 0.15;
    this.shield.visible = !!st.shield && !st.frozen;
    if (this.shield.visible) this.shield.material.opacity = 0.12 + Math.sin(st.t * 10) * 0.06;
  }

  setTagVisible(v) { this.tag.visible = v; }

  dispose() {
    this.root.removeFromParent();
    this.tag.material.map.dispose();
    this.tag.material.dispose();
  }
}

// ---------------------------------------------------------------- first-person hands
export class Hands {
  constructor(team) {
    const g = (this.group = new THREE.Group());
    const tc = new THREE.Color(TEAM_COLOR[team]);
    const mitM = new THREE.MeshStandardMaterial({ color: team === 0 ? 0x1d4fc4 : 0xc42424, roughness: 0.85 });
    const knit = new THREE.MeshStandardMaterial({ color: 0xf4f6fb, roughness: 0.95 });
    const sleeve = new THREE.MeshStandardMaterial({ color: tc, roughness: 0.65 });
    this.mats = [mitM, knit, sleeve];
    const makeHand = (s) => {
      const h = new THREE.Group();
      const palm = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), mitM);
      palm.scale.set(0.055, 0.07, 0.045);
      const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.018, 0.045, 4, 8), mitM);
      thumb.position.set(-s * 0.05, -0.005, 0.01);
      thumb.rotation.z = s * 0.9;
      const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.05, 14), knit);
      cuff.position.y = -0.075;
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.4, 12), sleeve);
      arm.position.y = -0.3;
      h.add(palm, thumb, cuff, arm);
      // the hand group points up; tilt it forward so the arm goes back-down out of view
      h.rotation.x = -1.05;
      h.rotation.z = s * 0.25;
      return h;
    };
    this.R = makeHand(1);
    this.L = makeHand(-1);
    this.restR = new THREE.Vector3(0.2, -0.2, -0.36);
    this.restL = new THREE.Vector3(-0.21, -0.23, -0.38);
    this.R.position.copy(this.restR);
    this.L.position.copy(this.restL);
    g.add(this.R, this.L);
    this.ball = new THREE.Mesh(snowballGeometry(0.06), SNOWBALL_MAT);
    this.ball.position.set(0, 0.06, 0.03);
    this.R.add(this.ball);
    // a loose handful of snow (lumpy)
    const hg = new THREE.IcosahedronGeometry(0.06, 1);
    const hp = hg.attributes.position;
    for (let i = 0; i < hp.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(hp, i);
      v.multiplyScalar(0.8 + Math.abs(Math.sin(i * 12.9898) * 0.45));
      v.y *= 0.6;
      hp.setXYZ(i, v.x, v.y, v.z);
    }
    hg.computeVertexNormals();
    this.handful = new THREE.Mesh(hg, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true }));
    this.handful.position.set(0, 0.055, 0.02);
    this.L.add(this.handful);
    g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; o.renderOrder = 10; } });
    this.t = 0;
    this.bob = 0;
    this.recoil = 0;
    this.frost = 0;
  }

  // st: {speed, run, ammo, handfuls, action, actionT, frozen}
  update(dt, st) {
    this.t += dt;
    const sp = clamp(st.speed / 6, 0, 1.4);
    this.bob += dt * (st.run ? 13 : 9) * (sp > 0.05 ? 1 : 0);
    const by = Math.abs(Math.sin(this.bob)) * 0.018 * sp, bx = Math.sin(this.bob) * 0.012 * sp;
    const breathe = Math.sin(this.t * 1.7) * 0.004;
    const R = this.R.position, L = this.L.position;
    R.copy(this.restR); L.copy(this.restL);
    R.x += bx; R.y += by + breathe; L.x += bx; L.y += by + breathe;
    if (st.run) { R.y -= 0.03; L.y -= 0.03; }
    let rRotX = -1.05, lRotX = -1.05;
    const t = st.actionT || 0;
    if (st.frozen) {
      // hands up, shivering
      const sh = Math.sin(this.t * 60) * 0.004;
      R.set(0.16 + sh, -0.12, -0.32); L.set(-0.16 - sh, -0.12, -0.32);
      rRotX = lRotX = -0.4;
    } else if (st.action === 'scoop') {
      // both hands dive down out of view and come back up with snow
      const down = smoothstep(0, 0.4, t) * (1 - smoothstep(0.6, 1, t));
      R.y -= down * 0.35; L.y -= down * 0.35;
      R.z -= down * 0.06; L.z -= down * 0.06;
      R.x -= down * 0.05; L.x += down * 0.05;
      rRotX = lRotX = -1.05 - down * 0.5;
    } else if (st.action === 'pack') {
      // hands come together and press the snow into a ball
      const c = smoothstep(0, 0.25, t) * (1 - smoothstep(0.85, 1, t));
      const press = Math.abs(Math.sin(t * Math.PI * 4)) * 0.025 * c;
      R.x = lerp(R.x, 0.07 - press, c); L.x = lerp(L.x, -0.07 + press, c);
      R.y = lerp(R.y, -0.15, c); L.y = lerp(L.y, -0.15, c);
      R.z = lerp(R.z, -0.33, c); L.z = lerp(L.z, -0.33, c);
      rRotX = lerp(-1.05, -0.6, c); lRotX = rRotX;
      this.R.rotation.z = lerp(0.25, 1.2, c);
      this.L.rotation.z = lerp(-0.25, -1.2, c);
    } else if (st.action === 'throw') {
      // follow-through: the arm whips forward from behind the shoulder
      const back = 1 - smoothstep(0, 0.12, t);
      const fwd = smoothstep(0.08, 0.35, t) * (1 - smoothstep(0.5, 1, t));
      R.x += back * 0.12 - fwd * 0.12;
      R.y += back * 0.16 - fwd * 0.05;
      R.z += back * 0.18 - fwd * 0.25;
      rRotX = -1.05 + back * 0.9 - fwd * 0.6;
    }
    if (st.action !== 'pack') { this.R.rotation.z = 0.25; this.L.rotation.z = -0.25; }
    this.R.rotation.x = rRotX;
    this.L.rotation.x = lRotX;
    this.ball.visible = st.ammo > 0 && !(st.action === 'throw' && t < 0.7) && !(st.action === 'pack' && t < 0.8);
    // handful: shown while holding loose snow, and while packing (shrinking into the ball)
    const packing = st.action === 'pack';
    this.handful.visible = (st.handfuls > 0 && !(st.action === 'scoop' && t < 0.55)) || (st.action === 'scoop' && t > 0.55) || (packing && t < 0.85);
    this.handful.scale.setScalar(packing ? 1 - smoothstep(0.3, 0.85, t) * 0.4 : 1 + Math.min(1, st.handfuls - 1) * 0.25);
    this.frost = lerp(this.frost, st.frozen ? 1 : 0, 1 - Math.exp(-dt * 6));
    for (const m of this.mats) { m.emissive.setHex(0x6fc4ff); m.emissiveIntensity = this.frost * 0.6; }
  }
}
