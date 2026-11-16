// First-person rod: a segmented blank that bends with line tension, a spinning
// reel crank, the cast swing, the fishing line and the bobber.
import * as THREE from '../libs/three.bundle.js';
import { clamp, damp, lerp } from './util.js';

const SEGS = 9;
const ROD_LEN = 2.5;
const LINE_PTS = 40;

export class Rod {
  constructor(app) {
    this.app = app;
    this.camera = app.camera;
    this.root = new THREE.Group();
    // lower right of the view, pointing forward and up
    this.root.position.set(0.32, -0.42, -0.55);
    this.root.rotation.set(-0.95, -0.12, -0.08);
    this.camera.add(this.root);
    this.bend = 0;          // 0..1, tension driven
    this.side = 0;          // -1..1 sideways pull
    this.swing = 0;         // cast swing angle (rad, + = back over the shoulder)
    this.crank = 0;
    this.crankSpeed = 0;
    this._build();
    this._buildLine();
    this._buildBobber();
    this.tipWorld = new THREE.Vector3();
  }

  _build() {
    const blank = new THREE.MeshStandardMaterial({ color: 0x1b2a3a, metalness: 0.55, roughness: 0.28 });
    const wrap = new THREE.MeshStandardMaterial({ color: 0xffcf26, metalness: 0.4, roughness: 0.35 });
    const cork = new THREE.MeshStandardMaterial({ color: 0xc69c6d, roughness: 0.9 });
    const metal = new THREE.MeshStandardMaterial({ color: 0xc9d1d9, metalness: 0.9, roughness: 0.22 });
    this.swingPivot = new THREE.Group();
    this.root.add(this.swingPivot);
    // handle
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.42, 12), cork);
    handle.position.y = -0.05;
    this.swingPivot.add(handle);
    const butt = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), blank);
    butt.position.y = -0.27;
    this.swingPivot.add(butt);
    // spinning reel under the handle
    const reel = (this.reel = new THREE.Group());
    reel.position.set(0, 0.06, -0.06);
    reel.rotation.y = Math.PI;   // hangs under the blank
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.012, 0.06), metal);
    foot.position.z = -0.03;
    const spool = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.035, 18), metal);
    spool.position.set(0, 0.03, 0.04);
    const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.032, 0.05, 18), blank);
    housing.position.set(0, -0.012, 0.04);
    const lineSpool = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.03, 18), new THREE.MeshStandardMaterial({ color: 0x9fe8ff, roughness: 0.4, emissive: 0x0a4050, emissiveIntensity: 0.4 }));
    lineSpool.position.set(0, 0.032, 0.04);
    this.crankArm = new THREE.Group();
    this.crankArm.position.set(0.035, -0.012, 0.04);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.06, 0.008), metal);
    arm.position.y = 0.03;
    const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.025, 10), wrap);
    knob.rotation.z = Math.PI / 2; knob.position.set(0.012, 0.06, 0);
    this.crankArm.add(arm, knob);
    this.crankArm.rotation.z = Math.PI / 2;
    const crankHolder = new THREE.Group();
    crankHolder.add(this.crankArm);
    reel.add(foot, spool, housing, lineSpool, crankHolder);
    this.swingPivot.add(reel);
    // blank segments chained so each one bends relative to the previous
    this.segs = [];
    let parent = this.swingPivot, y0 = 0.16;
    const segLen = ROD_LEN / SEGS;
    for (let i = 0; i < SEGS; i++) {
      const r0 = lerp(0.016, 0.003, i / SEGS), r1 = lerp(0.016, 0.003, (i + 1) / SEGS);
      const g = new THREE.Group();
      g.position.y = y0;
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, segLen, 8).translate(0, segLen / 2, 0), blank);
      g.add(m);
      if (i % 2 === 1) {
        // line guide
        const ring = new THREE.Mesh(new THREE.TorusGeometry(lerp(0.016, 0.006, i / SEGS), 0.0018, 6, 14), metal);
        ring.position.set(0, segLen * 0.5, -lerp(0.022, 0.01, i / SEGS));
        g.add(ring);
      }
      if (i === 0) {
        const w = new THREE.Mesh(new THREE.CylinderGeometry(r0 * 1.2, r0 * 1.2, 0.04, 10), wrap);
        w.position.y = 0.02;
        g.add(w);
      }
      parent.add(g);
      this.segs.push(g);
      parent = g;
      y0 = segLen;
    }
    this.tip = new THREE.Object3D();
    this.tip.position.y = segLen;
    parent.add(this.tip);
    this.root.traverse((o) => { if (o.isMesh) o.castShadow = false; });
  }

  _buildLine() {
    const g = new THREE.BufferGeometry();
    this.linePos = new Float32Array(LINE_PTS * 3);
    g.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3).setUsage(THREE.DynamicDrawUsage));
    this.lineMat = new THREE.LineBasicMaterial({ color: 0xbff4ff, transparent: true, opacity: 0.85, fog: false });
    this.line = new THREE.Line(g, this.lineMat);
    this.line.frustumCulled = false;
    this.line.visible = false;
    this.app.scene.add(this.line);
  }

  _buildBobber() {
    const b = (this.bobber = new THREE.Group());
    const red = new THREE.MeshStandardMaterial({ color: 0xff3b30, roughness: 0.35, emissive: 0x551010, emissiveIntensity: 0.6 });
    const white = new THREE.MeshStandardMaterial({ color: 0xf5f5f5, roughness: 0.4 });
    const top = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), red);
    const bot = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), white);
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.22, 6), red);
    stick.position.y = 0.16;
    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffe08a }));
    glow.position.y = 0.28;
    b.add(top, bot, stick, glow);
    b.scale.setScalar(1.6);   // readable from 30 m away
    b.visible = false;
    this.app.scene.add(b);
  }

  // the cast swing: 0 rest, raised back then whipped forward
  startCast() { this._cast = 0; }

  tipPosition(out = this.tipWorld) {
    this.tip.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(this.tip.matrixWorld);
  }

  // lure: world position of the end of the line, or null when reeled in
  // tension 0..1 · slack: extra sag 0..1
  update(dt, { tension = 0, side = 0, reeling = 0, lure = null, slack = 0, bobber = null }) {
    this.bend = damp(this.bend, lure ? tension : 0, 10, dt);
    this.side = damp(this.side, side, 6, dt);
    if (this._cast != null) {
      this._cast += dt;
      const t = this._cast;
      // 0..0.28 raise back, 0.28..0.45 whip forward, then settle
      this.swing = t < 0.28 ? lerp(0, 1.2, t / 0.28) : t < 0.45 ? lerp(1.2, -0.5, (t - 0.28) / 0.17) : lerp(-0.5, 0, clamp((t - 0.45) / 0.4, 0, 1));
      if (t > 0.9) { this._cast = null; this.swing = 0; }
    }
    this.swingPivot.rotation.x = this.swing;
    // bend more towards the tip: rotate each segment forward/down
    const b = this.bend;
    for (let i = 0; i < SEGS; i++) {
      const w = (i + 1) / SEGS;
      this.segs[i].rotation.x = -b * 0.16 * w - Math.sin(performance.now() * 0.02 + i) * b * b * 0.004;
      this.segs[i].rotation.z = this.side * b * 0.07 * w;   // + = bends left
    }
    this.crankSpeed = damp(this.crankSpeed, reeling, 8, dt);
    this.crank += this.crankSpeed * dt * 14;
    this.crankArm.rotation.x = this.crank;
    // line: tip -> lure, sagging under gravity when slack
    const tip = this.tipPosition();
    if (!lure) { this.line.visible = false; this.bobber.visible = false; return; }
    this.line.visible = true;
    const d = tip.distanceTo(lure);
    const sag = d * 0.12 * clamp(1 - tension * 1.3 + slack * 0.6, 0, 1.4);
    const pos = this.linePos;
    for (let i = 0; i < LINE_PTS; i++) {
      const u = i / (LINE_PTS - 1);
      const x = lerp(tip.x, lure.x, u), z = lerp(tip.z, lure.z, u);
      let y = lerp(tip.y, lure.y, u) - Math.sin(Math.PI * u) * sag;
      if (lure.y < 0.2) y = Math.max(y, 0.015);   // the line rests on the surface, never through it
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    }
    this.line.geometry.attributes.position.needsUpdate = true;
    this.lineMat.color.setHSL(0.53 - tension * 0.53, 0.9, 0.82 - tension * 0.2);
    if (bobber) {
      this.bobber.visible = true;
      this.bobber.position.copy(bobber.pos);
      this.bobber.rotation.set(bobber.tiltX || 0, 0, bobber.tiltZ || 0);
    } else this.bobber.visible = false;
  }

  dispose() {
    this.camera.remove(this.root);
    this.app.scene.remove(this.line, this.bobber);
  }
}
