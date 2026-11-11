import * as THREE from 'three';
import { TRACKS } from '../q-kart/assets/js/tracks.js';
import fs from 'fs';
let svg = '';
const W = 520;
TRACKS.forEach((tr, ti) => {
  const curve = new THREE.CatmullRomCurve3(tr.points.map(p => new THREE.Vector3(p[0], p[2], p[1])), true, 'centripetal');
  const len = curve.getLength();
  const N = Math.ceil(len / 2);
  const pts = curve.getSpacedPoints(N).slice(0, N);
  let minC = 1e9, where = null, maxCurv = 0;
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
    const gap = Math.min(j - i, N - (j - i)); if (gap * 2 < tr.width * 3) continue;
    const a = pts[i], b = pts[j];
    if (Math.abs(a.y - b.y) > 8) continue;
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    if (d < minC) { minC = d; where = [i, j]; }
  }
  // curvature radius min
  let minR = 1e9;
  for (let i = 0; i < N; i++) {
    const a = pts[(i - 4 + N) % N], b = pts[i], c = pts[(i + 4) % N];
    const ab = Math.hypot(b.x-a.x,b.z-a.z), bc=Math.hypot(c.x-b.x,c.z-b.z), ac=Math.hypot(c.x-a.x,c.z-a.z);
    const area = Math.abs((b.x-a.x)*(c.z-a.z)-(c.x-a.x)*(b.z-a.z))/2;
    const R = area > 1e-6 ? ab*bc*ac/(4*area) : 1e9; if (R < minR) minR = R;
  }
  let maxSlope = 0; for (let i = 0; i < N; i++) { const a = pts[i], b = pts[(i+1)%N]; maxSlope = Math.max(maxSlope, Math.abs(b.y-a.y)/Math.hypot(b.x-a.x,b.z-a.z)); }
  console.log(tr.id, 'len', len.toFixed(0), 'N', N, 'minClear', minC.toFixed(1), where, 'needed', tr.width + 2*tr.shoulder, 'minR', minR.toFixed(1), 'maxSlope', maxSlope.toFixed(3));
  const xs = pts.map(p => p.x), zs = pts.map(p => p.z);
  const minx = Math.min(...xs) - 30, maxx = Math.max(...xs) + 30, minz = Math.min(...zs) - 30, maxz = Math.max(...zs) + 30;
  const s = (W - 20) / Math.max(maxx - minx, maxz - minz);
  const ox = (ti % 2) * W, oy = Math.floor(ti / 2) * W;
  svg += `<g transform="translate(${ox + 10},${oy + 10})"><text x="5" y="15" font-size="16">${tr.id} ${len.toFixed(0)}</text>`;
  svg += `<polyline fill="none" stroke="#ccc" stroke-width="${(tr.width + 2 * tr.shoulder) * s}" stroke-linejoin="round" points="${pts.map(p => `${(p.x - minx) * s},${(p.z - minz) * s}`).join(' ')} ${(pts[0].x - minx) * s},${(pts[0].z - minz) * s}"/>`;
  svg += `<polyline fill="none" stroke="#333" stroke-width="${tr.width * s}" stroke-linejoin="round" points="${pts.map(p => `${(p.x - minx) * s},${(p.z - minz) * s}`).join(' ')} ${(pts[0].x - minx) * s},${(pts[0].z - minz) * s}"/>`;
  for (let i = 0; i < N; i += 25) svg += `<circle cx="${(pts[i].x - minx) * s}" cy="${(pts[i].z - minz) * s}" r="3" fill="hsl(${(i / N) * 300},90%,55%)"/>`;
  svg += `<circle cx="${(pts[0].x - minx) * s}" cy="${(pts[0].z - minz) * s}" r="7" fill="red"/></g>`;
});
fs.writeFileSync('tracks.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="${W * 2}" height="${W * 2}" style="background:#fff">${svg}</svg>`);
