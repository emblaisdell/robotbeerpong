// Render the in-game cup model (web-models/cup.glb) to a PNG favicon.
// Pure Node, no deps: parses the GLB, replicates the cup's inside-white shader
// from src/view.js, software-rasterises a 3/4 view with a z-buffer + SSAA, and
// writes an RGBA PNG. Re-run after the cup model changes:
//   node tools/render-favicon.mjs
import fs from 'fs';
import zlib from 'zlib';

const GLB = 'web-models/cup.glb';
const OUT = 'favicon.png';
const SIZE = 128;     // output px
const SS = 4;         // supersample factor
const W = SIZE * SS;

// ---- parse GLB ----
const buf = fs.readFileSync(GLB);
let off = 12, json = null, bin = null;
while (off < buf.length) {
  const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
  const data = buf.slice(off + 8, off + 8 + len);
  if (type === 0x4E4F534A) json = JSON.parse(data.toString('utf8'));
  if (type === 0x004E4942) bin = data;
  off += 8 + len;
}
const COMP = { 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
function readAccessor(i) {
  const a = json.accessors[i];
  const bv = json.bufferViews[a.bufferView];
  const start = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const n = a.count * NUM[a.type];
  const Ctor = COMP[a.componentType];
  return new Ctor(bin.buffer, bin.byteOffset + start, n);
}
const prim = json.meshes[0].primitives[0];
const pos = readAccessor(prim.attributes.POSITION);
const nor = readAccessor(prim.attributes.NORMAL);
const uv = readAccessor(prim.attributes.TEXCOORD_0);
const idx = readAccessor(prim.indices);

// 2x1 palette texture: u<0.5 -> red, else white (matches the baked cup texture).
function sampleTex(u) { return u < 0.5 ? [1, 0, 0] : [1, 1, 1]; }

// ---- geometry: centre the model, build a 3/4 rotation ----
const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < pos.length; i += 3)
  for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i + k]); max[k] = Math.max(max[k], pos[i + k]); }
const ctr = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];

const YAW = -32 * Math.PI / 180;   // turn to show the front-right
const PITCH = 26 * Math.PI / 180;  // tilt the rim opening toward the viewer
const cy = Math.cos(YAW), sy = Math.sin(YAW), cp = Math.cos(PITCH), sp = Math.sin(PITCH);
function rot(v) {
  // yaw about Y, then pitch about X. Camera looks down -Z; +nz faces the viewer.
  const x = cy * v[0] + sy * v[2];
  const z = -sy * v[0] + cy * v[2];
  const y = cp * v[1] - sp * z;
  const z2 = sp * v[1] + cp * z;
  return [x, y, z2];
}

// project all verts; fit rotated bounds into the frame with a margin.
const rp = [], rn = [];
const rmin = [Infinity, Infinity], rmax = [-Infinity, -Infinity];
for (let i = 0; i < pos.length; i += 3) {
  const p = rot([pos[i] - ctr[0], pos[i + 1] - ctr[1], pos[i + 2] - ctr[2]]);
  const nn = rot([nor[i], nor[i + 1], nor[i + 2]]);
  rp.push(p); rn.push(nn);
  rmin[0] = Math.min(rmin[0], p[0]); rmax[0] = Math.max(rmax[0], p[0]);
  rmin[1] = Math.min(rmin[1], p[1]); rmax[1] = Math.max(rmax[1], p[1]);
}
const span = Math.max(rmax[0] - rmin[0], rmax[1] - rmin[1]);
const margin = 0.12;
const scale = (W * (1 - 2 * margin)) / span;
const rc = [(rmin[0] + rmax[0]) / 2, (rmin[1] + rmax[1]) / 2];
function screen(p) {
  return [W / 2 + (p[0] - rc[0]) * scale, W / 2 - (p[1] - rc[1]) * scale];
}

// per-vertex final colour = base(texture+inside rule) * lambert, two-sided light.
const L = (() => { const v = [-0.35, 0.72, 0.6]; const m = Math.hypot(...v); return v.map(x => x / m); })();
const AMBIENT = 0.4, KEY = 0.85;
function vColor(i3) {
  const lp = [pos[i3], pos[i3 + 1], pos[i3 + 2]];      // raw local pos (shader space)
  const ln = [nor[i3], nor[i3 + 1], nor[i3 + 2]];      // raw local normal
  let base = sampleTex(uv[(i3 / 3) * 2]);
  // replicate src/view.js inside-white override
  const rl = Math.hypot(lp[0], lp[2]) + 1e-5;
  const radial = (ln[0] * lp[0] + ln[2] * lp[2]) / rl;
  const inside = radial < -0.25;
  const floor = ln[1] > 0.5 && Math.hypot(lp[0], lp[2]) < 1.0;
  if (inside || floor) base = [0.95, 0.96, 0.97];
  // lighting with rotated normal, flipped to face the camera (double-sided)
  let n = rn[i3 / 3];
  if (n[2] < 0) n = [-n[0], -n[1], -n[2]];
  const diff = Math.max(0, n[0] * L[0] + n[1] * L[1] + n[2] * L[2]);
  const lf = AMBIENT + KEY * diff;
  return [base[0] * lf, base[1] * lf, base[2] * lf];
}

// ---- rasterise with z-buffer + Gouraud ----
const col = new Float32Array(W * W * 3);
const acov = new Float32Array(W * W);     // coverage/alpha
const zbuf = new Float32Array(W * W).fill(-Infinity);
for (let t = 0; t < idx.length; t += 3) {
  const a = idx[t], b = idx[t + 1], c = idx[t + 2];
  const A = screen(rp[a]), B = screen(rp[b]), C = screen(rp[c]);
  const za = rp[a][2], zb = rp[b][2], zc = rp[c][2];
  const ca = vColor(a * 3), cb = vColor(b * 3), cc = vColor(c * 3);
  const minx = Math.max(0, Math.floor(Math.min(A[0], B[0], C[0])));
  const maxx = Math.min(W - 1, Math.ceil(Math.max(A[0], B[0], C[0])));
  const miny = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1])));
  const maxy = Math.min(W - 1, Math.ceil(Math.max(A[1], B[1], C[1])));
  const area = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
  if (Math.abs(area) < 1e-9) continue;
  for (let y = miny; y <= maxy; y++) {
    for (let x = minx; x <= maxx; x++) {
      const px = x + 0.5, py = y + 0.5;
      let w0 = (B[0] - px) * (C[1] - py) - (B[1] - py) * (C[0] - px);
      let w1 = (C[0] - px) * (A[1] - py) - (C[1] - py) * (A[0] - px);
      let w2 = (A[0] - px) * (B[1] - py) - (A[1] - py) * (B[0] - px);
      if ((w0 < 0 || w1 < 0 || w2 < 0) && (w0 > 0 || w1 > 0 || w2 > 0)) continue;
      w0 /= area; w1 /= area; w2 /= area;
      const z = w0 * za + w1 * zb + w2 * zc;
      const o = y * W + x;
      if (z <= zbuf[o]) continue;
      zbuf[o] = z;
      col[o * 3] = w0 * ca[0] + w1 * cb[0] + w2 * cc[0];
      col[o * 3 + 1] = w0 * ca[1] + w1 * cb[1] + w2 * cc[1];
      col[o * 3 + 2] = w0 * ca[2] + w1 * cb[2] + w2 * cc[2];
      acov[o] = 1;
    }
  }
}

// ---- downsample (box) to SIZE ----
// BG = null -> transparent background; otherwise an [r,g,b] in 0..1 to fill
// behind the cup (e.g. the table green [0x2c,0x6e,0x49]/255).
const BG = [0x2c / 255, 0x6e / 255, 0x49 / 255]; // table green
const RADIUS = SIZE * 0.22;       // rounded-corner radius (px); 0 -> square
// Coverage of a rounded-rect at pixel (x,y), anti-aliased by NxN subsampling.
function roundMask(x, y) {
  if (RADIUS <= 0) return 1;
  let hit = 0; const N = 4;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const px = x + (i + 0.5) / N, py = y + (j + 0.5) / N;
    const dx = Math.max(RADIUS - px, px - (SIZE - RADIUS), 0);
    const dy = Math.max(RADIUS - py, py - (SIZE - RADIUS), 0);
    if (dx * dx + dy * dy <= RADIUS * RADIUS) hit++;
  }
  return hit / (N * N);
}
const out = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    // accumulate cup colour weighted by coverage (avoids dark edge fringe),
    // and track mean coverage as the alpha.
    let r = 0, g = 0, bch = 0, wsum = 0, cov = 0;
    for (let sy2 = 0; sy2 < SS; sy2++)
      for (let sx2 = 0; sx2 < SS; sx2++) {
        const o = ((y * SS + sy2) * W + (x * SS + sx2));
        const al = acov[o];
        r += col[o * 3] * al; g += col[o * 3 + 1] * al; bch += col[o * 3 + 2] * al;
        wsum += al; cov++;
      }
    const a = wsum / cov;            // mean coverage -> alpha
    if (wsum > 0) { r /= wsum; g /= wsum; bch /= wsum; }
    let oa = a;
    if (BG) {                        // composite over an opaque background
      r = r * a + BG[0] * (1 - a); g = g * a + BG[1] * (1 - a); bch = bch * a + BG[2] * (1 - a);
      oa = 1;
    }
    oa *= roundMask(x, y);           // clip to rounded corners
    const o4 = (y * SIZE + x) * 4;
    out[o4] = Math.round(Math.min(1, r) * 255);
    out[o4 + 1] = Math.round(Math.min(1, g) * 255);
    out[o4 + 2] = Math.round(Math.min(1, bch) * 255);
    out[o4 + 3] = Math.round(oa * 255);
  }
}

// ---- encode PNG ----
function crc32(b) {
  let c = ~0;
  for (let i = 0; i < b.length; i++) {
    c ^= b[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  out.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(OUT, png);
console.log(`wrote ${OUT} (${SIZE}x${SIZE}, ${idx.length / 3} tris)`);
