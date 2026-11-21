// ---------- Sky dome layout conversion (pure maths, no Photoshop) ----------
// Equirect sky (full 2:1, upper-half 4:1, or any top-anchored elevation
// range) -> square sky-dome texture, following
// SKYDOME_LAYOUT_CONVERSION_SPEC_v2.md:
//
//   'frame' (default) 4 horizon strips (el 0..bandDeg) pinwheeled around the
//                     edge + a stereographic cap (el bandDeg..90) in the middle,
//                     8 px gutters at 4096. 40.6 texels/deg across 0-10 deg.
//   'disc'            one stereographic disc, zenith centred, horizon on the edge.
//
// Both: North at the top, East on the LEFT (the sky seen from inside the dome).
// The maths (frameGeometry / frameInverse / frameForward and the sampling) is
// the spec's reference equirectToSkyLayout.js; the converter below is the same
// algorithm restructured so Photoshop can run it band by band (progress,
// cancel) and so it takes 3 or 4 channels without padding the source to RGBA.
// equirectToSkyLayout() keeps the reference signature for tests.
//
// Loaded by plugin/index.html as a plain script (sets globalThis.SkyLayout)
// and by Node for the offline tests (module.exports).
(function (root) {
  const D2R = Math.PI / 180;

  /** Frame layout geometry for a given output size (constants are defined at 4096 and scale). */
  function frameGeometry(size = 4096, bandDeg = 10) {
    const k = size / 4096;
    const H = Math.round(424 * k), G = Math.max(1, Math.round(8 * k));
    const L = size - H - 2 * G, T = H - 2 * G, S = size - 2 * H, RC = S / 2 - G;
    const RT = Math.tan((90 - bandDeg) * D2R / 2);
    return { N: size, E: bandDeg, H, G, L, T, S, RC, RT };
  }

  /** Frame: pixel (x, y, y down) -> {az, el, reg, rho}. reg 0 top, 1 right, 2 bottom, 3 left, 4 cap. */
  function frameInverse(px, py, g) {
    const { N, E, H, G, L, T, RC, RT } = g;
    if (py < H && px < N - H) return { az: 45 - 90 * (px - G) / L, el: E * (py - G) / T, reg: 0, rho: 0 };
    if (px >= N - H && py < N - H) return { az: -45 - 90 * (py - G) / L, el: E * ((N - G) - px) / T, reg: 1, rho: 0 };
    if (py >= N - H && px >= H) return { az: 225 - 90 * ((N - G) - px) / L, el: E * ((N - G) - py) / T, reg: 2, rho: 0 };
    if (px < H && py >= H) return { az: 135 - 90 * ((N - G) - py) / L, el: E * (px - G) / T, reg: 3, rho: 0 };
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

  /** Disc: direction -> pixel [x, y] (y down). */
  function discForward(azDeg, elDeg, size = 4096, skirtDeg = 0) {
    const rEdge = Math.tan((90 + skirtDeg) * D2R / 2);
    const r = Math.tan((90 - elDeg) * D2R / 2) / rEdge;
    return [size * (0.5 - r * Math.sin(azDeg * D2R) / 2), size * (0.5 - r * Math.cos(azDeg * D2R) / 2)];
  }

  /** Disc: pixel (x, y, y down) -> {az, el, rho}. */
  function discInverse(px, py, size = 4096, skirtDeg = 0) {
    const rEdge = Math.tan((90 + skirtDeg) * D2R / 2);
    const dx = (px / size * 2 - 1) * rEdge, dy = (py / size * 2 - 1) * rEdge, r = Math.hypot(dx, dy);
    return { az: Math.atan2(-dx, -dy) / D2R, el: 90 - 2 * Math.atan(r) / D2R, rho: r };
  }

  /** Elevation range (deg) of a source from its aspect, as the spec infers it. null if it can't. */
  function elevationRangeFromAspect(width, height) {
    const a = width / height;
    if (Math.abs(a - 2) < 0.02) return { elTop: 90, elBottom: -90 };
    if (Math.abs(a - 4) < 0.04) return { elTop: 90, elBottom: 0 };
    return null;
  }

  function outputSuffix(layout, size) {
    return `_sky${layout === "disc" ? "disc" : "frame"}${size}`;
  }

  /**
   * Prepares a conversion. Builds the x-only rip-map of the source (about 1x
   * the source again in memory), then renderRows() fills output rows on demand.
   *
   * @param {Float32Array} src  interleaved, row 0 = top, `components` channels (3 RGB or 4 RGBA)
   * @param {number} width
   * @param {number} height
   * @param {number} components
   * @param {object} [o]  same options as the spec's equirectToSkyLayout
   *   (layout, size, elTop, elBottom, yawDeg, bandDeg, skirtDeg, minSamples, corners)
   */
  function createConverter(src, width, height, components, o = {}) {
    const layout = o.layout === "disc" ? "disc" : "frame";
    const N = o.size ?? 4096;
    let elTop = o.elTop, elBottom = o.elBottom;
    if (elTop === undefined || elBottom === undefined) {
      const r = elevationRangeFromAspect(width, height);
      if (!r) throw new Error(`Can't infer elevation range from ${width}x${height}; pass elTop/elBottom`);
      elTop = r.elTop;
      elBottom = r.elBottom;
    }
    const C = components;
    if (C !== 3 && C !== 4) throw new Error(`Expected 3 or 4 channels, got ${C}`);
    const yaw = o.yawDeg ?? 0, nsMin = Math.max(1, o.minSamples ?? 3);
    const corners = layout === "disc" ? (o.corners ?? "extend") : "extend";
    const skirt = o.skirtDeg ?? 0;
    const g = layout === "frame" ? frameGeometry(N, o.bandDeg ?? 10) : null;
    // RGBA when the source has alpha or the disc corners are cut out to transparent
    // o.ignoreAlpha: treat a 4-channel source as opaque (its alpha is skipped)
    const useAlpha = C === 4 && !o.ignoreAlpha;
    const outComponents = useAlpha || corners === "transparent" ? 4 : 3;

    // ---- x-only rip-map (each level halves the width, wrapping)
    const levels = [{ w: width, d: src }];
    while (levels[levels.length - 1].w > 1) {
      const p = levels[levels.length - 1], pw = p.w, w = (pw + 1) >> 1, pd = p.d;
      const d = new Float32Array(w * height * C);
      for (let y = 0; y < height; y++) {
        const ro = y * pw * C, wo = y * w * C;
        for (let x = 0; x < w; x++) {
          const a = ro + 2 * x * C, b = ro + ((2 * x + 1) % pw) * C, q = wo + x * C;
          for (let c = 0; c < C; c++) d[q + c] = 0.5 * (pd[a + c] + pd[b + c]);
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
      const r0 = y0 * w * C, r1 = y1 * w * C;
      const a0 = r0 + x0 * C, a1 = r0 + x1 * C, b0 = r1 + x0 * C, b1 = r1 + x1 * C;
      for (let c = 0; c < C; c++) {
        const a = d[a0 + c] * (1 - tx) + d[a1 + c] * tx;
        const b = d[b0 + c] * (1 - tx) + d[b1 + c] * tx;
        acc[c] += wgt * (a * (1 - ty) + b * ty);
      }
    }
    function sample(u, y, footX, wgt) {
      const lod = Math.min(Math.log2(Math.max(footX, 1)), maxLvl), l0 = Math.floor(lod), t = lod - l0;
      if (t < 1e-6 || l0 >= maxLvl) bilinear(l0, u, y, wgt);
      else { bilinear(l0, u, y, wgt * (1 - t)); bilinear(l0 + 1, u, y, wgt * t); }
    }

    const yPerDeg = height / (elTop - elBottom), xPerDeg = width / 360;
    const rEdge = Math.tan((90 + skirt) * D2R / 2), pxDisc = 2 * rEdge / N; // disc only

    // pixel -> direction, written into a reused object (no allocation in the hot loop)
    const loc = { az: 0, el: 0, rho: 0, inside: true, fAz: 0, fEl: 0 };
    function locate(px, py) {
      if (g) {
        const { N: n, E, H, G, L, T, RC, RT } = g;
        let reg = 4;
        if (py < H && px < n - H) { loc.az = 45 - 90 * (px - G) / L; loc.el = E * (py - G) / T; reg = 0; }
        else if (px >= n - H && py < n - H) { loc.az = -45 - 90 * (py - G) / L; loc.el = E * ((n - G) - px) / T; reg = 1; }
        else if (py >= n - H && px >= H) { loc.az = 225 - 90 * ((n - G) - px) / L; loc.el = E * ((n - G) - py) / T; reg = 2; }
        else if (px < H && py >= H) { loc.az = 135 - 90 * ((n - G) - py) / L; loc.el = E * (px - G) / T; reg = 3; }
        if (reg < 4) {
          loc.rho = 0;
          loc.fAz = 90 / L;
          loc.fEl = E / T;
        } else {
          const dx = (px - n / 2) / RC * RT, dy = (py - n / 2) / RC * RT, r = Math.hypot(dx, dy);
          loc.az = Math.atan2(-dx, -dy) / D2R;
          loc.el = 90 - 2 * Math.atan(r) / D2R;
          loc.rho = r;
          const ps = RT / RC, rc = Math.max(r, ps * 0.5);
          loc.fAz = ps / rc / D2R;
          loc.fEl = ps * 2 / (1 + rc * rc) / D2R;
        }
        loc.inside = true;
        return loc;
      }
      const dx = (px / N * 2 - 1) * rEdge, dy = (py / N * 2 - 1) * rEdge, r = Math.hypot(dx, dy);
      const rc = Math.max(r, pxDisc * 0.5);
      loc.az = Math.atan2(-dx, -dy) / D2R;
      loc.el = 90 - 2 * Math.atan(r) / D2R;
      loc.rho = r;
      loc.inside = r <= rEdge;
      loc.fAz = pxDisc / rc / D2R;
      loc.fEl = pxDisc * 2 / (1 + rc * rc) / D2R;
      return loc;
    }

    /**
     * Renders output rows [row0, row1) into `out` (interleaved, outComponents
     * channels, row row0 at offset 0). Values are never clamped.
     */
    function renderRows(row0, row1, out) {
      const OC = outComponents;
      for (let row = row0; row < row1; row++) {
        for (let col = 0; col < N; col++) {
          locate(col + 0.5, row + 0.5);
          const fxTotal = loc.fAz * xPerDeg, fyTotal = loc.fEl * yPerDeg;
          const nsx = nsMin, nsy = Math.min(16, Math.max(nsMin, Math.ceil(fyTotal)));
          const fxSub = fxTotal / nsx, wgt = 1 / (nsx * nsy);
          acc[0] = acc[1] = acc[2] = acc[3] = 0;
          let cover = 0;
          for (let sy = 0; sy < nsy; sy++) {
            for (let sx = 0; sx < nsx; sx++) {
              locate(col + (sx + 0.5) / nsx, row + (sy + 0.5) / nsy);
              if (!loc.inside && corners !== "extend") continue;
              cover += wgt;
              sample((loc.az - yaw) / 360 + 0.5, (elTop - loc.el) * yPerDeg, fxSub, wgt);
            }
          }
          // a source without alpha counts as alpha 1 wherever it was sampled
          const alpha = useAlpha ? acc[3] : cover;
          const q = ((row - row0) * N + col) * OC;
          if (corners === "extend") {
            out[q] = acc[0]; out[q + 1] = acc[1]; out[q + 2] = acc[2];
            if (OC === 4) out[q + 3] = alpha;
          } else if (corners === "black") {
            out[q] = acc[0]; out[q + 1] = acc[1]; out[q + 2] = acc[2];
            if (OC === 4) out[q + 3] = alpha + (1 - cover);
          } else {
            if (cover > 0) { out[q] = acc[0] / cover; out[q + 1] = acc[1] / cover; out[q + 2] = acc[2] / cover; }
            else { out[q] = out[q + 1] = out[q + 2] = 0; }
            out[q + 3] = alpha;
          }
        }
      }
    }

    return { size: N, layout, outComponents, elTop, elBottom, geometry: g, renderRows };
  }

  /** Reference-compatible one-shot call: RGBA Float32Array in, RGBA size*size*4 out. */
  function equirectToSkyLayout(src, width, height, o = {}) {
    const conv = createConverter(src, width, height, 4, o);
    const N = conv.size, out = new Float32Array(N * N * 4);
    const rowBuf = new Float32Array(N * 4);
    for (let row = 0; row < N; row++) {
      conv.renderRows(row, row + 1, rowBuf);
      out.set(rowBuf, row * N * 4);
      if (o.onRow) o.onRow(row + 1, N);
    }
    return out;
  }

  const api = {
    frameGeometry, frameInverse, frameForward, discForward, discInverse,
    elevationRangeFromAspect, outputSuffix, createConverter, equirectToSkyLayout
  };
  root.SkyLayout = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
