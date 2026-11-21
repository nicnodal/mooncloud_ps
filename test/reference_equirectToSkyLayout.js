/**
 * equirectToSkyLayout.js — reference implementation (no dependencies).
 *
 * Converts an equirectangular sky (full 2:1 or upper-half 4:1) into a square
 * sky-dome texture in one of two layouts:
 *
 *   'frame' (default) — 4 horizon strips (el 0..10°) laid pinwheel-style around the
 *                       edge + a stereographic disc for el 10..90° in the middle.
 *                       8 px gutters (at 4096). 40.6 texels/° across 0–10° at 4096.
 *   'disc'            — one stereographic disc, zenith centred, horizon on the edge.
 *                       35.7 texels/° at the horizon at 4096. No seams.
 *
 * Both: North at the top, East on the LEFT (reads correctly from inside the dome).
 * Pixels are interleaved RGBA Float32Array, row 0 = top.
 */

const D2R = Math.PI / 180;

/** Frame layout geometry for a given output size (constants are defined at 4096 and scale). */
function frameGeometry(size = 4096, bandDeg = 10) {
  const k = size / 4096;
  const H = Math.round(424 * k), G = Math.max(1, Math.round(8 * k));
  const L = size - H - 2 * G, T = H - 2 * G, S = size - 2 * H, RC = S / 2 - G;
  const RT = Math.tan((90 - bandDeg) * D2R / 2);
  return { N: size, E: bandDeg, H, G, L, T, S, RC, RT };
}

/** Frame: pixel (x, y, y down) -> {az, el, reg, rho}. reg 0 top,1 right,2 bottom,3 left,4 cap. */
function frameInverse(px, py, g) {
  const { N, E, H, G, L, T, RC, RT } = g;
  if (py < H && px < N - H)  return { az: 45 - 90 * (px - G) / L,        el: E * (py - G) / T,          reg: 0, rho: 0 };
  if (px >= N - H && py < N - H) return { az: -45 - 90 * (py - G) / L,   el: E * ((N - G) - px) / T,    reg: 1, rho: 0 };
  if (py >= N - H && px >= H) return { az: 225 - 90 * ((N - G) - px) / L, el: E * ((N - G) - py) / T,   reg: 2, rho: 0 };
  if (px < H && py >= H)      return { az: 135 - 90 * ((N - G) - py) / L, el: E * (px - G) / T,         reg: 3, rho: 0 };
  const dx = (px - N / 2) / RC * RT, dy = (py - N / 2) / RC * RT, r = Math.hypot(dx, dy);
  return { az: Math.atan2(-dx, -dy) / D2R, el: 90 - 2 * Math.atan(r) / D2R, reg: 4, rho: r };
}

/** Frame: direction -> pixel [x, y] (y down). region optional (0..4), otherwise chosen from the direction. */
function frameForward(azDeg, elDeg, g, region) {
  const { N, E, G, L, T, RC, RT } = g;
  const a = ((azDeg + 180) % 360 + 360) % 360 - 180, a2 = ((azDeg % 360) + 360) % 360;
  if (region === undefined) {
    if (elDeg > E) region = 4;
    else { const q = (a2 + 45) % 360; region = q < 90 ? 0 : q < 180 ? 3 : q < 270 ? 2 : 1; }
  }
  const t = G + elDeg / E * T;
  if (region === 0) return [G + (45 - a) / 90 * L, t];
  if (region === 1) return [N - t, G + (-45 - a) / 90 * L];
  if (region === 2) return [(N - G) - (225 - a2) / 90 * L, N - t];
  if (region === 3) return [t, (N - G) - (135 - a2) / 90 * L];
  const r = Math.tan((90 - elDeg) * D2R / 2) / RT * RC;
  return [N / 2 - r * Math.sin(azDeg * D2R), N / 2 - r * Math.cos(azDeg * D2R)];
}

/**
 * @param {Float32Array} src   RGBA, width*height*4
 * @param {number} width
 * @param {number} height
 * @param {object} [o]
 * @param {'frame'|'disc'} [o.layout='frame']
 * @param {number} [o.size=4096]        output width = height
 * @param {number} [o.elTop]            elevation (deg) at top edge of source (default from aspect)
 * @param {number} [o.elBottom]         elevation (deg) at bottom edge of source
 * @param {number} [o.yawDeg=0]         azimuth found at the horizontal centre of the source (0 = North)
 * @param {number} [o.bandDeg=10]       frame only: top of the horizon band
 * @param {number} [o.skirtDeg=0]       disc only: degrees below horizon included inside the disc
 * @param {number} [o.minSamples=3]     supersamples per axis (vertical is adaptive above this)
 * @param {'extend'|'black'|'transparent'} [o.corners='extend']  disc only
 * @param {(done:number,total:number)=>void} [o.onRow]
 * @returns {Float32Array} RGBA, size*size*4
 */
function equirectToSkyLayout(src, width, height, o = {}) {
  const layout = o.layout ?? 'frame';
  const N = o.size ?? 4096;
  let elTop = o.elTop, elBottom = o.elBottom;
  if (elTop === undefined || elBottom === undefined) {
    const a = width / height;
    if (Math.abs(a - 2) < 0.02) { elTop = 90; elBottom = -90; }
    else if (Math.abs(a - 4) < 0.04) { elTop = 90; elBottom = 0; }
    else throw new Error(`Can't infer elevation range from ${width}x${height}; pass elTop/elBottom`);
  }
  const yaw = o.yawDeg ?? 0, nsMin = Math.max(1, o.minSamples ?? 3);
  const corners = layout === 'disc' ? (o.corners ?? 'extend') : 'extend';
  const skirt = o.skirtDeg ?? 0;
  const g = layout === 'frame' ? frameGeometry(N, o.bandDeg ?? 10) : null;

  // ---- x-only rip-map (each level halves the width, wrapping)
  const levels = [{ w: width, d: src }];
  while (levels[levels.length - 1].w > 1) {
    const p = levels[levels.length - 1], pw = p.w, w = (pw + 1) >> 1;
    const d = new Float32Array(w * height * 4);
    for (let y = 0; y < height; y++) {
      const ro = y * pw * 4, wo = y * w * 4;
      for (let x = 0; x < w; x++) {
        const a = ro + 2 * x * 4, b = ro + ((2 * x + 1) % pw) * 4, q = wo + x * 4;
        for (let c = 0; c < 4; c++) d[q + c] = 0.5 * (p.d[a + c] + p.d[b + c]);
      }
    }
    levels.push({ w, d });
  }
  const maxLvl = levels.length - 1, acc = new Float64Array(4);
  function bilinear(lvl, u, y, wgt) {
    const Lv = levels[lvl], w = Lv.w, d = Lv.d;
    const fx = (((u % 1) + 1) % 1) * w - 0.5, fy = Math.min(Math.max(y - 0.5, 0), height - 1);
    const x0f = Math.floor(fx), y0 = Math.floor(fy), y1 = Math.min(y0 + 1, height - 1);
    const tx = fx - x0f, ty = fy - y0, x0 = ((x0f % w) + w) % w, x1 = (x0 + 1) % w;
    const r0 = y0 * w * 4, r1 = y1 * w * 4;
    for (let c = 0; c < 4; c++) {
      const a = d[r0 + x0 * 4 + c] * (1 - tx) + d[r0 + x1 * 4 + c] * tx;
      const b = d[r1 + x0 * 4 + c] * (1 - tx) + d[r1 + x1 * 4 + c] * tx;
      acc[c] += wgt * (a * (1 - ty) + b * ty);
    }
  }
  function sample(u, y, footX, wgt) {
    const lod = Math.min(Math.log2(Math.max(footX, 1)), maxLvl), l0 = Math.floor(lod), t = lod - l0;
    if (t < 1e-6 || l0 >= maxLvl) bilinear(l0, u, y, wgt);
    else { bilinear(l0, u, y, wgt * (1 - t)); bilinear(l0 + 1, u, y, wgt * t); }
  }

  const out = new Float32Array(N * N * 4);
  const yPerDeg = height / (elTop - elBottom), xPerDeg = width / 360;
  const rEdge = Math.tan((90 + skirt) * D2R / 2), pxDisc = 2 * rEdge / N;  // disc only

  // pixel -> {az, el} plus the pixel's footprint (deg of azimuth, deg of elevation)
  function locate(px, py) {
    if (layout === 'frame') {
      const p = frameInverse(px, py, g);
      if (p.reg < 4) return { ...p, fAz: 90 / g.L, fEl: g.E / g.T };
      const ps = g.RT / g.RC, rc = Math.max(p.rho, ps * 0.5);
      return { ...p, fAz: ps / rc / D2R, fEl: ps * 2 / (1 + rc * rc) / D2R };
    }
    const dx = (px / N * 2 - 1) * rEdge, dy = (py / N * 2 - 1) * rEdge, r = Math.hypot(dx, dy);
    const rc = Math.max(r, pxDisc * 0.5);
    return { az: Math.atan2(-dx, -dy) / D2R, el: 90 - 2 * Math.atan(r) / D2R, rho: r, inside: r <= rEdge,
             fAz: pxDisc / rc / D2R, fEl: pxDisc * 2 / (1 + rc * rc) / D2R };
  }

  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      const c = locate(col + 0.5, row + 0.5);
      const fxTotal = c.fAz * xPerDeg, fyTotal = c.fEl * yPerDeg;
      const nsx = nsMin, nsy = Math.min(16, Math.max(nsMin, Math.ceil(fyTotal)));
      const fxSub = fxTotal / nsx, wgt = 1 / (nsx * nsy);
      acc[0] = acc[1] = acc[2] = acc[3] = 0;
      let cover = 0;
      for (let sy = 0; sy < nsy; sy++) {
        for (let sx = 0; sx < nsx; sx++) {
          const s = locate(col + (sx + 0.5) / nsx, row + (sy + 0.5) / nsy);
          if (layout === 'disc' && !s.inside && corners !== 'extend') continue;
          cover += wgt;
          sample((s.az - yaw) / 360 + 0.5, (elTop - s.el) * yPerDeg, fxSub, wgt);
        }
      }
      const q = (row * N + col) * 4;
      if (corners === 'extend') { out[q] = acc[0]; out[q + 1] = acc[1]; out[q + 2] = acc[2]; out[q + 3] = acc[3]; }
      else if (corners === 'black') { out[q] = acc[0]; out[q + 1] = acc[1]; out[q + 2] = acc[2]; out[q + 3] = acc[3] + (1 - cover); }
      else { if (cover > 0) { out[q] = acc[0] / cover; out[q + 1] = acc[1] / cover; out[q + 2] = acc[2] / cover; } out[q + 3] = acc[3]; }
    }
    if (o.onRow) o.onRow(row + 1, N);
  }
  return out;
}

/** Backwards-compatible wrapper for the v1 spec. */
function equirectToDisc(src, width, height, o = {}) { return equirectToSkyLayout(src, width, height, { ...o, layout: 'disc' }); }

if (typeof module !== 'undefined') module.exports = { equirectToSkyLayout, equirectToDisc, frameGeometry, frameForward, frameInverse };
