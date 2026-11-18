// ---------- Fix Seams (prototype) ----------
// Loaded after index.js and reuses its globals (log, describeError,
// rangeCompressValue/rangeExpandValue, equirectLatSpan, checkPixelLayer).
// Wrapped in a function so its consts don't collide with index.js's.
//
// Content-Aware Fill doesn't run on 32-bit documents, so each seam region
// is copied into a small temporary 16-bit document, range compressed (for
// 32-bit masters) and normalised into 0..1, filled there, read back,
// expanded, and written into a new layer above the selected one:
//   edge:  the wrap seam (right edge + left edge side by side), a narrow
//          vertical strip across the join is filled;
//   poles: a stereographic patch around the zenith (and the nadir on full
//          equirects), a small circle on the pole is filled, then the patch
//          is reprojected back to equirect for just that cap.
// The selected layer is never modified; undo removes the new layers in one
// step.
(function () {
  const { app, imaging, core, action, constants } = require("photoshop");

  const EDGE_FILL_FRACTION = 1 / 128; // filled strip width on each side of the seam, as a fraction of the width (64 px each side at 8k)
  const EDGE_CONTEXT_MULT = 6; // context kept on each side of the seam, in strip widths
  const POLE_FILL_DEG = 4; // angular radius filled around the pole
  const POLE_CONTEXT_DEG = 20; // angular radius of the patch handed to Content-Aware Fill
  const POLE_FEATHER = 0.15; // inner fraction of the fill radius blended back into the original
  const U16_ONE = 32768; // Photoshop's 16-bit white

  function checkBatchPlay(results, what) {
    for (const r of results || []) {
      if (r && r._obj === "error") throw new Error(`${what} failed: ${r.message || JSON.stringify(r)}`);
    }
  }

  function px(v) {
    return { _unit: "pixelsUnit", _value: v };
  }

  // Reads a region of a layer as float. The layer must cover the whole
  // region (getPixels silently returns less otherwise).
  async function readRegion(doc, layerId, left, top, right, bottom) {
    const result = await imaging.getPixels({
      documentID: doc.id,
      layerID: layerId,
      sourceBounds: { left, top, right, bottom },
      componentSize: 32
    });
    const img = result.imageData;
    const b = result.sourceBounds || { left, top, right: left + img.width, bottom: top + img.height };
    if (b.left !== left || b.top !== top || img.width !== right - left || img.height !== bottom - top) {
      if (typeof img.dispose === "function") img.dispose();
      throw new Error(`Layer doesn't cover ${left},${top} to ${right},${bottom}; it needs to fill the whole canvas`);
    }
    const data = await img.getData();
    const out = { data, width: img.width, height: img.height, components: img.components, colorSpace: img.colorSpace };
    if (typeof img.dispose === "function") img.dispose();
    return out;
  }

  // Float <-> 16-bit working values. 32-bit masters are range compressed
  // first so suns and bright sky survive 16 bits; everything is divided by
  // the region's peak so nothing clips.
  function makeCodec(hdr) {
    const toWork = hdr ? rangeCompressValue : (v) => v;
    const fromWork = hdr ? rangeExpandValue : (v) => v;
    return { toWork, fromWork, scale: 1 };
  }

  function encodeRgb(codec, rgbFloats) {
    let peak = 1;
    for (let i = 0; i < rgbFloats.length; i++) {
      const w = codec.toWork(rgbFloats[i]);
      rgbFloats[i] = w;
      if (w > peak) peak = w;
    }
    codec.scale = peak;
    const u16 = new Uint16Array(rgbFloats.length);
    const k = U16_ONE / peak;
    for (let i = 0; i < rgbFloats.length; i++) {
      u16[i] = Math.max(0, Math.min(U16_ONE, Math.round(rgbFloats[i] * k)));
    }
    return u16;
  }

  function decodeValue(codec, u) {
    return codec.fromWork((u / U16_ONE) * codec.scale);
  }

  async function createWorkDoc(width, height) {
    try {
      const doc = await app.documents.add({
        name: "Mooncloud seam fix (temp)", width, height, resolution: 72, mode: "RGBColorMode", fill: "white", depth: 16
      });
      if (doc) return doc;
      log("documents.add returned null for the 16-bit work document, retrying via batchPlay", true);
    } catch (err) {
      log("documents.add failed for the 16-bit work document: " + describeError(err), true);
    }
    const countBefore = app.documents.length;
    await action.batchPlay(
      [{
        _obj: "make",
        new: {
          _obj: "document",
          name: "Mooncloud seam fix (temp)",
          mode: { _class: "RGBColorMode" },
          width: px(width),
          height: px(height),
          resolution: { _unit: "densityUnit", _value: 72 },
          depth: 16,
          fill: { _enum: "fill", _value: "white" }
        }
      }],
      { synchronousExecution: true, dialogOptions: "dontDisplay" }
    );
    const doc = app.activeDocument;
    if (!doc || app.documents.length <= countBefore || doc.width !== width || doc.height !== height) {
      throw new Error("Photoshop couldn't create the temporary 16-bit work document");
    }
    return doc;
  }

  // Puts 16-bit RGB pixels into a temp document, content-aware fills the
  // given selection shape, and returns the filled pixels.
  async function contentAwareFill(u16, width, height, selectionShape) {
    const work = await createWorkDoc(width, height);
    try {
      const layer = work.layers[0];
      const img = await imaging.createImageDataFromBuffer(u16, {
        width, height, components: 3, componentSize: 16, colorSpace: "RGB"
      });
      await imaging.putPixels({ documentID: work.id, layerID: layer.id, imageData: img, targetBounds: { left: 0, top: 0 } });
      if (typeof img.dispose === "function") img.dispose();

      const results = await action.batchPlay(
        [
          { _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: selectionShape, antiAlias: true },
          {
            _obj: "fill",
            using: { _enum: "fillContents", _value: "contentAware" },
            contentAwareColorAdaptationFill: true,
            opacity: { _unit: "percentUnit", _value: 100 },
            mode: { _enum: "blendMode", _value: "normal" }
          },
          { _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _enum: "ordinal", _value: "none" } }
        ],
        { synchronousExecution: true, dialogOptions: "dontDisplay" }
      );
      checkBatchPlay(results, "Content-Aware Fill");

      const res = await imaging.getPixels({ documentID: work.id, layerID: layer.id, componentSize: 16 });
      const filled = await res.imageData.getData();
      const components = res.imageData.components;
      if (typeof res.imageData.dispose === "function") res.imageData.dispose();
      return { data: filled, components };
    } finally {
      await work.closeWithoutSaving();
    }
  }

  function toRgb(region) {
    const n = region.width * region.height;
    const rgb = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      rgb[i * 3] = region.data[i * region.components];
      rgb[i * 3 + 1] = region.data[i * region.components + 1];
      rgb[i * 3 + 2] = region.data[i * region.components + 2];
    }
    return rgb;
  }

  // ---- edge (wrap) seam ----
  // Returns pieces to write: [{ left, top, width, height, rgba }]
  async function fixEdge(doc, layerId, codec) {
    const W = doc.width, H = doc.height;
    const fillHalf = Math.max(4, Math.round(W * EDGE_FILL_FRACTION));
    const ctx = Math.min(Math.floor(W / 2), Math.max(64, fillHalf * EDGE_CONTEXT_MULT));
    log(`edge seam: filling ${fillHalf * 2}px across the wrap, ${ctx}px context each side`);

    // work image = [right edge | left edge], the seam sits at x = ctx
    const right = await readRegion(doc, layerId, W - ctx, 0, W, H);
    const left = await readRegion(doc, layerId, 0, 0, ctx, H);
    const workW = ctx * 2;
    const rgb = new Float32Array(workW * H * 3);
    const r = toRgb(right), l = toRgb(left);
    for (let y = 0; y < H; y++) {
      rgb.set(r.subarray(y * ctx * 3, (y + 1) * ctx * 3), (y * workW) * 3);
      rgb.set(l.subarray(y * ctx * 3, (y + 1) * ctx * 3), (y * workW + ctx) * 3);
    }
    const u16 = encodeRgb(codec, rgb);
    const filled = await contentAwareFill(u16, workW, H, {
      _obj: "rectangle", top: px(0), left: px(ctx - fillHalf), bottom: px(H), right: px(ctx + fillHalf)
    });

    // strip columns ctx-fillHalf..ctx-1 land at the right edge, ctx..ctx+fillHalf-1 at the left
    const pieces = [];
    for (const [srcX0, dstX0] of [[ctx - fillHalf, W - fillHalf], [ctx, 0]]) {
      const rgba = new Float32Array(fillHalf * H * 4);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < fillHalf; x++) {
          const si = (y * workW + srcX0 + x) * filled.components;
          const di = (y * fillHalf + x) * 4;
          for (let c = 0; c < 3; c++) rgba[di + c] = decodeValue(codec, filled.data[si + c]);
          rgba[di + 3] = 1;
        }
      }
      pieces.push({ left: dstX0, top: 0, width: fillHalf, height: H, rgba });
    }
    return pieces;
  }

  // ---- zenith / nadir ----
  function sampleBilinear(data, comps, w, h, fx, fy, wrapX, c) {
    let x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    let x1 = x0 + 1, y1 = y0 + 1;
    if (wrapX) {
      x0 = ((x0 % w) + w) % w;
      x1 = ((x1 % w) + w) % w;
    } else {
      x0 = Math.max(0, Math.min(w - 1, x0));
      x1 = Math.max(0, Math.min(w - 1, x1));
    }
    y0 = Math.max(0, Math.min(h - 1, y0));
    y1 = Math.max(0, Math.min(h - 1, y1));
    const a = data[(y0 * w + x0) * comps + c], b = data[(y0 * w + x1) * comps + c];
    const d = data[(y1 * w + x0) * comps + c], e = data[(y1 * w + x1) * comps + c];
    const top = a + (b - a) * tx, bot = d + (e - d) * tx;
    return top + (bot - top) * ty;
  }

  async function fixPole(doc, layerId, codec, mode) {
    const W = doc.width, H = doc.height;
    const latSpan = equirectLatSpan(W, H);
    const pxPerRad = H / latSpan;
    const deg = Math.PI / 180;
    const thetaFill = POLE_FILL_DEG * deg;
    const rMax = Math.tan((POLE_CONTEXT_DEG * deg) / 2);
    const rFill = Math.tan(thetaFill / 2);
    // stereographic r = tan(theta/2) has dr/dtheta = 1/2 at the pole, so
    // 2 * pxPerRad patch pixels per unit r keeps the source's resolution there
    const scaleR = 2 * pxPerRad;
    const half = Math.ceil(rMax * scaleR);
    const P = half * 2;
    const thetaCorner = 2 * Math.atan(rMax * Math.SQRT2);
    const rows = Math.min(H, Math.ceil(thetaCorner * pxPerRad) + 2);
    const rowTop = mode === "zenith" ? 0 : H - rows;
    log(`${mode}: ${P}x${P} patch (${POLE_CONTEXT_DEG}deg), filling ${POLE_FILL_DEG}deg around the pole`);

    const src = await readRegion(doc, layerId, 0, rowTop, W, rowTop + rows);
    // equirect row center y+0.5 <-> theta from this pole
    const thetaToFy = mode === "zenith"
      ? (theta) => theta * pxPerRad - 0.5 - rowTop
      : (theta) => H - theta * pxPerRad - 0.5 - rowTop;

    const rgb = new Float32Array(P * P * 3);
    for (let py = 0; py < P; py++) {
      const v = (py + 0.5 - half) / scaleR;
      for (let pxi = 0; pxi < P; pxi++) {
        const u = (pxi + 0.5 - half) / scaleR;
        const theta = 2 * Math.atan(Math.sqrt(u * u + v * v));
        const lon = Math.atan2(v, u);
        const fx = ((lon + Math.PI) / (2 * Math.PI)) * W - 0.5;
        const fy = thetaToFy(theta);
        const o = (py * P + pxi) * 3;
        for (let c = 0; c < 3; c++) rgb[o + c] = sampleBilinear(src.data, src.components, W, rows, fx, fy, true, c);
      }
    }
    const u16 = encodeRgb(codec, rgb);
    const radius = rFill * scaleR;
    const filled = await contentAwareFill(u16, P, P, {
      _obj: "ellipse", top: px(half - radius), left: px(half - radius), bottom: px(half + radius), right: px(half + radius)
    });

    // reproject the filled cap back to equirect rows
    const capRows = Math.min(H, Math.ceil(thetaFill * pxPerRad) + 1);
    const top = mode === "zenith" ? 0 : H - capRows;
    const rgba = new Float32Array(W * capRows * 4);
    const featherStart = thetaFill * (1 - POLE_FEATHER);
    for (let y = 0; y < capRows; y++) {
      const gy = top + y + 0.5;
      const theta = mode === "zenith" ? gy / pxPerRad : (H - gy) / pxPerRad;
      if (theta > thetaFill) continue;
      const alpha = theta <= featherStart ? 1 : (thetaFill - theta) / (thetaFill - featherStart);
      const r = Math.tan(theta / 2);
      for (let x = 0; x < W; x++) {
        const lon = ((x + 0.5) / W) * 2 * Math.PI - Math.PI;
        const fx = r * Math.cos(lon) * scaleR + half - 0.5;
        const fy = r * Math.sin(lon) * scaleR + half - 0.5;
        const o = (y * W + x) * 4;
        for (let c = 0; c < 3; c++) {
          rgba[o + c] = decodeValue(codec, sampleBilinear(filled.data, filled.components, P, P, fx, fy, false, c));
        }
        rgba[o + 3] = alpha;
      }
    }
    return [{ left: 0, top, width: W, height: capRows, rgba }];
  }

  // Each piece goes into its own layer and they're merged into one: a
  // second putPixels into the same layer doesn't reliably keep the first
  // piece, and one canvas-wide buffer would be huge for the edge strips.
  async function writeLayer(doc, anchorLayer, name, pieces, colorSpace) {
    let layer = null;
    for (const p of pieces) {
      const pieceLayer = await doc.createLayer();
      pieceLayer.name = name;
      try {
        pieceLayer.move(layer || anchorLayer, constants.ElementPlacement.PLACEBEFORE);
      } catch (err) {
        log(`couldn't move "${name}" above its source: ` + describeError(err), true);
      }
      const img = await imaging.createImageDataFromBuffer(p.rgba, {
        width: p.width, height: p.height, components: 4, componentSize: 32, colorSpace
      });
      await imaging.putPixels({ documentID: doc.id, layerID: pieceLayer.id, imageData: img, targetBounds: { left: p.left, top: p.top } });
      if (typeof img.dispose === "function") img.dispose();
      if (layer) {
        layer = await pieceLayer.merge();
        layer.name = name;
      } else {
        layer = pieceLayer;
      }
    }
    return layer;
  }

  async function fixSeams() {
    if (app.documents.length === 0) throw new Error("No active document open");

    await core.executeAsModal(async (executionContext) => {
      const doc = app.activeDocument;
      const srcLayer = (doc.activeLayers && doc.activeLayers.length ? doc.activeLayers[0] : doc.activeLayer);
      if (!srcLayer) throw new Error("No active layer selected");
      checkPixelLayer(srcLayer, "Selected");
      const hdr = doc.bitsPerChannel === "bitDepth32";
      const W = doc.width, H = doc.height;
      const fullSphere = equirectLatSpan(W, H) >= Math.PI * 0.99;
      log(`fix seams on "${srcLayer.name}" (${W}x${H}, ${hdr ? "32-bit, range compressed" : "8/16-bit"}, ${fullSphere ? "full" : "half"} equirect)`);
      const colorSpace = "RGB";

      const results = [];
      results.push(["Seam Fix Edge", await fixEdge(doc, srcLayer.id, makeCodec(hdr))]);
      results.push(["Seam Fix Zenith", await fixPole(doc, srcLayer.id, makeCodec(hdr), "zenith")]);
      if (fullSphere) results.push(["Seam Fix Nadir", await fixPole(doc, srcLayer.id, makeCodec(hdr), "nadir")]);

      app.activeDocument = doc;
      const suspensionID = await executionContext.hostControl.suspendHistory({ documentID: doc.id, name: "Fix Seams" });
      try {
        // written bottom-up so the list reads Edge, Zenith, Nadir from the top
        for (let i = results.length - 1; i >= 0; i--) {
          await writeLayer(doc, srcLayer, results[i][0], results[i][1], colorSpace);
        }
      } finally {
        await executionContext.hostControl.resumeHistory(suspensionID);
      }
      log(`fix seams complete: ${results.map((r) => r[0]).join(", ")}`);
    }, { commandName: "Fix Seams" });
  }

  let busy = false;
  const btn = document.getElementById("fixSeamsBtn");
  if (btn) {
    btn.addEventListener("click", () => {
      if (busy) return;
      busy = true;
      fixSeams()
        .catch((err) => log("ERROR fix seams: " + describeError(err), true))
        .finally(() => { busy = false; });
    });
  }
})();
