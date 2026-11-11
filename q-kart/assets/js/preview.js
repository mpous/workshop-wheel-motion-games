// Small dedicated renderer for the character-select turntable and for baking
// driver portraits used by the HUD standings, lobby and results screens.
import * as THREE from '../libs/three.bundle.js';
import { CHARACTERS, buildKart } from './kartModel.js';

export class Preview {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'preview-canvas';
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x403040, 1.4);
    const key = new THREE.DirectionalLight(0xfff1dc, 2.6);
    key.position.set(4, 7, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = key.shadow.camera.bottom = -3;
    key.shadow.camera.right = key.shadow.camera.top = 3;
    key.shadow.bias = -0.0004;
    const rim = new THREE.DirectionalLight(0x88b8ff, 2.2);
    rim.position.set(-5, 3, -6);
    this.scene.add(hemi, key, rim);
    // environment for the clear-coat paint
    const pm = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    const envGeo = new THREE.SphereGeometry(10, 32, 16);
    const envMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'varying vec3 vP; void main(){ float h = normalize(vP).y; vec3 c = mix(vec3(0.25,0.2,0.3), vec3(1.0,0.95,0.9), smoothstep(-0.2,0.8,h)); c += vec3(2.0) * smoothstep(0.93,0.99, dot(normalize(vP), normalize(vec3(0.5,0.7,0.5)))); gl_FragColor = vec4(c,1.0); }',
    });
    envScene.add(new THREE.Mesh(envGeo, envMat));
    this.scene.environment = pm.fromScene(envScene, 0.02).texture;
    envGeo.dispose(); envMat.dispose(); pm.dispose();
    // turntable
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(2.1, 2.2, 0.16, 64),
      new THREE.MeshStandardMaterial({ color: 0x1b1f33, metalness: 0.6, roughness: 0.35 }),
    );
    disc.position.y = -0.08;
    disc.receiveShadow = true;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(2.15, 0.035, 8, 96), new THREE.MeshBasicMaterial({ color: 0x47e0ff, toneMapped: false }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.01;
    this.table = new THREE.Group();
    this.table.add(disc, ring);
    this.ring = ring;
    this.scene.add(this.table);
    this.models = new Map();
    this.current = null;
    this.angle = -0.6;
    this.spin = 0;
  }

  model(i) {
    if (!this.models.has(i)) {
      const m = buildKart(CHARACTERS[i].id, { quality: 'high' });
      m.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
      this.models.set(i, m);
    }
    return this.models.get(i);
  }

  show(i) {
    if (this.current) this.table.remove(this.current);
    this.current = this.model(i);
    this.table.add(this.current);
    this.ring.material.color.setHex(CHARACTERS[i].color);
    this.spin = 1; // little celebratory twirl on change
    this.pop = 0;
  }

  attach(container) {
    container.append(this.canvas);
    this.resize();
  }

  resize() {
    const p = this.canvas.parentElement;
    if (!p) return;
    const w = p.clientWidth, h = p.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(dt) {
    if (!this.canvas.parentElement || !this.current) return;
    if (this.canvas.width < 4) this.resize();
    this.spin *= Math.exp(-3 * dt);
    this.angle += dt * (0.5 + this.spin * 9);
    this.pop = Math.min(1, (this.pop || 0) + dt * 4);
    const s = 1 + Math.sin(this.pop * Math.PI) * 0.12;
    this.current.scale.setScalar(s);
    this.current.rotation.y = this.angle;
    this.camera.position.set(0, 1.7, 5.4);
    this.camera.lookAt(0, 0.55, 0);
    this.renderer.render(this.scene, this.camera);
  }

  // head-and-shoulders portraits as data URLs, keyed by character id
  bakePortraits(size = 128) {
    const out = {};
    const prevSize = new THREE.Vector2();
    this.renderer.getSize(prevSize);
    const cam = new THREE.PerspectiveCamera(26, 1, 0.05, 50);
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(size, size, false);
    this.table.visible = false;
    for (let i = 0; i < CHARACTERS.length; i++) {
      const m = this.model(i);
      this.scene.add(m);
      m.rotation.y = 0.5;
      m.scale.setScalar(1);
      m.updateMatrixWorld(true);
      const head = m.userData.head;
      const hp = new THREE.Vector3(0, 1.1, 0);
      if (head) head.getWorldPosition(hp);
      cam.position.set(hp.x + 0.75, hp.y + 0.12, hp.z + 1.55);
      cam.lookAt(hp.x, hp.y - 0.08, hp.z);
      this.renderer.render(this.scene, cam);
      out[CHARACTERS[i].id] = this.canvas.toDataURL('image/png');
      this.scene.remove(m);
    }
    this.table.visible = true;
    if (this.current) this.table.add(this.current);
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    if (prevSize.x) this.renderer.setSize(prevSize.x, prevSize.y, false);
    return out;
  }
}
