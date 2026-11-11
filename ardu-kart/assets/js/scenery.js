// Environment: sky dome, sun + hemisphere lighting, image-based lighting, water, themed props
// and ambient particles. Everything is instanced to stay cheap with eight karts on screen.
import * as THREE from '../libs/three.bundle.js';
import { makeRng, hashString, clamp } from './util.js';
import * as TEX from './textures.js';

const { mergeGeometries } = THREE.BufferGeometryUtils;

function skyMaterial(theme) {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color(theme.skyTop) },
      mid: { value: new THREE.Color(theme.skyMid) },
      bottom: { value: new THREE.Color(theme.skyBottom) },
      sunDir: { value: new THREE.Vector3(...theme.sunDir).normalize() },
      sunCol: { value: new THREE.Color(theme.sunColor) },
      night: { value: theme.night ? 1 : 0 },
      aurora: { value: theme.aurora ? 1 : 0 },
      time: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 top, mid, bottom, sunDir, sunCol;
      uniform float night, aurora, time;
      varying vec3 vDir;
      float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        float a = hash(vec3(i,0.)), b = hash(vec3(i+vec2(1,0),0.)), c = hash(vec3(i+vec2(0,1),0.)), d = hash(vec3(i+vec2(1,1),0.));
        return mix(mix(a,b,f.x), mix(c,d,f.x), f.y); }
      float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; } return s; }
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col = h > 0.0 ? mix(mid, top, pow(smoothstep(0.0, 0.65, h), 0.8)) : mix(mid, bottom, smoothstep(0.0, -0.25, h));
        col = mix(col, bottom, smoothstep(0.12, 0.0, h) * 0.85);
        float sd = max(dot(d, sunDir), 0.0);
        if (night < 0.5) {
          col += sunCol * (pow(sd, 900.0) * 30.0 + pow(sd, 18.0) * 0.45 + pow(sd, 3.0) * 0.12);
        } else {
          // moon + stars
          col += vec3(0.85, 0.9, 1.0) * (smoothstep(0.9993, 0.9996, sd) * 2.0 + pow(sd, 60.0) * 0.25);
          vec3 sp = floor(d * 420.0);
          float st = hash(sp);
          float tw = 0.6 + 0.4 * sin(time * 2.0 + st * 40.0);
          col += vec3(1.0) * step(0.9975, st) * smoothstep(0.0, 0.3, h) * tw * 1.4;
        }
        // clouds
        if (h > 0.0) {
          vec2 cp = d.xz / (h + 0.18) * 1.6 + vec2(time * 0.006, 0.0);
          float c = smoothstep(0.52, 0.85, fbm(cp));
          vec3 cloudCol = night > 0.5 ? vec3(0.25, 0.12, 0.35) : mix(vec3(1.0), sunCol * 1.1, 0.35 + 0.5 * pow(sd, 4.0));
          col = mix(col, cloudCol, c * smoothstep(0.0, 0.15, h) * (night > 0.5 ? 0.4 : 0.8));
        }
        if (aurora > 0.5 && h > 0.05) {
          float band = 0.0;
          for (int i = 0; i < 3; i++) {
            float fi = float(i);
            float x = d.x * 3.0 + fi * 1.7 + time * 0.05;
            float y = h - 0.32 - 0.07 * sin(x * 2.0 + time * 0.3 + fi) - fi * 0.05;
            band += exp(-y * y * 380.0) * (0.6 + 0.4 * sin(d.x * 30.0 + time + fi * 3.0));
          }
          col += mix(vec3(0.1, 1.0, 0.6), vec3(0.6, 0.3, 1.0), smoothstep(0.3, 0.5, h)) * band * 0.55;
        }
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

export class Scenery {
  constructor(scene, renderer, track, { quality = 'high' } = {}) {
    this.scene = scene;
    this.track = track;
    this.theme = track.theme;
    this.quality = quality;
    this.group = new THREE.Group();
    this.animated = [];
    this.rng = makeRng(hashString(track.def.id + 'scenery'));
    const th = this.theme;

    scene.fog = new THREE.FogExp2(th.fog, th.fogDensity);
    scene.background = new THREE.Color(th.skyMid);

    // sky dome
    this.skyMat = skyMaterial(th);
    const sky = new THREE.Mesh(new THREE.SphereGeometry(1800, 48, 24), this.skyMat);
    sky.frustumCulled = false;
    sky.renderOrder = -1;
    this.sky = sky;
    this.group.add(sky);

    // image based lighting from the sky alone (cheap, done once)
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    const envSky = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), skyMaterial(th));
    envScene.add(envSky);
    this.envRT = pmrem.fromScene(envScene, 0.02);
    scene.environment = this.envRT.texture;
    scene.environmentIntensity = th.night ? 0.6 : 0.9;
    pmrem.dispose();

    // lights
    this.hemi = new THREE.HemisphereLight(th.hemiSky, th.hemiGround, th.hemiIntensity);
    this.group.add(this.hemi);
    this.sun = new THREE.DirectionalLight(th.sunColor, th.sunIntensity);
    this.sunDir = new THREE.Vector3(...th.sunDir).normalize();
    this.sun.castShadow = quality !== 'low';
    const sm = quality === 'high' ? 2048 : 1024;
    this.sun.shadow.mapSize.set(sm, sm);
    const sc = this.sun.shadow.camera;
    sc.left = -55; sc.right = 55; sc.top = 55; sc.bottom = -55; sc.near = 1; sc.far = 400;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.group.add(this.sun, this.sun.target);

    this._build();
    scene.add(this.group);
  }

  // keep the shadow frustum centred on the focus (player) so shadows stay crisp
  follow(focus) {
    const d = this.sunDir;
    this.sun.position.set(focus.x + d.x * 160, focus.y + d.y * 160, focus.z + d.z * 160);
    this.sun.target.position.copy(focus);
    this.sky.position.copy(focus);
    if (this.particles) this.particles.position.set(focus.x, 0, focus.z);
  }

  update(t, dt) {
    this.skyMat.uniforms.time.value = t;
    for (const a of this.animated) a(t, dt);
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    });
    this.envRT.dispose();
    this.scene.environment = null;
  }

  // ------------------------------------------------------------- placement helpers
  // Random positions near (but clear of) the track. band = [min,max] distance from the wall.
  scatter(count, band, { inside = true, outside = true, maxTries = 30 } = {}) {
    const tr = this.track;
    const out = [];
    const rng = this.rng;
    for (let n = 0; n < count; n++) {
      for (let tries = 0; tries < maxTries; tries++) {
        const i = rng.int(0, tr.N - 1);
        let side = rng() < 0.5 ? 1 : -1;
        if (!inside || !outside) {
          // inside = to the side the track turns towards on average (centre of loop)
          const toC = (tr.center.x - tr.px[i]) * tr.lx[i] + (tr.center.z - tr.pz[i]) * tr.lz[i];
          const inSide = Math.sign(toC) || 1;
          side = inside ? inSide : -inSide;
        }
        const dist = tr.wallDist + rng.range(band[0], band[1]);
        const x = tr.px[i] + tr.lx[i] * side * dist + rng.range(-3, 3);
        const z = tr.pz[i] + tr.lz[i] * side * dist + rng.range(-3, 3);
        const { d } = tr.distToTrack(x, z);
        if (d < tr.wallDist + band[0] * 0.8 + 1) continue;
        out.push({ x, z, y: tr.groundAt(x, z), r: rng() * Math.PI * 2, s: rng.range(0.8, 1.3), i, side });
        break;
      }
    }
    return out;
  }

  // Random positions in the open world further away.
  scatterFar(count, rMin, rMax) {
    const tr = this.track, rng = this.rng, out = [];
    for (let n = 0; n < count; n++) {
      for (let k = 0; k < 20; k++) {
        const a = rng() * Math.PI * 2, r = tr.radius + rng.range(rMin, rMax);
        const x = tr.center.x + Math.cos(a) * r, z = tr.center.z + Math.sin(a) * r;
        if (tr.distToTrack(x, z).d < tr.wallDist + 12) continue;
        out.push({ x, z, y: tr.groundAt(x, z), r: rng() * Math.PI * 2, s: rng.range(0.8, 1.4) });
        break;
      }
    }
    return out;
  }

  instance(geo, mat, items, { cast = true, recv = false, scaleFn, yOff = 0 } = {}) {
    if (!items.length) return null;
    const im = new THREE.InstancedMesh(geo, mat, items.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), e = new THREE.Euler();
    items.forEach((it, k) => {
      const sc = scaleFn ? scaleFn(it) : it.s;
      p.set(it.x, it.y + yOff, it.z);
      q.setFromEuler(e.set(it.rx || 0, it.r, it.rz || 0));
      s.set(sc, sc * (it.sy || 1), sc);
      m.compose(p, q, s);
      im.setMatrixAt(k, m);
      if (it.color != null && im.setColorAt) im.setColorAt(k, new THREE.Color(it.color));
    });
    im.castShadow = cast && this.quality !== 'low';
    im.receiveShadow = recv;
    this.group.add(im);
    return im;
  }

  _densityScale() {
    return this.quality === 'low' ? 0.45 : this.quality === 'medium' ? 0.75 : 1;
  }

  _build() {
    const th = this.track.def.theme;
    if (th === 'sunset') this._sunset();
    else if (th === 'neon') this._neon();
    else if (th === 'frost') this._frost();
    else this._dunes();
    this._grandstand();
    this._billboards();
    this._mountains();
  }

  // ------------------------------------------------------------- shared props
  _billboards() {
    const tr = this.track;
    const msgs = [
      [['ARDUINO UNO Q', 'DUAL-BRAIN RACING'], '#008184'],
      [['ARDU KART', 'GRAND PRIX'], '#d62a6a'],
      [['DRAGONWING', 'QRB2210 · 4× A53'], '#1f3a93'],
      [['EDGE AI', 'ON THE TRACK'], '#ff6a00'],
      [['STM32U585', 'LED MATRIX LIVE'], '#5b2bd1'],
    ];
    const night = this.theme.night;
    const postMat = new THREE.MeshStandardMaterial({ color: 0x3a3d48, metalness: 0.6, roughness: 0.4 });
    const count = 7;
    for (let k = 0; k < count; k++) {
      const i = tr.wrap(Math.floor(((k + 0.5) / count) * tr.N) + 7);
      // place on the outside of the corner when possible
      const side = tr.curv[i] > 0 ? -1 : 1;
      const dist = tr.wallDist + 4;
      const x = tr.px[i] + tr.lx[i] * side * dist, z = tr.pz[i] + tr.lz[i] * side * dist;
      if (tr.distToTrack(x, z).d < tr.wallDist + 2) continue;
      const [lines, bg] = msgs[k % msgs.length];
      const tex = TEX.billboardTexture(lines, { bg });
      const g = new THREE.Group();
      g.position.set(x, tr.py[i] - 0.5, z);
      // face the oncoming karts
      g.rotation.y = Math.atan2(-tr.tx[i], -tr.tz[i]) + side * 0.5;
      const face = new THREE.Mesh(new THREE.PlaneGeometry(12, 6), new THREE.MeshStandardMaterial({
        map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: night ? 1.1 : 0.25, roughness: 0.5,
      }));
      face.position.y = 7;
      const back = new THREE.Mesh(new THREE.BoxGeometry(12.4, 6.4, 0.4), postMat);
      back.position.set(0, 7, -0.25);
      back.castShadow = true;
      for (const s of [-4, 4]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 5, 8), postMat);
        post.position.set(s, 2.5, -0.3);
        g.add(post);
      }
      g.add(face, back);
      this.group.add(g);
    }
  }

  _grandstand() {
    const tr = this.track;
    const i = tr.wrap(6);
    const side = tr.def.theme === 'sunset' ? -1 : 1;
    const dist = tr.wallDist + 6;
    const base = new THREE.Group();
    const x = tr.px[i] + tr.lx[i] * side * dist, z = tr.pz[i] + tr.lz[i] * side * dist;
    base.position.set(x, tr.py[i] - 0.6, z);
    base.rotation.y = Math.atan2(tr.tx[i], tr.tz[i]);
    const len = 46;
    const stepMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc8, roughness: 0.8 });
    const steps = 6;
    for (let s = 0; s < steps; s++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(2, 1, len), stepMat);
      step.position.set(side * (s * 2), 0.5 + s, 0);
      step.scale.y = 1 + s * 2;
      step.position.y = (1 + s * 2) / 2;
      step.castShadow = true;
      step.receiveShadow = true;
      base.add(step);
    }
    const roof = new THREE.Mesh(new THREE.BoxGeometry(14, 0.5, len + 2), new THREE.MeshStandardMaterial({ color: 0xd62a3a, roughness: 0.5 }));
    roof.position.set(side * 5, 15, 0);
    roof.castShadow = true;
    base.add(roof);
    for (const zz of [-len / 2, 0, len / 2]) {
      const col = new THREE.Mesh(new THREE.BoxGeometry(0.6, 15, 0.6), stepMat);
      col.position.set(side * 11, 7.5, zz);
      base.add(col);
    }
    // crowd: instanced little people with bobbing in the vertex shader
    const crowdG = mergeGeometries([
      new THREE.CapsuleGeometry(0.32, 0.6, 3, 6).translate(0, 0.62, 0),
      new THREE.SphereGeometry(0.3, 8, 6).translate(0, 1.4, 0),
    ]);
    const crowdMat = new THREE.MeshStandardMaterial({ roughness: 0.8 });
    const crowdT = { value: 0 };
    crowdMat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = crowdT;
      sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         float ph = float(gl_InstanceID) * 1.37;
         transformed.y += abs(sin(uTime * 6.0 + ph)) * 0.25 * step(0.5, fract(ph));
         transformed.x += sin(uTime * 3.0 + ph) * 0.05;`,
      );
    };
    const people = [];
    const rng = this.rng;
    const palette = [0xff4d4d, 0x4dd2ff, 0xffd84d, 0x7dff6a, 0xff7ad9, 0xffffff, 0x9a7dff, 0xff9b3d];
    const ppl = Math.round(170 * this._densityScale());
    for (let n = 0; n < ppl; n++) {
      const s = rng.int(0, steps - 1);
      people.push({ x: side * (s * 2) + rng.range(-0.5, 0.5), y: 1 + s * 2, z: rng.range(-len / 2 + 1, len / 2 - 1), r: side > 0 ? -Math.PI / 2 : Math.PI / 2, s: rng.range(0.9, 1.1), color: rng.pick(palette) });
    }
    const crowd = new THREE.InstancedMesh(crowdG, crowdMat, people.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    people.forEach((pp, k) => {
      m.compose(p.set(pp.x, pp.y, pp.z), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), pp.r), sc.setScalar(pp.s));
      crowd.setMatrixAt(k, m);
      crowd.setColorAt(k, new THREE.Color(pp.color));
    });
    base.add(crowd);
    this.animated.push((t) => { crowdT.value = t; });
    this.group.add(base);
  }

  _mountains() {
    const th = this.track.def.theme;
    if (th === 'neon') return;
    const rng = this.rng;
    const tr = this.track;
    const col = { sunset: 0x6f6a8f, frost: 0x8aa0c0, dunes: 0xc48a58 }[th];
    const snow = th === 'frost';
    const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 1, flatShading: true, vertexColors: snow });
    const n = 14;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + rng.range(-0.15, 0.15);
      if (th === 'sunset' && Math.sin(a) < 0.1) continue; // keep the sea side open
      const r = tr.radius + rng.range(520, 700);
      const h = rng.range(90, 200) * (th === 'dunes' ? 0.6 : 1);
      const g = new THREE.ConeGeometry(rng.range(110, 190), h, 9, 4);
      const pos = g.attributes.position;
      const cols = [];
      for (let v = 0; v < pos.count; v++) {
        const y = pos.getY(v);
        if (y < h / 2 - 1) {
          pos.setX(v, pos.getX(v) * rng.range(0.8, 1.2));
          pos.setZ(v, pos.getZ(v) * rng.range(0.8, 1.2));
          pos.setY(v, y + rng.range(-6, 6));
        }
        const c = snow && y > h * 0.1 ? [1, 1, 1] : [0.55, 0.62, 0.75];
        cols.push(...c);
      }
      if (snow) g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, mat);
      m.position.set(tr.center.x + Math.cos(a) * r, h / 2 - 20, tr.center.z + Math.sin(a) * r);
      this.group.add(m);
    }
  }

  _ambientParticles(count, { color, size, spread = 160, height = 60, fall = 0, drift = 0.5, additive = false, tex }) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const rng = this.rng;
    for (let i = 0; i < count; i++) {
      pos[i * 3] = rng.range(-spread, spread);
      pos[i * 3 + 1] = rng.range(0, height);
      pos[i * 3 + 2] = rng.range(-spread, spread);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color, size, map: tex || TEX.softDotTexture(), transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, opacity: 0.9,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    this.particles = pts;
    this.group.add(pts);
    const base = this.track.py.reduce((a, b) => a + b, 0) / this.track.N;
    this.animated.push((t, dt) => {
      const a = geo.attributes.position.array;
      for (let i = 0; i < count; i++) {
        a[i * 3 + 1] -= fall * dt;
        a[i * 3] += Math.sin(t * 0.7 + i) * drift * dt;
        if (a[i * 3 + 1] < base - 5) a[i * 3 + 1] = base + height;
      }
      geo.attributes.position.needsUpdate = true;
    });
  }

  // ------------------------------------------------------------- themes
  _sunset() {
    const ds = this._densityScale();
    // ocean
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, 4000, 1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: this.theme.water, roughness: 0.06, metalness: 0.2, envMapIntensity: 1.3, transparent: true, opacity: 0.92 }),
    );
    water.position.y = -1.6;
    water.receiveShadow = true;
    const wn = this._waterNormal();
    water.material.normalMap = wn;
    water.material.normalScale.set(0.5, 0.5);
    this.group.add(water);
    this.animated.push((t) => { wn.offset.set(t * 0.012, t * 0.008); });

    // palms
    const trunk = new THREE.CylinderGeometry(0.28, 0.45, 9, 7, 6);
    const tp = trunk.attributes.position;
    for (let v = 0; v < tp.count; v++) {
      const y = tp.getY(v) + 4.5;
      tp.setX(v, tp.getX(v) + Math.pow(y / 9, 2) * 1.6);
      tp.setY(v, y);
    }
    trunk.computeVertexNormals();
    const fronds = [];
    for (let k = 0; k < 7; k++) {
      const f = new THREE.ConeGeometry(0.9, 5.2, 4, 1);
      f.translate(0, 2.6, 0);
      f.scale(1, 1, 0.25);
      f.rotateZ(-1.15);
      f.rotateY((k / 7) * Math.PI * 2);
      f.translate(1.6, 9, 0);
      fronds.push(f);
    }
    const frondG = mergeGeometries(fronds);
    const items = this.scatter(Math.round(110 * ds), [2, 30]);
    this.instance(trunk, new THREE.MeshStandardMaterial({ color: 0x8a6a45, roughness: 0.9 }), items);
    this.instance(frondG, new THREE.MeshStandardMaterial({ color: 0x3f9a3a, roughness: 0.7, flatShading: true }), items);
    // bushes & rocks
    const bush = new THREE.IcosahedronGeometry(1.6, 0);
    this.instance(bush, new THREE.MeshStandardMaterial({ color: 0x4f8f2f, flatShading: true, roughness: 0.9 }), this.scatter(Math.round(160 * ds), [1, 45]), { yOff: 0.5 });
    const rock = new THREE.DodecahedronGeometry(2.2, 0);
    this.instance(rock, new THREE.MeshStandardMaterial({ color: 0x9a8f86, flatShading: true }), this.scatter(Math.round(50 * ds), [3, 60]), { yOff: 0.4 });
    // beach umbrellas along the sea side
    const umb = mergeGeometries([
      new THREE.CylinderGeometry(0.08, 0.08, 3.4, 6).translate(0, 1.7, 0),
      new THREE.ConeGeometry(2.2, 0.9, 8, 1, true).translate(0, 3.6, 0),
    ]);
    const umbItems = this.scatter(Math.round(26 * ds), [2, 14]).filter((it) => it.y < 1.5).map((it) => ({ ...it, color: this.rng.pick([0xff5050, 0x50a0ff, 0xffd040, 0xffffff]) }));
    this.instance(umb, new THREE.MeshStandardMaterial({ roughness: 0.6, side: THREE.DoubleSide }), umbItems);
    // lighthouse
    const tr = this.track;
    const lh = new THREE.Group();
    const stripes = 6;
    for (let s = 0; s < stripes; s++) {
      const seg = new THREE.Mesh(new THREE.CylinderGeometry(2.6 - s * 0.18, 2.8 - s * 0.18, 4, 16), new THREE.MeshStandardMaterial({ color: s % 2 ? 0xffffff : 0xd8262b, roughness: 0.6 }));
      seg.position.y = 2 + s * 4;
      seg.castShadow = true;
      lh.add(seg);
    }
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(1.6, 16, 12), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffe9a0, emissiveIntensity: 4 }));
    lamp.position.y = 26;
    lh.add(lamp);
    const beam = new THREE.Mesh(new THREE.ConeGeometry(5, 60, 16, 1, true), new THREE.MeshBasicMaterial({ color: 0xfff2c0, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    beam.rotation.z = Math.PI / 2;
    beam.position.set(30, 0, 0);
    const beamPivot = new THREE.Group();
    beamPivot.position.y = 26;
    beamPivot.add(beam);
    lh.add(beamPivot);
    lh.position.set(tr.center.x + 40, -1, tr.center.z - tr.radius - 70);
    this.group.add(lh);
    this.animated.push((t) => { beamPivot.rotation.y = t * 0.8; });
    // sail boats
    const boatG = mergeGeometries([
      new THREE.BoxGeometry(5, 1, 1.8).translate(0, 0.5, 0),
      new THREE.ConeGeometry(1.8, 7, 3).scale(1, 1, 0.1).translate(0.4, 4.5, 0),
    ]);
    const boats = [];
    for (let k = 0; k < 6; k++) boats.push({ x: tr.center.x + this.rng.range(-400, 400), y: -1.6, z: tr.center.z - tr.radius - this.rng.range(110, 400), r: this.rng() * 6, s: this.rng.range(1, 1.6) });
    this.instance(boatG, new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.5 }), boats);
    this._ambientParticles(Math.round(140 * ds), { color: 0xffe0b0, size: 0.35, spread: 120, height: 30, fall: 0, drift: 1.5, additive: true });
  }

  _waterNormal() {
    const S = 256;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(S, S);
    const h = (x, y) => Math.sin(x * 0.15) * Math.cos(y * 0.11) + Math.sin((x + y) * 0.07) * 0.6 + Math.sin(x * 0.4 + y * 0.3) * 0.2;
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const dx = h(x + 1, y) - h(x - 1, y), dy = h(x, y + 1) - h(x, y - 1);
        const k = (y * S + x) * 4;
        img.data[k] = 128 + dx * 60;
        img.data[k + 1] = 128 + dy * 60;
        img.data[k + 2] = 255;
        img.data[k + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(60, 60);
    return t;
  }

  _neon() {
    const ds = this._densityScale();
    const tr = this.track;
    // skyscrapers with lit windows, a few variants
    const variants = 4;
    for (let v = 0; v < variants; v++) {
      const { map, emissive } = TEX.windowsTexture(v + 1, true);
      const mat = new THREE.MeshStandardMaterial({ map, emissiveMap: emissive, emissive: 0xffffff, emissiveIntensity: 1.6, roughness: 0.35, metalness: 0.5 });
      const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
      const near = this.scatter(Math.round(26 * ds), [6, 60]).map((it) => ({ ...it, sy: this.rng.range(25, 70) / 14, s: 14 + this.rng.range(-3, 6) }));
      const far = this.scatterFar(Math.round(40 * ds), 60, 420).map((it) => ({ ...it, sy: this.rng.range(30, 130) / 18, s: 18 + this.rng.range(-4, 10) }));
      this.instance(geo, mat, [...near, ...far], { cast: true, scaleFn: (it) => it.s });
    }
    // neon arches over the track
    const archMats = [0xff2fd0, 0x33f0ff, 0x8a5cff].map((c) => new THREE.MeshStandardMaterial({ color: 0x000000, emissive: c, emissiveIntensity: 3 }));
    const archG = new THREE.TorusGeometry(tr.wallDist + 1, 0.35, 8, 40, Math.PI);
    for (let k = 0; k < 10; k++) {
      const i = tr.wrap(Math.floor((k / 10) * tr.N) + 20);
      const a = new THREE.Mesh(archG, archMats[k % 3]);
      a.position.set(tr.px[i], tr.py[i] - 0.4, tr.pz[i]);
      a.rotation.y = Math.atan2(tr.tx[i], tr.tz[i]) + Math.PI / 2;
      this.group.add(a);
    }
    // hover lamps
    const lampG = new THREE.SphereGeometry(0.4, 10, 8);
    const lamps = [];
    for (let i = 0; i < tr.N; i += 10) for (const s of [-1, 1]) lamps.push({ x: tr.px[i] + tr.lx[i] * s * (tr.wallDist + 0.2), y: tr.py[i] + 2.6, z: tr.pz[i] + tr.lz[i] * s * (tr.wallDist + 0.2), r: 0, s: 1, color: s > 0 ? 0xff2fd0 : 0x33f0ff });
    const lampMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveIntensity: 2.5 });
    const lm = this.instance(lampG, lampMat, lamps, { cast: false });
    if (lm) {
      // emissive follows instance colour
      lampMat.onBeforeCompile = (sh) => {
        sh.fragmentShader = sh.fragmentShader.replace('vec3 totalEmissiveRadiance = emissive;', 'vec3 totalEmissiveRadiance = emissive * vColor.rgb;');
      };
      lampMat.vertexColors = false;
    }
    // holographic floating rings
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x33f0ff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    for (let k = 0; k < 6; k++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(this.rng.range(10, 20), 0.25, 6, 60), ringMat);
      const it = this.scatterFar(1, 30, 160)[0];
      if (!it) continue;
      ring.position.set(it.x, this.rng.range(25, 60), it.z);
      this.group.add(ring);
      const sp = this.rng.range(0.2, 0.6);
      this.animated.push((t) => { ring.rotation.x = t * sp; ring.rotation.y = t * sp * 0.7; });
    }
    this._ambientParticles(Math.round(260 * ds), { color: 0xb070ff, size: 0.45, spread: 140, height: 40, fall: -0.5, drift: 1, additive: true });
  }

  _frost() {
    const ds = this._densityScale();
    // pines: stacked cones with snow caps
    const tiers = [];
    for (let k = 0; k < 4; k++) tiers.push(new THREE.ConeGeometry(3 - k * 0.6, 3.6, 8).translate(0, 2.5 + k * 2.1, 0));
    const pineG = mergeGeometries(tiers);
    const snowG = mergeGeometries([0, 1, 2, 3].map((k) => new THREE.ConeGeometry(2.0 - k * 0.45, 1.2, 8).translate(0, 3.9 + k * 2.1, 0)));
    const trunkG = new THREE.CylinderGeometry(0.35, 0.5, 2.5, 6).translate(0, 1.2, 0);
    const items = [...this.scatter(Math.round(220 * ds), [1, 70]), ...this.scatterFar(Math.round(160 * ds), 40, 300)];
    this.instance(trunkG, new THREE.MeshStandardMaterial({ color: 0x5a3e2b }), items);
    this.instance(pineG, new THREE.MeshStandardMaterial({ color: 0x1f5a3c, roughness: 0.85, flatShading: true }), items);
    this.instance(snowG, new THREE.MeshStandardMaterial({ color: 0xf5f9ff, roughness: 0.7, flatShading: true }), items);
    // snowmen
    const smG = mergeGeometries([
      new THREE.SphereGeometry(1.2, 12, 10).translate(0, 1.1, 0),
      new THREE.SphereGeometry(0.85, 12, 10).translate(0, 2.7, 0),
      new THREE.SphereGeometry(0.6, 12, 10).translate(0, 3.9, 0),
    ]);
    const smItems = this.scatter(Math.round(14 * ds), [2, 10]);
    this.instance(smG, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }), smItems);
    this.instance(new THREE.ConeGeometry(0.12, 0.7, 6).rotateX(Math.PI / 2).translate(0, 3.9, 0.85), new THREE.MeshStandardMaterial({ color: 0xff7a1a }), smItems);
    // ice crystals
    const crys = new THREE.OctahedronGeometry(1.5, 0);
    crys.scale(0.6, 2.2, 0.6);
    const crysMat = new THREE.MeshPhysicalMaterial({ color: 0x9fe3ff, roughness: 0.05, metalness: 0, transmission: 0.6, thickness: 1, emissive: 0x2a8fff, emissiveIntensity: 0.4 });
    this.instance(crys, crysMat, this.scatter(Math.round(40 * ds), [1, 20]).map((it) => ({ ...it, rx: this.rng.range(-0.3, 0.3), rz: this.rng.range(-0.3, 0.3) })), { yOff: 1 });
    // cabins
    const cabin = mergeGeometries([
      new THREE.BoxGeometry(6, 4, 5).translate(0, 2, 0),
    ]);
    const roofG = new THREE.ConeGeometry(4.9, 3, 4).rotateY(Math.PI / 4).scale(1, 1, 0.85).translate(0, 5.5, 0);
    const cabins = this.scatter(Math.round(8 * ds), [10, 40]);
    this.instance(cabin, new THREE.MeshStandardMaterial({ color: 0x8b5a3c, roughness: 0.8 }), cabins);
    this.instance(roofG, new THREE.MeshStandardMaterial({ color: 0xf2f6fc, roughness: 0.7 }), cabins);
    this._ambientParticles(Math.round(900 * ds), { color: 0xffffff, size: 0.28, spread: 90, height: 50, fall: 4, drift: 2 });
  }

  _dunes() {
    const ds = this._densityScale();
    // saguaro cacti
    const arm = (side) => mergeGeometries([
      new THREE.CylinderGeometry(0.35, 0.35, 1.6, 8).rotateZ(Math.PI / 2).translate(side * 1.0, 3.5, 0),
      new THREE.CylinderGeometry(0.35, 0.35, 2.4, 8).translate(side * 1.8, 4.6, 0),
      new THREE.SphereGeometry(0.35, 8, 6).translate(side * 1.8, 5.8, 0),
    ]);
    const cactusG = mergeGeometries([
      new THREE.CylinderGeometry(0.55, 0.6, 7, 10).translate(0, 3.5, 0),
      new THREE.SphereGeometry(0.55, 10, 8).translate(0, 7, 0),
      arm(1), arm(-1).translate(0, -0.8, 0),
    ]);
    const items = [...this.scatter(Math.round(90 * ds), [1, 60]), ...this.scatterFar(Math.round(80 * ds), 30, 260)];
    this.instance(cactusG, new THREE.MeshStandardMaterial({ color: 0x3f8a46, roughness: 0.8 }), items);
    // rocks / mesas
    const rock = new THREE.DodecahedronGeometry(3, 0);
    this.instance(rock, new THREE.MeshStandardMaterial({ color: 0xb06a3c, flatShading: true }), this.scatter(Math.round(60 * ds), [2, 70]).map((it) => ({ ...it, sy: this.rng.range(0.6, 1.6) })), { yOff: 0.6 });
    const mesaG = new THREE.CylinderGeometry(18, 24, 30, 9, 1);
    this.instance(mesaG, new THREE.MeshStandardMaterial({ color: 0xc4703e, flatShading: true, roughness: 1 }), this.scatterFar(Math.round(10 * ds), 80, 320), { yOff: 10 });
    // pyramid
    const tr = this.track;
    const pyr = new THREE.Mesh(new THREE.ConeGeometry(70, 70, 4), new THREE.MeshStandardMaterial({ color: 0xe0b878, flatShading: true, roughness: 0.9 }));
    pyr.position.set(tr.center.x - tr.radius - 180, 25, tr.center.z - 80);
    pyr.rotation.y = Math.PI / 4;
    pyr.castShadow = true;
    this.group.add(pyr);
    const pyr2 = pyr.clone();
    pyr2.scale.setScalar(0.6);
    pyr2.position.x += 120;
    pyr2.position.z -= 110;
    pyr2.position.y = 12;
    this.group.add(pyr2);
    // arches over the road made of sandstone
    const archG = new THREE.TorusGeometry(tr.wallDist + 2, 2.2, 6, 20, Math.PI);
    const archMat = new THREE.MeshStandardMaterial({ color: 0xc98a52, flatShading: true, roughness: 1 });
    for (const t of [0.29, 0.66]) {
      const i = tr.idxOfT(t);
      const a = new THREE.Mesh(archG, archMat);
      a.position.set(tr.px[i], tr.py[i] - 1.2, tr.pz[i]);
      a.rotation.y = Math.atan2(tr.tx[i], tr.tz[i]) + Math.PI / 2;
      a.castShadow = true;
      this.group.add(a);
    }
    // oasis palms
    const trunk = new THREE.CylinderGeometry(0.28, 0.45, 9, 7, 6);
    const tp = trunk.attributes.position;
    for (let v = 0; v < tp.count; v++) {
      const y = tp.getY(v) + 4.5;
      tp.setX(v, tp.getX(v) + Math.pow(y / 9, 2) * 1.6);
      tp.setY(v, y);
    }
    trunk.computeVertexNormals();
    const fronds = [];
    for (let k = 0; k < 7; k++) {
      const f = new THREE.ConeGeometry(0.9, 5.2, 4, 1);
      f.translate(0, 2.6, 0);
      f.scale(1, 1, 0.25);
      f.rotateZ(-1.15);
      f.rotateY((k / 7) * Math.PI * 2);
      f.translate(1.6, 9, 0);
      fronds.push(f);
    }
    const palms = this.scatter(Math.round(30 * ds), [3, 25], { inside: true, outside: false });
    this.instance(trunk, new THREE.MeshStandardMaterial({ color: 0x8a6a45 }), palms);
    this.instance(mergeGeometries(fronds), new THREE.MeshStandardMaterial({ color: 0x4a9a3a, flatShading: true }), palms);
    this._ambientParticles(Math.round(300 * ds), { color: 0xf0d8a8, size: 0.3, spread: 110, height: 12, fall: 0.3, drift: 6 });
  }
}

export { clamp };
