// ---------- Convert to Sky Dome ----------
// DOME > CONVERT in the tool row. Converts the active equirect document
// (visible layers composite, never modified) into a new square document in
// the Frame (default) or Disc sky-dome layout, using plugin/skylayout.js,
// per SKYDOME_LAYOUT_CONVERSION_SPEC_v2.md.
//
// Loaded after index.js and skylayout.js; reuses index.js globals (log,
// describeError, showToast, equirectLatSpan, halfEquirect).
// Wrapped in a function so its consts don't collide with index.js's.
(function () {
  const { app, imaging, core, action, constants } = require("photoshop");
  const SL = globalThis.SkyLayout;

  const SKYDOME_BUILD = "2026-11-21 skydome-v2.2 rgb-write + diagnostics";
  const SETTINGS_KEY = "mooncloud.skyDome.v1";
  const DEFAULTS = { layout: "frame", size: 4096, yawDeg: 0, bandDeg: 10, minSamples: 3, skirtDeg: 0, corners: "extend" };
  const SIZES = [2048, 4096, 8192];
  const READ_BAND_BYTES = 64 * 1024 * 1024; // source rows read per getPixels
  const WRITE_BAND_ROWS = 64; // output rows rendered per putPixels
  const U16_ONE = 32768; // Photoshop's 16-bit white

  // ---- remembered settings (plugin-wide, last used). Stored in the
  // plugin's data folder (localStorage isn't reliable in UXP), with
  // localStorage as a fallback.
  const SETTINGS_FILE = "skydome-settings.json";
  async function loadSettings() {
    let s = null;
    try {
      const folder = await require("uxp").storage.localFileSystem.getDataFolder();
      const entry = await folder.getEntry(SETTINGS_FILE);
      s = JSON.parse(await entry.read());
    } catch (err) {
      try {
        s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
      } catch (e) {
        s = null;
      }
    }
    return { ...DEFAULTS, ...(s && typeof s === "object" ? s : {}) };
  }
  async function saveSettings(s) {
    try {
      const folder = await require("uxp").storage.localFileSystem.getDataFolder();
      const file = await folder.createFile(SETTINGS_FILE, { overwrite: true });
      await file.write(JSON.stringify(s));
      return;
    } catch (err) {
      log("sky dome: couldn't save settings to the data folder: " + describeError(err), true);
    }
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    } catch (err) {
      // nothing else to try
    }
  }

  // ---- sRGB transfer for 8/16-bit documents (32-bit is linear already)
  function srgbToLinear(v) {
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  function linearToSrgb(v) {
    return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  }
  // linear 0..1 -> encoded integer, through a 4096-step table plus lerp
  const ENC_STEPS = 4096;
  let encTable = null;
  function encodeTable() {
    if (!encTable) {
      encTable = new Float64Array(ENC_STEPS + 1);
      for (let i = 0; i <= ENC_STEPS; i++) encTable[i] = linearToSrgb(i / ENC_STEPS);
    }
    return encTable;
  }

  // ---- what the source is and how it maps to elevation
  function describeSource(doc) {
    const W = Math.round(doc.width), H = Math.round(doc.height);
    const depth = doc.bitsPerChannel === constants.BitsPerChannelType.THIRTYTWO ? 32
      : doc.bitsPerChannel === constants.BitsPerChannelType.SIXTEEN ? 16 : 8;
    const half = typeof halfEquirect !== "undefined" && !!halfEquirect;
    const latSpanDeg = equirectLatSpan(W, H) * 180 / Math.PI;
    // like the EXR export and the preview, a taller than 2:1 document uses its top 2:1
    const rows = half ? H : Math.min(H, Math.round(W / 2));
    const problems = [];
    if (doc.mode !== constants.DocumentMode.RGB) problems.push("The document must be in RGB mode.");
    if (!half && W / H > 4.04) problems.push(`${W}x${H} is wider than 4:1; it doesn't look like an equirect.`);
    const range = SL.elevationRangeFromAspect(W, rows);
    const note = half ? "half equirect (viewer Half toggle)"
      : range ? (range.elBottom === 0 ? "half equirect (4:1)" : "full equirect (2:1)")
      : `non-standard ${(W / H).toFixed(2)}:1, top-anchored`;
    return {
      width: W, height: H, rows, depth, half,
      elTop: 90, elBottom: 90 - latSpanDeg,
      note, problems,
      baseName: String(doc.name || doc.title || "sky").replace(/\.[^.]+$/, "")
    };
  }

  function fmtDeg(v) {
    return `${v > 0 ? "+" : ""}${Math.round(v * 10) / 10}°`;
  }

  // ---- dialog
  function setToggle(groupId, value) {
    const group = document.getElementById(groupId);
    if (!group) return;
    for (const el of group.querySelectorAll(".sdopt")) {
      if (el.getAttribute("data-value") === String(value)) el.classList.add("on");
      else el.classList.remove("on");
    }
  }
  function readToggle(groupId) {
    const on = document.querySelector(`#${groupId} .sdopt.on`);
    return on ? on.getAttribute("data-value") : null;
  }
  function numberField(id, fallback, min, max) {
    const el = document.getElementById(id);
    const v = parseFloat(el && el.value);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, v));
  }

  async function showSkyDomeDialog(src) {
    const dlg = document.getElementById("skyDomeDialog");
    const s = await loadSettings();
    if (!dlg || typeof dlg.uxpShowModal !== "function") return s;

    document.getElementById("sdSource").textContent =
      `${src.baseName}: ${src.width}x${src.height}, ${src.depth}-bit, ${src.note}, el ${fmtDeg(src.elTop)} to ${fmtDeg(src.elBottom)}` +
      (src.rows < src.height ? ` (top ${src.rows} rows)` : "");
    setToggle("sdLayout", s.layout);
    setToggle("sdSize", s.size);
    setToggle("sdCorners", s.corners);
    document.getElementById("sdYaw").value = String(s.yawDeg);
    document.getElementById("sdBand").value = String(s.bandDeg);
    document.getElementById("sdSamples").value = String(s.minSamples);
    document.getElementById("sdSkirt").value = String(s.skirtDeg);

    const refresh = () => {
      const layout = readToggle("sdLayout") || "frame";
      const size = parseInt(readToggle("sdSize"), 10) || 4096;
      document.getElementById("sdFrameOpts").hidden = layout !== "frame";
      document.getElementById("sdDiscOpts").hidden = layout !== "disc";
      document.getElementById("sdOutName").textContent = src.baseName + SL.outputSuffix(layout, size);
    };
    for (const groupId of ["sdLayout", "sdSize", "sdCorners"]) {
      for (const el of document.querySelectorAll(`#${groupId} .sdopt`)) {
        el.onclick = () => {
          setToggle(groupId, el.getAttribute("data-value"));
          refresh();
        };
      }
    }
    const adv = document.getElementById("sdAdvanced");
    const advLink = document.getElementById("sdAdvancedToggle");
    adv.hidden = true;
    advLink.textContent = "show advanced";
    advLink.onclick = () => {
      adv.hidden = !adv.hidden;
      advLink.textContent = adv.hidden ? "show advanced" : "hide advanced";
    };
    document.getElementById("sdReset").onclick = () => {
      setToggle("sdLayout", DEFAULTS.layout);
      setToggle("sdSize", DEFAULTS.size);
      setToggle("sdCorners", DEFAULTS.corners);
      document.getElementById("sdYaw").value = String(DEFAULTS.yawDeg);
      document.getElementById("sdBand").value = String(DEFAULTS.bandDeg);
      document.getElementById("sdSamples").value = String(DEFAULTS.minSamples);
      document.getElementById("sdSkirt").value = String(DEFAULTS.skirtDeg);
      refresh();
    };
    refresh();

    const result = await dlg.uxpShowModal({ title: "Convert to Sky Dome", resize: "none" });
    if (result !== "convert") return null;
    const out = {
      layout: readToggle("sdLayout") === "disc" ? "disc" : "frame",
      size: parseInt(readToggle("sdSize"), 10) || DEFAULTS.size,
      yawDeg: numberField("sdYaw", DEFAULTS.yawDeg, -360, 360),
      bandDeg: numberField("sdBand", DEFAULTS.bandDeg, 1, 45),
      minSamples: Math.round(numberField("sdSamples", DEFAULTS.minSamples, 1, 8)),
      skirtDeg: numberField("sdSkirt", DEFAULTS.skirtDeg, 0, 45),
      corners: ["extend", "black", "transparent"].includes(readToggle("sdCorners")) ? readToggle("sdCorners") : "extend"
    };
    if (!SIZES.includes(out.size)) out.size = DEFAULTS.size;
    await saveSettings(out);
    return out;
  }

  // ---- new output document, same depth and profile as the source.
  // app.documents.add() can resolve to null instead of throwing (seen on Mac
  // when the profile isn't installed), so retry without the profile, then
  // fall back to batchPlay "make" (same approach as createExportDoc).
  async function createDomeDoc(name, size, depth, profile) {
    const base = { name, width: size, height: size, resolution: 72, mode: "RGBColorMode", fill: "transparent", depth };
    const attempts = profile ? [{ ...base, profile }, base] : [base];
    for (const opts of attempts) {
      try {
        const doc = await app.documents.add(opts);
        if (doc) return doc;
        log(`sky dome: documents.add returned null (profile: ${opts.profile || "default"})`, true);
      } catch (err) {
        log(`sky dome: documents.add failed (profile: ${opts.profile || "default"}): ${describeError(err)}`, true);
      }
    }
    const countBefore = app.documents.length;
    await action.batchPlay(
      [{
        _obj: "make",
        new: {
          _obj: "document",
          name,
          mode: { _class: "RGBColorMode" },
          width: { _unit: "pixelsUnit", _value: size },
          height: { _unit: "pixelsUnit", _value: size },
          resolution: { _unit: "densityUnit", _value: 72 },
          depth,
          fill: { _enum: "fill", _value: "transparent" }
        }
      }],
      { synchronousExecution: true, dialogOptions: "dontDisplay" }
    );
    const doc = app.activeDocument;
    if (!doc || app.documents.length <= countBefore || doc.width !== size || doc.height !== size) {
      throw new Error("Photoshop couldn't create the sky dome document");
    }
    return doc;
  }

  // Reads the visible composite rows [0, rows) as linear float, 3 or 4
  // channels. 8/16-bit values are decoded from sRGB; 32-bit are taken as is.
  async function readSource(doc, src, executionContext, progress) {
    const W = src.width, rows = src.rows, depth = src.depth;
    const bandRows = Math.max(1, Math.floor(READ_BAND_BYTES / (W * 4 * 4)));
    let data = null, comps = 0, lut = null;
    if (depth === 8) {
      lut = new Float32Array(256);
      for (let i = 0; i < 256; i++) lut[i] = srgbToLinear(i / 255);
    } else if (depth === 16) {
      lut = new Float32Array(U16_ONE + 1);
      for (let i = 0; i <= U16_ONE; i++) lut[i] = srgbToLinear(i / U16_ONE);
    }
    const alphaScale = depth === 8 ? 1 / 255 : depth === 16 ? 1 / U16_ONE : 1;
    for (let top = 0; top < rows; top += bandRows) {
      if (executionContext.isCancelled) throw new Error("cancelled");
      const bottom = Math.min(rows, top + bandRows);
      const result = await imaging.getPixels({
        documentID: doc.id,
        sourceBounds: { left: 0, top, right: W, bottom },
        componentSize: depth,
        colorSpace: "RGB"
      });
      const img = result.imageData;
      const band = await img.getData();
      const c = img.components;
      if (img.width !== W || img.height !== bottom - top) {
        if (typeof img.dispose === "function") img.dispose();
        throw new Error(`getPixels returned ${img.width}x${img.height} for rows ${top}-${bottom}, expected ${W}x${bottom - top}`);
      }
      if (typeof img.dispose === "function") img.dispose();
      if (!data) {
        comps = c;
        if (comps !== 3 && comps !== 4) throw new Error(`unexpected ${comps} channels from Photoshop`);
        try {
          data = new Float32Array(W * rows * comps);
        } catch (err) {
          throw new Error(`not enough memory for a ${W}x${rows} float copy of the source (${Math.round(W * rows * comps * 4 / 1048576)} MB)`);
        }
      } else if (c !== comps) {
        throw new Error(`Photoshop returned ${c} channels for rows ${top}-${bottom}, ${comps} before`);
      }
      const off = top * W * comps, n = (bottom - top) * W * comps;
      if (!lut) {
        data.set(band.subarray ? band.subarray(0, n) : band, off);
      } else {
        for (let i = 0; i < n; i++) {
          data[off + i] = comps === 4 && i % 4 === 3 ? band[i] * alphaScale : lut[band[i]];
        }
      }
      progress(bottom / rows);
    }
    return { data, components: comps };
  }

  // min / mean / max per channel over a strided sample, for the log
  function channelStats(data, comps) {
    const n = data.length / comps, step = Math.max(1, Math.floor(n / 200000));
    const lo = [], hi = [], sum = [];
    for (let c = 0; c < comps; c++) { lo[c] = Infinity; hi[c] = -Infinity; sum[c] = 0; }
    let count = 0, bad = 0;
    for (let i = 0; i < n; i += step) {
      for (let c = 0; c < comps; c++) {
        const v = data[i * comps + c];
        if (!Number.isFinite(v)) { bad++; continue; }
        if (v < lo[c]) lo[c] = v;
        if (v > hi[c]) hi[c] = v;
        sum[c] += v;
      }
      count++;
    }
    const f = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toPrecision(3));
    return "RGBA".slice(0, comps).split("").map((ch, c) => `${ch} ${f(lo[c])}/${f(sum[c] / count)}/${f(hi[c])}`).join(", ") + (bad ? `, ${bad} non-finite` : "");
  }

  // Converts rendered linear floats to the output document's depth.
  function encodeBand(floats, depth, comps) {
    if (depth === 32) return floats;
    const max = depth === 8 ? 255 : U16_ONE;
    const out = depth === 8 ? new Uint8Array(floats.length) : new Uint16Array(floats.length);
    const t = encodeTable();
    for (let i = 0; i < floats.length; i++) {
      let v = floats[i];
      if (!(v > 0)) v = 0; // also NaN
      else if (v >= 1) v = 1;
      else if (!(comps === 4 && i % 4 === 3)) {
        const f = v * ENC_STEPS, k = Math.floor(f);
        v = t[k] + (t[k + 1] - t[k]) * (f - k);
      }
      out[i] = Math.round(v * max);
    }
    return out;
  }

  async function convertToSkyDome() {
    if (!SL) throw new Error("skylayout.js didn't load");
    if (app.documents.length === 0) throw new Error("No active document open");
    const srcDoc = app.activeDocument;
    const src = describeSource(srcDoc);
    if (src.problems.length) {
      src.problems.forEach((p) => log("sky dome check: " + p, true));
      await app.showAlert("Can't convert this document:\n\n• " + src.problems.join("\n• "));
      return;
    }
    const opts = await showSkyDomeDialog(src);
    if (!opts) {
      log("sky dome: cancelled");
      return;
    }
    const outName = src.baseName + SL.outputSuffix(opts.layout, opts.size);
    log(`sky dome: ${src.baseName} ${src.width}x${src.rows} (${src.depth}-bit, el ${src.elTop}..${src.elBottom.toFixed(1)}) -> ` +
      `${outName} (${opts.layout}, yaw ${opts.yawDeg}, ` +
      (opts.layout === "frame" ? `band ${opts.bandDeg}` : `skirt ${opts.skirtDeg}, corners ${opts.corners}`) +
      `, minSamples ${opts.minSamples})`);

    let outDoc = null;
    const t0 = Date.now();
    const times = {};
    await core.executeAsModal(async (executionContext) => {
      const report = (value, phase) => executionContext.reportProgress({ value, commandName: `Convert to Sky Dome: ${phase}` });
      try {
        // 1. read (0-10%)
        report(0, "reading source");
        let t = Date.now();
        const source = await readSource(srcDoc, src, executionContext, (f) => report(0.1 * f, "reading source"));
        times.read = Date.now() - t;

        // 2. rip-map (10-15%)
        report(0.1, "preparing");
        t = Date.now();
        const conv = SL.createConverter(source.data, src.width, src.rows, source.components, {
          layout: opts.layout, size: opts.size, elTop: src.elTop, elBottom: src.elBottom,
          yawDeg: opts.yawDeg, bandDeg: opts.bandDeg, skirtDeg: opts.skirtDeg,
          minSamples: opts.minSamples, corners: opts.corners,
          // Sky only: write RGB like the EXR export does. A composite's alpha
          // isn't needed and a 4-channel write is one more thing that can go
          // transparent; the disc's transparent corners still get alpha.
          ignoreAlpha: true
        });
        log(`sky dome: source ${src.width}x${src.rows}, ${source.components} channels read, stats ${channelStats(source.data, source.components)}; writing ${conv.outComponents} channels`);
        times.prepare = Date.now() - t;

        // 3. new document, then render band by band (15-100%)
        let profile;
        try {
          profile = srcDoc.colorProfileName;
        } catch (err) {
          profile = undefined;
        }
        outDoc = await createDomeDoc(outName, opts.size, src.depth, profile);
        const outLayer = outDoc.layers[0];
        try {
          outLayer.name = outName;
        } catch (err) {
          // cosmetic
        }
        const N = opts.size, OC = conv.outComponents;
        const floats = new Float32Array(WRITE_BAND_ROWS * N * OC);
        // The whole result is also kept (in the output's own type) so it can
        // be written in one go if Photoshop drops the earlier bands: putPixels
        // replaces the layer's whole content by default, which left only the
        // last band in Nic's first test. replace: false is the band fix.
        let full = null;
        try {
          full = src.depth === 32 ? new Float32Array(N * N * OC)
            : src.depth === 16 ? new Uint16Array(N * N * OC) : new Uint8Array(N * N * OC);
        } catch (err) {
          log(`sky dome: no memory for a full-size copy (${N}x${N}), writing bands only`, true);
        }
        const putBuffer = async (buf, top, rows, replace) => {
          const imgData = await imaging.createImageDataFromBuffer(buf, {
            width: N, height: rows, components: OC, componentSize: src.depth, colorSpace: "RGB"
          });
          try {
            await imaging.putPixels({
              documentID: outDoc.id, layerID: outLayer.id, imageData: imgData,
              targetBounds: { left: 0, top }, replace
            });
          } finally {
            if (typeof imgData.dispose === "function") imgData.dispose();
          }
        };
        t = Date.now();
        let putMs = 0;
        for (let r0 = 0; r0 < N; r0 += WRITE_BAND_ROWS) {
          if (executionContext.isCancelled) throw new Error("cancelled");
          const r1 = Math.min(N, r0 + WRITE_BAND_ROWS);
          const view = floats.subarray(0, (r1 - r0) * N * OC);
          conv.renderRows(r0, r1, view);
          if (r0 === 0 || r1 === N) log(`sky dome: rows ${r0}-${r1} rendered, stats ${channelStats(view, OC)}`);
          const tp = Date.now();
          const buf = encodeBand(view, src.depth, OC);
          if (full) full.set(buf, r0 * N * OC);
          await putBuffer(buf, r0, r1 - r0, false);
          putMs += Date.now() - tp;
          report(0.15 + 0.85 * (r1 / N), `${opts.layout} ${N}`);
        }
        // Check the bands all landed: the layer must span the full height.
        let bounds = null;
        try {
          const lb = outLayer.bounds;
          bounds = { top: Math.round(lb.top), bottom: Math.round(lb.bottom), left: Math.round(lb.left), right: Math.round(lb.right) };
        } catch (err) {
          bounds = null;
        }
        log(`sky dome: layer bounds after band writes ${bounds ? JSON.stringify(bounds) : "unknown"}`);
        if (bounds && (bounds.top > 1 || bounds.bottom < N - 1)) {
          if (!full) throw new Error(`only rows ${bounds.top}-${bounds.bottom} of ${N} were written and there's no memory to retry`);
          log("sky dome: Photoshop kept only part of the bands, writing the whole image in one go", true);
          const tp = Date.now();
          await putBuffer(full, 0, N, true);
          putMs += Date.now() - tp;
        }
        full = null;
        // read back the middle row of the result, to show in the log what landed
        try {
          const rb = await imaging.getPixels({
            documentID: outDoc.id, layerID: outLayer.id,
            sourceBounds: { left: 0, top: N >> 1, right: N, bottom: (N >> 1) + 1 }, componentSize: 32
          });
          const rd = await rb.imageData.getData();
          log(`sky dome: read back middle row: ${rb.imageData.components} channels, stats ${channelStats(rd, rb.imageData.components)}`);
          if (typeof rb.imageData.dispose === "function") rb.imageData.dispose();
        } catch (err) {
          log("sky dome: couldn't read back the result: " + describeError(err), true);
        }
        times.render = Date.now() - t - putMs;
        times.write = putMs;
      } catch (err) {
        if (outDoc) {
          try {
            await outDoc.closeWithoutSaving();
          } catch (e) {
            log(`sky dome: couldn't close the unfinished document: ${describeError(e)}`, true);
          }
          outDoc = null;
        }
        try {
          app.activeDocument = srcDoc;
        } catch (e) {
          // source may have been closed
        }
        throw err;
      }
    }, { commandName: "Convert to Sky Dome" });

    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    log(`sky dome: done in ${secs}s (read ${times.read} ms, prepare ${times.prepare} ms, render ${times.render} ms, write ${times.write} ms)`);
    showToast(`Created ${outName} (${opts.size}x${opts.size}) in ${secs}s. Source untouched.`, null);
  }

  // ---- wiring
  const btn = document.getElementById("skyDomeBtn");
  if (btn) {
    btn.addEventListener("click", () => {
      convertToSkyDome().catch((err) => {
        const msg = describeError(err);
        if (msg === "cancelled" || /cancel/i.test(msg)) {
          log("sky dome: cancelled, nothing created");
          return;
        }
        log("ERROR sky dome: " + msg, true);
        showToast("Sky dome conversion failed: " + msg, null);
      });
    });
  }
  const dlg = document.getElementById("skyDomeDialog");
  if (dlg) {
    document.getElementById("sdCancelBtn").addEventListener("click", () => dlg.close("cancel"));
    document.getElementById("sdOkBtn").addEventListener("click", () => dlg.close("convert"));
  }
  log(`sky dome ready (${SKYDOME_BUILD})`);
})();
