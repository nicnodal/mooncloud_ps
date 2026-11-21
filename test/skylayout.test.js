// Offline acceptance tests for plugin/skylayout.js (spec v2 section 8).
// Run: node test/skylayout.test.js
const path = require("path");
const S = require(path.join(__dirname, "../plugin/skylayout.js"));
const REF = require(path.join(__dirname, "reference_equirectToSkyLayout.js"));

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
}

// ---- frame vectors
const g = S.frameGeometry(4096, 10);
const frameVectors = [
  [0, 0, 1836.00, 8.00], [0, 5, 1836.00, 212.00], [90, 0, 8.00, 2260.00], [135, 5, 432.00, 3884.00],
  [180, 0, 2260.00, 4088.00], [180, 9, 2260.00, 3720.80], [225, 2, 4006.40, 3664.00], [270, 0, 4088.00, 1836.00],
  [315, 5, 3664.00, 212.00], [0, 10.0001, 2048.00, 432.00], [30, 45, 1649.14, 1357.15],
  [0, 90, 2048, 2048], [123, 90, 2048, 2048]
];
for (const [az, el, ex, ey] of frameVectors) {
  const [x, y] = S.frameForward(az, el, g);
  const err = Math.max(Math.abs(x - ex), Math.abs(y - ey));
  check(`frame (${az}, ${el}) -> (${ex}, ${ey})`, err < 0.01, `got (${x.toFixed(2)}, ${y.toFixed(2)})`);
}

// ---- disc vectors (spec gives 1 decimal)
const discVectors = [[0, 0, 2048, 0], [90, 0, 0, 2048], [180, 0, 2048, 4096], [270, 0, 4096, 2048],
  [0, 45, 2048, 1199.7], [45, 30, 1211.9, 1211.9], [0, 90, 2048, 2048]];
for (const [az, el, ex, ey] of discVectors) {
  const [x, y] = S.discForward(az, el, 4096, 0);
  const err = Math.max(Math.abs(x - ex), Math.abs(y - ey));
  check(`disc (${az}, ${el}) -> (${ex}, ${ey})`, err < 0.06, `got (${x.toFixed(2)}, ${y.toFixed(2)})`);
}

// ---- round trip: forward -> inverse returns the same direction
function angDist(az1, el1, az2, el2) {
  const d = Math.PI / 180;
  const v = (a, e) => [Math.cos(e * d) * Math.sin(a * d), Math.sin(e * d), Math.cos(e * d) * Math.cos(a * d)];
  const p = v(az1, el1), q = v(az2, el2);
  const c = [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
  return Math.atan2(Math.hypot(...c), p[0] * q[0] + p[1] * q[1] + p[2] * q[2]) / d;
}
let rng = 12345;
const rand = () => ((rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648);
for (const band of [10, 15]) {
  const gb = S.frameGeometry(4096, band);
  let worst = 0;
  for (let i = 0; i < 200000; i++) {
    const az = rand() * 360, el = Math.asin(rand()) * 180 / Math.PI; // uniform on the upper hemisphere
    const [x, y] = S.frameForward(az, el, gb);
    const p = S.frameInverse(x, y, gb);
    worst = Math.max(worst, angDist(az, el, p.az, p.el));
  }
  check(`frame round trip band ${band}`, worst < 1e-9, `worst ${worst.toExponential(2)} deg`);
}
{
  let worst = 0;
  for (let i = 0; i < 200000; i++) {
    const az = rand() * 360, el = Math.asin(rand()) * 180 / Math.PI;
    const [x, y] = S.discForward(az, el, 4096, 0);
    const p = S.discInverse(x, y, 4096, 0);
    worst = Math.max(worst, angDist(az, el, p.az, p.el));
  }
  check("disc round trip", worst < 1e-9, `worst ${worst.toExponential(2)} deg`);
}

// ---- reference equivalence: the band-wise converter must reproduce the
// spec's reference equirectToSkyLayout pixel for pixel.
function randomImage(w, h, c, seed) {
  let s = seed;
  const a = new Float32Array(w * h * c);
  for (let i = 0; i < a.length; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    a[i] = (s / 2147483648) * (i % c === 3 ? 1 : 8); // HDR-ish colour, 0..1 alpha
  }
  return a;
}
function maxAbsDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}
const srcFull = randomImage(720, 360, 4, 7);
const srcHalf = randomImage(720, 180, 4, 9);
const cases = [
  ["frame full 2:1", srcFull, 720, 360, { layout: "frame", size: 256 }],
  ["frame half 4:1 yaw 30 band 15", srcHalf, 720, 180, { layout: "frame", size: 300, yawDeg: 30, bandDeg: 15 }],
  ["disc extend", srcFull, 720, 360, { layout: "disc", size: 256 }],
  ["disc black skirt 5", srcFull, 720, 360, { layout: "disc", size: 200, corners: "black", skirtDeg: 5 }],
  ["disc transparent", srcFull, 720, 360, { layout: "disc", size: 200, corners: "transparent" }],
  ["frame minSamples 2", srcFull, 720, 360, { layout: "frame", size: 256, minSamples: 2 }]
];
for (const [name, src, w, h, o] of cases) {
  const a = REF.equirectToSkyLayout(src, w, h, o);
  const b = S.equirectToSkyLayout(src, w, h, o);
  const d = maxAbsDiff(a, b);
  check(`matches reference: ${name}`, d === 0, `max diff ${d}`);
}

// 3-channel path == 4-channel path on RGB
{
  const w = 720, h = 360, rgb = new Float32Array(w * h * 3), rgba = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) rgb[i * 3 + c] = rgba[i * 4 + c] = srcFull[i * 4 + c];
    rgba[i * 4 + 3] = 1;
  }
  for (const o of [{ layout: "frame", size: 256 }, { layout: "disc", size: 256, corners: "transparent" }]) {
    const ref = S.equirectToSkyLayout(rgba, w, h, o);
    const conv = S.createConverter(rgb, w, h, 3, o);
    const out = new Float32Array(conv.size * conv.size * conv.outComponents);
    conv.renderRows(0, 100, out.subarray(0, 100 * conv.size * conv.outComponents));
    conv.renderRows(100, conv.size, out.subarray(100 * conv.size * conv.outComponents));
    let m = 0;
    for (let i = 0; i < conv.size * conv.size; i++) {
      for (let c = 0; c < conv.outComponents; c++) m = Math.max(m, Math.abs(out[i * conv.outComponents + c] - ref[i * 4 + c]));
    }
    check(`3-channel source, banded, ${o.layout}`, m < 1e-5, `outComponents ${conv.outComponents}, max diff ${m.toExponential(2)}`);
  }
}

// ---- image test 2 analogue: a smooth full equirect and its top half give the
// same frame wherever el >= 0 (here: everywhere, the band starts at 0).
function psnr(a, b, comps, mask) {
  let se = 0, n = 0;
  for (let i = 0; i < a.length / comps; i++) {
    if (mask && !mask[i]) continue;
    for (let c = 0; c < 3; c++) { const d = a[i * comps + c] - b[i * comps + c]; se += d * d; n++; }
  }
  return 10 * Math.log10(1 / (se / n));
}
{
  const w = 2048, h = 1024, full = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const az = (x + 0.5) / w * 2 * Math.PI, el = (0.5 - (y + 0.5) / h) * Math.PI, i = (y * w + x) * 4;
    full[i] = 0.5 + 0.5 * Math.sin(az * 12) * Math.cos(el * 9);
    full[i + 1] = 0.5 + 0.5 * Math.cos(az * 7 + el * 5);
    full[i + 2] = ((Math.floor(az * 18 / Math.PI) + Math.floor(el * 18 / Math.PI)) & 1) ? 0.9 : 0.1; // 10 deg checker
    full[i + 3] = 1;
  }
  const half = full.slice(0, w * (h / 2) * 4);
  const a = S.equirectToSkyLayout(full, w, h, { size: 512 });
  const b = S.equirectToSkyLayout(half, w, h / 2, { size: 512 });
  // mask out the strip gutters below the horizon (el < 0, where the half source clamps)
  const gg = S.frameGeometry(512, 10), mask = new Uint8Array(512 * 512);
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) mask[y * 512 + x] = S.frameInverse(x + 0.5, y + 0.5, gg).el >= 0.5 ? 1 : 0;
  const p = psnr(a, b, 4, mask);
  check("full 2:1 vs top half 4:1 agree where el >= 0", p > 33, `PSNR ${p.toFixed(1)} dB`);

  // HDR: a 50.0 sun survives (no clamping), and its energy is roughly kept
  const sun = full.slice();
  const sx = Math.round(w * 0.5 + w * 20 / 360), sy = Math.round(h * (0.5 - 30 / 180));
  for (let y = sy - 3; y <= sy + 3; y++) for (let x = sx - 3; x <= sx + 3; x++) { const i = (y * w + x) * 4; sun[i] = sun[i + 1] = sun[i + 2] = 50; }
  const o = S.equirectToSkyLayout(sun, w, h, { size: 1024 });
  let peak = 0, nan = 0;
  for (let i = 0; i < o.length; i++) { if (Number.isNaN(o[i])) nan++; else peak = Math.max(peak, o[i]); }
  check("HDR peak kept above 1, no NaNs", peak > 5 && nan === 0, `peak ${peak.toFixed(2)}, NaNs ${nan}`);
}

// ---- timing at a realistic ratio (scaled down 4x each way from 12K half -> 4096)
{
  const w = 3072, h = 768, src = randomImage(w, h, 3, 3);
  const t = Date.now();
  const conv = S.createConverter(src, w, h, 3, { size: 1024 });
  const out = new Float32Array(1024 * 1024 * 3);
  conv.renderRows(0, 1024, out);
  const ms = Date.now() - t;
  console.log(`info 3072x768 RGB -> frame 1024: ${ms} ms (x16 pixels for 12K -> 4096: about ${(ms * 16 / 1000).toFixed(0)} s)`);
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
