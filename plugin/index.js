const { app, imaging, core, action } = require("photoshop");
const { entrypoints, storage, shell } = require("uxp");

// Preview resolutions picked in the viewer; "full" is the document's own
// width (capped to the viewer's max texture size). Height is always width/2.
const PREVIEW_WIDTHS = { "2k": 2048, "4k": 4096, "8k": 8192 };
const DEFAULT_PREVIEW = { resolution: "2k", color: "srgb", exposure: 0 };
const PANEL_ID = "equirectPanel"; // must match manifest.json entrypoints[0].id
const MC_KEY_FILENAME = "mooncloud.json";
const BUILD = "2026-10-23 preview-8k"; // logged at startup, to confirm which copy is loaded

// ---------- Mooncloud API key storage ----------
// The webview's localStorage throws "Storage is not supported" (UXP
// sandboxes it away), so the key is persisted here in the plugin's data
// folder instead, relayed to/from the webview by message.
const fs = storage.localFileSystem;

async function saveMcKey(apiKey) {
  const folder = await fs.getDataFolder();
  const file = await folder.createFile(MC_KEY_FILENAME, { overwrite: true });
  await file.write(JSON.stringify({ apiKey }));
}

async function loadMcKey() {
  try {
    const folder = await fs.getDataFolder();
    const entry = await folder.getEntry(MC_KEY_FILENAME);
    const text = await entry.read();
    return JSON.parse(text).apiKey || null;
  } catch (err) {
    return null;
  }
}

async function clearMcKey() {
  try {
    const folder = await fs.getDataFolder();
    const entry = await folder.getEntry(MC_KEY_FILENAME);
    await entry.delete();
  } catch (err) {
    // nothing to clear
  }
}

// ---------- log panel ----------
const logLines = [];

function log(msg, isError) {
  console[isError ? "error" : "log"]("[equirect]", msg);
  logLines.push({ msg: String(msg), isError: !!isError, time: new Date().toLocaleTimeString() });
  if (logLines.length > 300) logLines.shift();
  renderLog();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// Some UXP/batchPlay failures reject with objects that don't have a normal
// .message (logging err.message alone then just prints "undefined").
function describeError(err) {
  if (err === undefined || err === null) return String(err);
  if (err instanceof Error && err.message) return err.message;
  try {
    return JSON.stringify(err);
  } catch (e) {
    return String(err);
  }
}

function renderLog() {
  const el = document.getElementById("logPanel");
  if (!el) return;
  el.innerHTML = logLines
    .map((l) => `<div class="line${l.isError ? " error" : ""}">${l.time}  ${escapeHtml(l.msg)}</div>`)
    .join("");
  el.scrollTop = el.scrollHeight;
}

// ---------- Photoshop pixel pipeline ----------
// The preview is read as 32-bit float so the viewer can apply exposure and
// the sRGB/raw display transform itself without refetching. It's sent as
// RGBE (Radiance shared exponent, 4 bytes per pixel): full HDR range at
// about the size of the old 8-bit preview.
let previewSettings = { ...DEFAULT_PREVIEW };
let viewerMaxTextureSize = 8192; // reported by the viewer (WebGL limit)

function previewTargetWidth(doc, resolution) {
  const docW = Math.round(doc.width);
  const want = PREVIEW_WIDTHS[resolution || previewSettings.resolution] || docW;
  return Math.max(2, Math.min(want, docW, viewerMaxTextureSize));
}

const rgbeF32 = new Float32Array(1);
const rgbeU32 = new Uint32Array(rgbeF32.buffer);
const RGBE_SCALE = new Float64Array(256); // [ex + 128] -> 2^(8 - ex)
for (let i = 0; i < 256; i++) RGBE_SCALE[i] = Math.pow(2, 8 - (i - 128));

function encodeRgbe(src, components, pixelCount) {
  const out = new Uint8Array(pixelCount * 4);
  for (let p = 0, i = 0, o = 0; p < pixelCount; p++, i += components, o += 4) {
    let r = src[i], g = src[i + 1], b = src[i + 2];
    if (!(r > 0)) r = 0; // negatives and NaN
    if (!(g > 0)) g = 0;
    if (!(b > 0)) b = 0;
    let max = r > g ? r : g;
    if (b > max) max = b;
    if (max < 1e-32) continue; // black (out is zeroed)
    rgbeF32[0] = max;
    let ex = ((rgbeU32[0] >>> 23) & 255) - 126; // frexp: max = m * 2^ex, m in [0.5, 1)
    if (ex > 127) ex = 127; // inf / beyond RGBE range: channels clamp to 255
    const s = RGBE_SCALE[ex + 128];
    out[o] = Math.min(255, r * s);
    out[o + 1] = Math.min(255, g * s);
    out[o + 2] = Math.min(255, b * s);
    out[o + 3] = ex + 128;
  }
  return out;
}

// Large previews (4k, full) are far too big for one webview message, so the
// pixels go over in bands of about this many RGBE bytes: equirect-begin,
// equirect-chunk x N, equirect-end. Full size is also read from Photoshop
// band by band, so a 32-bit 8k master never sits in memory as one float array.
const PREVIEW_CHUNK_BYTES = 8 * 1024 * 1024;

function readCompositeFloats(doc, options) {
  return imaging.getPixels({ documentID: doc.id, colorSpace: "RGB", componentSize: 32, applyAlpha: true, ...options })
    .then(async (result) => {
      const img = result.imageData;
      const floats = await img.getData();
      const out = { floats, width: img.width, height: img.height, components: img.components };
      if (typeof img.dispose === "function") img.dispose();
      return out;
    });
}

// per-refresh stage timings, logged after each refresh
let previewTimes = null;

function sendPreviewChunk(rgbe, offset) {
  let t = Date.now();
  const base64 = uint8ToBase64(rgbe);
  previewTimes.base64 += Date.now() - t;
  t = Date.now();
  sendToWebview({ type: "equirect-chunk", offset, base64 });
  previewTimes.send += Date.now() - t;
}

function timedRead(doc, options) {
  const t = Date.now();
  return readCompositeFloats(doc, options).then((r) => {
    previewTimes.read += Date.now() - t;
    return r;
  });
}

function timedEncode(img) {
  const t = Date.now();
  const rgbe = encodeRgbe(img.floats, img.components, img.width * img.height);
  previewTimes.encode += Date.now() - t;
  return rgbe;
}

// Reads a band, retrying on its own if Photoshop refuses a read issued
// while the previous one was still in flight (see the prefetch below).
let prefetchBands = true;

function readBand(doc, top, bottom, width) {
  return timedRead(doc, { sourceBounds: { left: 0, top, right: width, bottom } }).then(
    (band) => band,
    (err) => {
      if (!prefetchBands) throw err;
      prefetchBands = false;
      log(`overlapped band reads failed (${describeError(err)}), reading one at a time`, true);
      return timedRead(doc, { sourceBounds: { left: 0, top, right: width, bottom } });
    }
  );
}

async function streamEquirectPreview(resolution) {
  if (app.documents.length === 0) {
    throw new Error("No active document open");
  }

  // imaging.getPixels (and other document-reading APIs) must run inside a
  // modal scope: https://www.adobe.com/go/ps_executeasmodal
  return core.executeAsModal(async () => {
    const doc = app.activeDocument;
    const docW = Math.round(doc.width), docH = Math.round(doc.height);
    const { constants } = require("photoshop");
    const linear = doc.bitsPerChannel === constants.BitsPerChannelType.THIRTYTWO;
    const targetWidth = previewTargetWidth(doc, resolution);
    const start = Date.now();
    previewTimes = { read: 0, wait: 0, encode: 0, base64: 0, send: 0 };
    let width, height, chunks = 0;

    if (targetWidth === docW) {
      // full size: the document's own pixels, no resample. A taller than
      // 2:1 document shows its top 2:1, as the EXR export crops it.
      width = docW;
      height = Math.min(docH, Math.round(docW / 2));
      const bandRows = Math.max(1, Math.floor(PREVIEW_CHUNK_BYTES / (width * 4)));
      sendToWebview({ type: "equirect-begin", width, height, docWidth: docW, docHeight: docH, linear });
      // Photoshop reads the next band while this one is encoded and sent
      let next = readBand(doc, 0, Math.min(height, bandRows), width);
      for (let top = 0; top < height; top += bandRows) {
        const bottom = Math.min(height, top + bandRows);
        let band;
        if (prefetchBands) {
          const t = Date.now();
          band = await next;
          previewTimes.wait += Date.now() - t;
          const nextTop = top + bandRows;
          next = nextTop < height ? readBand(doc, nextTop, Math.min(height, nextTop + bandRows), width) : null;
        } else {
          band = next ? await next : await readBand(doc, top, bottom, width);
          next = null;
        }
        if (band.width !== width || band.height !== bottom - top) {
          throw new Error(`Photoshop returned ${band.width}x${band.height} for rows ${top}-${bottom} of a ${width} wide preview`);
        }
        sendPreviewChunk(timedEncode(band), top * width * 4);
        chunks++;
      }
    } else {
      const img = await timedRead(doc, { targetSize: { width: targetWidth, height: Math.round(targetWidth / 2) } });
      width = img.width;
      height = img.height;
      if (width !== targetWidth) log(`asked Photoshop for ${targetWidth} wide, got ${width}x${height}`, true);
      const rgbe = timedEncode(img);
      sendToWebview({ type: "equirect-begin", width, height, docWidth: docW, docHeight: docH, linear });
      const step = Math.max(1, Math.floor(PREVIEW_CHUNK_BYTES / (width * 4))) * width * 4;
      for (let offset = 0; offset < rgbe.length; offset += step) {
        sendPreviewChunk(rgbe.subarray(offset, offset + step), offset);
        chunks++;
      }
    }
    sendToWebview({ type: "equirect-end", chunks });

    return {
      docTitle: doc.title,
      docSize: `${docW}x${docH}`,
      width,
      height,
      chunks,
      ms: Date.now() - start,
      megabytes: (width * height * 4) / 1024 / 1024
    };
  }, { commandName: "Get equirect preview pixels" });
}

// ---------- range compress/expand (ported from OpenImageIO ImageBufAlgo) ----------
// https://github.com/AcademySoftwareFoundation/OpenImageIO/blob/1d9d0cad60a9f0dd184249ea29a86c4eae40a1f2/src/libOpenImageIO/imagebufalgo_pixelmath.cpp#L561
const RANGE_X1 = 0.18;
const RANGE_A = -0.54576885700225830078;
const RANGE_B = 0.18351669609546661377;
const RANGE_C = 284.3577880859375;

function rangeCompressValue(x) {
  const absx = Math.abs(x);
  if (absx <= RANGE_X1) return x;
  return Math.sign(x) * (RANGE_A + RANGE_B * Math.log(Math.abs(RANGE_C * absx + 1.0)));
}

function rangeExpandValue(y) {
  const absy = Math.abs(y);
  if (absy <= RANGE_X1) return y;
  const xi = Math.exp((absy - RANGE_A) / RANGE_B);
  let xr = (xi - 1.0) / RANGE_C;
  if (xr < RANGE_X1) xr = (-xi - 1.0) / RANGE_C;
  return Math.sign(y) * xr;
}

async function applyRangeTransform(mode) {
  if (app.documents.length === 0) {
    throw new Error("No active document open");
  }
  const transform = mode === "compress" ? rangeCompressValue : rangeExpandValue;
  const label = mode === "compress" ? "Range Compressed" : "Range Expanded";

  await core.executeAsModal(async () => {
    const doc = app.activeDocument;
    const srcLayer = (doc.activeLayers && doc.activeLayers.length ? doc.activeLayers[0] : doc.activeLayer);
    if (!srcLayer) throw new Error("No active layer selected");
    log(`reading "${srcLayer.name}" as 32-bit float`);

    const result = await imaging.getPixels({
      documentID: doc.id,
      layerID: srcLayer.id,
      componentSize: 32
    });
    const imgData = result.imageData;
    const data = await imgData.getData();
    const { width, height, components, colorSpace } = imgData;
    log(`got ${width}x${height}, ${components} components, colorSpace=${colorSpace}, ${data.length} floats`);

    const out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i += components) {
      out[i] = transform(data[i]);
      out[i + 1] = transform(data[i + 1]);
      out[i + 2] = transform(data[i + 2]);
      if (components > 3) out[i + 3] = data[i + 3]; // alpha untouched
    }
    if (typeof imgData.dispose === "function") imgData.dispose();

    log("duplicating source layer for the result");
    const newLayer = await srcLayer.duplicate();
    newLayer.name = label;

    log("writing transformed pixels via putPixels");
    const newImageData = await imaging.createImageDataFromBuffer(out, {
      width, height, components, componentSize: 32, colorSpace
    });
    await imaging.putPixels({
      documentID: doc.id,
      layerID: newLayer.id,
      imageData: newImageData
    });
    if (typeof newImageData.dispose === "function") newImageData.dispose();

    log(`${mode} complete, new layer "${newLayer.name}" created`);
  }, { commandName: label });
}

// ---------- zenith/nadir stereographic get/put (Flexify-style) ----------
// Get: reprojects a hemisphere-plus centered on the north (zenith) or south
// (nadir) pole of an equirectangular layer into a flat square patch via a
// stereographic (conformal) azimuthal projection, added as a new layer
// directly above the source. Output resolution matches the source's
// angular resolution (width/2, the height of a 2:1), so no detail is
// lost/gained versus the source. Half equirects (4:1, upper hemisphere
// only) work for zenith; see equirectLatSpan. Float32 throughout — no 8-bit
// clamping — so this stays correct on 32-bit/HDR documents too.
// Center of the square = pole; edges = horizon (90deg from pole); corners
// reach a bit past the horizon (~109.5deg) so the square has no dead area.
//
// Put: the exact algebraic inverse — reprojects the selected patch-space
// layer back to equirect (forward stereographic instead of inverse) into a
// new layer above it; transparent areas of the layer stay transparent.

// Latitude span covered by an equirect layer, top-anchored at the zenith,
// mapped as y = (PI/2 - lat) / latSpan * height. With the viewer's Half
// toggle on, the image is the upper hemisphere only (PI/2) whatever its
// aspect, e.g. a 2:1 sky stretched to the horizon. Otherwise it's derived
// from the aspect: 2:1 is the full sphere (PI), 4:1 the upper hemisphere.
let halfEquirect = false;

function equirectLatSpan(width, height) {
  if (halfEquirect) return Math.PI / 2;
  return Math.min(Math.PI, Math.PI * (2 * height) / width);
}

// Reads an equirect layer clipped to the canvas. getPixels on a layer only
// returns the layer's own bounds, so a layer that hangs off the canvas (or
// doesn't reach its edges) would otherwise be mapped with the wrong
// geometry. The equirect geometry always comes from the canvas.
async function getCanvasLayerPixels(doc, layerId) {
  const W = doc.width, H = doc.height;
  const result = await imaging.getPixels({
    documentID: doc.id,
    layerID: layerId,
    sourceBounds: { left: 0, top: 0, right: W, bottom: H },
    componentSize: 32
  });
  const imgData = result.imageData;
  const b = result.sourceBounds || { left: 0, top: 0, right: imgData.width, bottom: imgData.height };
  if (b.left !== 0 || b.top !== 0 || imgData.width !== W || imgData.height !== H) {
    if (typeof imgData.dispose === "function") imgData.dispose();
    throw new Error(`Layer only covers ${b.left},${b.top} to ${b.right},${b.bottom} of the ${W}x${H} canvas; it needs to fill the whole canvas`);
  }
  const data = await imgData.getData();
  const info = { width: W, height: H, components: imgData.components, colorSpace: imgData.colorSpace };
  if (typeof imgData.dispose === "function") imgData.dispose();
  return { data, ...info };
}

function findLayerById(layers, id) {
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    if (l.id === id) return l;
    if (l.layers && l.layers.length) {
      const found = findLayerById(l.layers, id);
      if (found) return found;
    }
  }
  return null;
}

function checkPixelLayer(layer, role) {
  // layer.kind reads as the string "pixel" for normal pixel layers
  // (constants.LayerKind.NORMAL), there is no LayerKind.PIXEL
  if (layer && String(layer.kind) !== "pixel") {
    throw new Error(`${role} layer "${layer.name}" is a ${layer.kind} layer, not a plain pixel layer (rasterize it first)`);
  }
}

function checkPoleCoverage(mode, width, height) {
  if (mode === "nadir" && equirectLatSpan(width, height) < Math.PI * 0.99) {
    throw new Error(`Layer is ${width}x${height}, a half equirect with no nadir (Get/Put Nadir need a full 2:1 equirect)`);
  }
}

// A half equirect's patch (width/2 square) is taller than its own canvas
// (width/4), so Get puts it in a separate patch document instead of a
// layer, and remembers which layer it came from so Put can write it back.
// Keyed by patch document id.
const patchDocLinks = new Map();

async function extractPole(mode) {
  if (app.documents.length === 0) {
    throw new Error("No active document open");
  }

  await core.executeAsModal(async () => {
    const doc = app.activeDocument;
    const srcLayer = (doc.activeLayers && doc.activeLayers.length ? doc.activeLayers[0] : doc.activeLayer);
    if (!srcLayer) throw new Error("No active layer selected");
    log(`reading "${srcLayer.name}" for ${mode} extraction`);

    const src = await getCanvasLayerPixels(doc, srcLayer.id);
    const srcData = src.data;
    const srcW = src.width, srcH = src.height, srcComponents = src.components;
    const srcColorSpace = src.colorSpace;
    checkPoleCoverage(mode, srcW, srcH);
    const latSpan = equirectLatSpan(srcW, srcH);
    const outSize = Math.round(srcW / 2); // 180deg across the patch at the source's angular resolution (= srcH for 2:1)
    log(`source ${srcW}x${srcH}, ${srcComponents} components, colorSpace=${srcColorSpace} -> output ${outSize}x${outSize}`);

    const outComponents = 4; // always RGBA
    const out = new Float32Array(outSize * outSize * outComponents);
    const half = outSize / 2;
    const twoPi = Math.PI * 2;

    for (let py = 0; py < outSize; py++) {
      const ny = (py - half) / half;
      for (let px = 0; px < outSize; px++) {
        const nx = (px - half) / half;
        const r = Math.sqrt(nx * nx + ny * ny);
        const theta = 2 * Math.atan(r); // angular distance from the pole
        const az = Math.atan2(ny, nx);
        const lat = mode === "zenith" ? (Math.PI / 2 - theta) : (-(Math.PI / 2) + theta);
        const lon = az;

        let fx = ((lon + Math.PI) / twoPi) * srcW;
        const fy = ((Math.PI / 2 - lat) / latSpan) * srcH;
        if (fy > srcH) continue; // below what a half equirect covers: leave transparent

        let x0 = Math.floor(fx);
        const tx = fx - x0;
        let x1 = x0 + 1;
        x0 = ((x0 % srcW) + srcW) % srcW;
        x1 = ((x1 % srcW) + srcW) % srcW;
        let y0 = Math.floor(fy);
        const ty = fy - y0;
        let y1 = y0 + 1;
        y0 = Math.max(0, Math.min(srcH - 1, y0));
        y1 = Math.max(0, Math.min(srcH - 1, y1));

        const idx00 = (y0 * srcW + x0) * srcComponents;
        const idx10 = (y0 * srcW + x1) * srcComponents;
        const idx01 = (y1 * srcW + x0) * srcComponents;
        const idx11 = (y1 * srcW + x1) * srcComponents;
        const outIdx = (py * outSize + px) * outComponents;

        for (let c = 0; c < 3; c++) {
          const top = srcData[idx00 + c] + (srcData[idx10 + c] - srcData[idx00 + c]) * tx;
          const bot = srcData[idx01 + c] + (srcData[idx11 + c] - srcData[idx01 + c]) * tx;
          out[outIdx + c] = top + (bot - top) * ty; // no clamp/scale — preserve HDR precision
        }
        if (srcComponents > 3) {
          const top = srcData[idx00 + 3] + (srcData[idx10 + 3] - srcData[idx00 + 3]) * tx;
          const bot = srcData[idx01 + 3] + (srcData[idx11 + 3] - srcData[idx01 + 3]) * tx;
          out[outIdx + 3] = top + (bot - top) * ty;
        } else {
          out[outIdx + 3] = 1.0;
        }
      }
    }
    log("reprojection computed");

    const layerName = mode === "zenith" ? "Zenith" : "Nadir";
    let targetDoc = doc;
    let newLayer;
    if (outSize > doc.height) {
      log(`patch ${outSize}px is taller than the ${doc.height}px canvas (half equirect), creating a patch document`);
      const depthByBits = { bitDepth8: 8, bitDepth16: 16, bitDepth32: 32 };
      targetDoc = await app.documents.add({
        name: `${doc.title.replace(/\.[^.]+$/, "")} ${layerName} patch`,
        width: outSize,
        height: outSize,
        resolution: doc.resolution,
        mode: "RGBColorMode",
        fill: "transparent",
        depth: depthByBits[doc.bitsPerChannel] || 32
      });
      newLayer = targetDoc.layers[0];
      patchDocLinks.set(targetDoc.id, { docId: doc.id, layerId: srcLayer.id, layerName: srcLayer.name, mode });
    } else {
      log("creating new layer in the active document");
      newLayer = await doc.createLayer();
    }
    newLayer.name = layerName;
    log(`new layer created: name="${newLayer.name}" id=${newLayer.id}`);

    const newImageData = await imaging.createImageDataFromBuffer(out, {
      width: outSize, height: outSize, components: outComponents, componentSize: 32, colorSpace: srcColorSpace
    });
    await imaging.putPixels({
      documentID: targetDoc.id,
      layerID: newLayer.id,
      imageData: newImageData,
      targetBounds: { left: 0, top: 0, right: outSize, bottom: outSize }
    });
    if (typeof newImageData.dispose === "function") newImageData.dispose();

    log(targetDoc === doc
      ? `${mode} extraction complete, new layer "${newLayer.name}" added to document`
      : `${mode} extraction complete in patch document "${targetDoc.title}"; edit it there, then Put ${layerName} with it active`);
  }, { commandName: mode === "zenith" ? "Get Zenith" : "Get Nadir" });
}

// Put reprojects the currently selected layer, read as patch-space
// content (the Zenith layer itself, or anything painted on its own layer
// over it), back to equirect into a NEW layer; its alpha decides what's
// covered, so a paint-only layer yields just those strokes. The selected
// layer is hidden afterwards and the source equirect is never modified. In
// a document the new layer goes directly above the selected one; from a
// half-equirect patch document it goes above the layer Get read from.
async function putPole(mode) {
  if (app.documents.length === 0) {
    throw new Error("No active document open");
  }

  await core.executeAsModal(async () => {
    const { constants } = require("photoshop");
    const activeDoc = app.activeDocument;
    const link = patchDocLinks.get(activeDoc.id);
    const selected = (activeDoc.activeLayers && activeDoc.activeLayers.length ? activeDoc.activeLayers[0] : activeDoc.activeLayer);
    if (!selected) throw new Error("No layer selected (select the layer to put back)");
    checkPixelLayer(selected, "Selected");
    const patchGetArgs = { documentID: activeDoc.id, layerID: selected.id, componentSize: 32 };
    let doc, anchorLayer;
    if (link) {
      if (link.mode !== mode) throw new Error(`This patch document holds a ${link.mode}, not a ${mode}`);
      doc = null;
      for (let i = 0; i < app.documents.length; i++) {
        if (app.documents[i].id === link.docId) { doc = app.documents[i]; break; }
      }
      if (!doc) throw new Error("The document this patch came from is no longer open");
      anchorLayer = findLayerById(doc.layers, link.layerId);
      log(`putting "${selected.name}" from "${activeDoc.title}" back into "${doc.title}"`);
    } else {
      doc = activeDoc;
      anchorLayer = selected;
      log(`putting "${selected.name}"`);
    }

    const tgtW = doc.width, tgtH = doc.height;
    checkPoleCoverage(mode, tgtW, tgtH);
    const tgtLatSpan = equirectLatSpan(tgtW, tgtH);

    // The patch is a square of patchSize anchored at the canvas origin, as
    // Get created it. getPixels only returns the layer's painted bounds
    // (which shrink with transparent edges, or grow if painted past the
    // square), so patch pixels are indexed relative to those bounds.
    const patchSize = link ? activeDoc.width : Math.round(tgtW / 2);
    const patchResult = await imaging.getPixels(patchGetArgs);
    const patchImgData = patchResult.imageData;
    const patchData = await patchImgData.getData();
    const patchW = patchImgData.width, patchH = patchImgData.height, patchComponents = patchImgData.components;
    const patchColorSpace = patchImgData.colorSpace;
    const pb = patchResult.sourceBounds || { left: 0, top: 0 };
    log(`patch ${patchW}x${patchH} at ${pb.left},${pb.top} (expected ${patchSize}x${patchSize} at 0,0), ${patchComponents} components`);
    if (typeof patchImgData.dispose === "function") patchImgData.dispose();

    const outComponents = 4;
    const out = new Float32Array(tgtW * tgtH * outComponents); // transparent except where the layer has pixels

    const half = patchSize / 2;
    const twoPi = Math.PI * 2;

    for (let ty = 0; ty < tgtH; ty++) {
      const lat = Math.PI / 2 - (ty / tgtH) * tgtLatSpan;
      for (let tx = 0; tx < tgtW; tx++) {
        const lon = (tx / tgtW) * twoPi - Math.PI;

        const theta = mode === "zenith" ? (Math.PI / 2 - lat) : (lat + Math.PI / 2);
        const r = Math.tan(theta / 2);
        const az = lon;
        const nx = r * Math.cos(az);
        const ny = r * Math.sin(az);

        const fx = nx * half + half - pb.left;
        const fy = ny * half + half - pb.top;
        if (fx < 0 || fx >= patchW - 1 || fy < 0 || fy >= patchH - 1) continue; // outside patch coverage

        const x0 = Math.floor(fx), x1 = x0 + 1;
        const bx = fx - x0;
        const y0 = Math.floor(fy), y1 = y0 + 1;
        const by = fy - y0;

        const idx00 = (y0 * patchW + x0) * patchComponents;
        const idx10 = (y0 * patchW + x1) * patchComponents;
        const idx01 = (y1 * patchW + x0) * patchComponents;
        const idx11 = (y1 * patchW + x1) * patchComponents;

        let patchAlpha = 1.0;
        if (patchComponents > 3) {
          const top = patchData[idx00 + 3] + (patchData[idx10 + 3] - patchData[idx00 + 3]) * bx;
          const bot = patchData[idx01 + 3] + (patchData[idx11 + 3] - patchData[idx01 + 3]) * bx;
          patchAlpha = top + (bot - top) * by;
        }
        if (patchAlpha <= 0) continue;

        const outIdx = (ty * tgtW + tx) * outComponents;
        for (let c = 0; c < 3; c++) {
          const top = patchData[idx00 + c] + (patchData[idx10 + c] - patchData[idx00 + c]) * bx;
          const bot = patchData[idx01 + c] + (patchData[idx11 + c] - patchData[idx01 + c]) * bx;
          out[outIdx + c] = top + (bot - top) * by; // straight (unpremultiplied) color
        }
        out[outIdx + 3] = Math.min(1, patchAlpha);
      }
    }
    log("reprojection computed");

    if (link) app.activeDocument = doc;
    const newLayer = await doc.createLayer();
    newLayer.name = mode === "zenith" ? "Zenith Put" : "Nadir Put";
    if (anchorLayer) {
      try {
        newLayer.move(anchorLayer, constants.ElementPlacement.PLACEBEFORE);
      } catch (err) {
        log("couldn't move the new layer above its source: " + describeError(err), true);
      }
    }

    const newImageData = await imaging.createImageDataFromBuffer(out, {
      width: tgtW, height: tgtH, components: outComponents, componentSize: 32, colorSpace: patchColorSpace
    });
    await imaging.putPixels({ documentID: doc.id, layerID: newLayer.id, imageData: newImageData, targetBounds: { left: 0, top: 0 } });
    if (typeof newImageData.dispose === "function") newImageData.dispose();

    // Hide the patch-space layer so the reprojected one is what's visible.
    selected.visible = false;
    log(`${mode} put complete, new layer "${newLayer.name}"`);
  }, { commandName: mode === "zenith" ? "Put Zenith" : "Put Nadir" });
}

// Writes the webview's draw-layer PNG (equirect UV space, 2048x1024 with
// alpha) to a temp file, places it as a new layer, then resizes/repositions
// it to exactly cover the active document's canvas.
async function pushDrawLayerToDocument(base64) {
  if (app.documents.length === 0) {
    throw new Error("No active document open");
  }

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const tempFolder = await fs.getTemporaryFolder();
  const file = await tempFolder.createFile("equirect-draw-layer.png", { overwrite: true });
  await file.write(bytes.buffer, { format: storage.formats.binary });

  await core.executeAsModal(async () => {
    const docWidth = app.activeDocument.width;
    const docHeight = app.activeDocument.height;
    log(`doc size: ${docWidth}x${docHeight}`);
    const token = await fs.createSessionToken(file);

    await action.batchPlay(
      [{ _obj: "placeEvent", null: { _path: token, _kind: "local" } }],
      { synchronousExecution: true }
    );
    log("placeEvent done");

    const doc = app.activeDocument;
    // doc.activeLayer reads as undefined unless there's exactly one
    // unambiguous selected layer; doc.activeLayers (plural) is the more
    // reliable source right after a placeEvent.
    let layer = doc.activeLayer;
    if (!layer) {
      const activeLayers = doc.activeLayers;
      log(`activeLayer undefined, activeLayers.length=${activeLayers ? activeLayers.length : "n/a"}`);
      if (activeLayers && activeLayers.length > 0) {
        layer = activeLayers[0];
      }
    }
    if (!layer) {
      throw new Error("could not determine placed layer (activeLayer and activeLayers both empty)");
    }
    log(`active layer after place: name="${layer.name}" kind=${layer.kind}`);
    const b = layer.bounds;
    log(`bounds after place: left=${b.left} top=${b.top} right=${b.right} bottom=${b.bottom}`);
    const curW = b.right - b.left;
    const curH = b.bottom - b.top;

    if (curW > 0 && curH > 0) {
      const scaleX = (doc.width / curW) * 100;
      const scaleY = (doc.height / curH) * 100;
      log(`resizing: curW=${curW} curH=${curH} -> scaleX=${scaleX.toFixed(2)}% scaleY=${scaleY.toFixed(2)}%`);
      try {
        // Layer.resize() isn't a real DOM method on this object (unlike
        // .translate(), which is) — scale via batchPlay's transform
        // descriptor instead. It scales around the layer's own center, so
        // the translate step below still has to re-snap it to (0,0).
        await action.batchPlay(
          [{
            _obj: "transform",
            _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
            freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
            width: { _unit: "percentUnit", _value: scaleX },
            height: { _unit: "percentUnit", _value: scaleY },
            interpolation: { _enum: "interpolationType", _value: "bicubic" }
          }],
          { synchronousExecution: true }
        );
        log("transform (scale) completed");
      } catch (err) {
        log("transform (scale) threw: " + err.message, true);
      }
    } else {
      log("skipping resize, degenerate bounds", true);
    }

    const b2 = layer.bounds;
    log(`bounds after resize: left=${b2.left} top=${b2.top} right=${b2.right} bottom=${b2.bottom}`);
    try {
      layer.translate(-b2.left, -b2.top);
      log("translate() call completed");
    } catch (err) {
      log("translate() threw: " + err.message, true);
    }

    const b3 = layer.bounds;
    log(`bounds after translate: left=${b3.left} top=${b3.top} right=${b3.right} bottom=${b3.bottom}`);

    try {
      layer.name = "Equirect Annotations";
    } catch (err) {
      log("rename threw: " + err.message, true);
    }
  }, { commandName: "Add equirect annotation layer" });
}

// ---------- skybox EXR export ----------
// One-click export of the active master to the pipeline folder:
//   skybox-folder/wip/name_v01.psb  ->  skybox-folder/out/MM_DD_YY/name.exr
// Ported from ND_PSD2EXR_Generic_v5.jsx (wip -> ../out/<date>, _vNN stripped).
// The document must be a 32-bit RGB equirect at least 8192 wide; if it's
// taller than 2:1 the bottom is cropped off.
// Larger masters are downscaled here in JS (see areaWeights) rather than
// with Photoshop's resizeImage, so the sampling is fully under our control.
// The master itself is never modified: the visible composite is read in
// horizontal bands, resampled, and written into a temporary document that
// is saved as OpenEXR and closed.
const EXPORT_WIDTH = 8192;
const EXPORT_HEIGHT = 4096;
const EXPORT_BAND_ROWS = 64; // output rows resampled per getPixels/putPixels round trip

function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

// MM_DD_YY, matching ND_PSD2EXR_Generic_v5.jsx's getDateFormatted()
function exportDateFolderName(date) {
  return `${pad2(date.getMonth() + 1)}_${pad2(date.getDate())}_${String(date.getFullYear()).slice(2)}`;
}

function splitPath(p) {
  return p.split(/[\\/]/);
}

// Validates the active document and works out where the EXR goes. Returns
// { problems: [...] } when the document isn't exportable, so every issue can
// be reported at once instead of one per click.
function getExportPlan(doc) {
  const problems = [];
  const { constants } = require("photoshop");

  let docPath = "";
  try {
    docPath = doc.path || "";
  } catch (err) {
    docPath = "";
  }
  const parts = docPath ? splitPath(docPath) : [];
  const fileName = parts.length ? parts[parts.length - 1] : doc.name;
  const parentName = parts.length >= 2 ? parts[parts.length - 2] : "";

  if (!docPath) {
    problems.push("Document has never been saved. Save it inside a 'wip' folder first.");
  } else if (parentName.toLowerCase() !== "wip") {
    problems.push(`Document is in '${parentName}', not in a 'wip' folder.`);
  }
  if (doc.mode !== constants.DocumentMode.RGB) {
    problems.push(`Color mode is ${doc.mode}, needs RGB.`);
  }
  if (doc.bitsPerChannel !== constants.BitsPerChannelType.THIRTYTWO) {
    problems.push(`Bit depth is ${doc.bitsPerChannel}, needs 32 bits per channel.`);
  }
  // Taller than 2:1: the bottom is cropped off (only the top width/2 rows are
  // read, the master keeps its full canvas). Wider than 2:1 can't be fixed by
  // cropping without breaking the 360 wrap, so it's refused.
  const w = doc.width, h = doc.height;
  const cropH = Math.floor(w / 2);
  if (h < cropH) {
    problems.push(`Size is ${w}x${h}, wider than 2:1 (cropping the width would break the 360 wrap).`);
  } else if (w < EXPORT_WIDTH) {
    problems.push(`Size is ${w}x${h}, smaller than ${EXPORT_WIDTH}x${EXPORT_HEIGHT} (no upscaling).`);
  }

  if (problems.length) return { problems };

  // strips name_v012, name.v012 and name-v012
  const baseName = fileName.replace(/\.[^.]+$/, "").replace(/[._-]v\d+$/i, "");
  const skyboxFolderPath = parts.slice(0, -2).join("/");
  const dateFolder = exportDateFolderName(new Date());
  return {
    problems,
    skyboxFolderPath,
    dateFolder,
    baseName,
    exrName: baseName + ".exr",
    displayPath: `${skyboxFolderPath}/out/${dateFolder}/${baseName}.exr`,
    srcWidth: w,
    srcHeight: cropH,
    croppedRows: h - cropH
  };
}

function toFileUrl(nativePath) {
  const p = nativePath.replace(/\\/g, "/");
  return "file:" + (p.startsWith("/") ? p : "/" + p);
}

async function getOrCreateFolder(parent, name) {
  try {
    const entry = await parent.getEntry(name);
    if (entry.isFolder) return entry;
    throw new Error(`'${entry.nativePath}' exists but is not a folder`);
  } catch (err) {
    if (err && /not a folder/.test(err.message)) throw err;
    return parent.createFolder(name);
  }
}

// ---------- per-document settings (saved in the document's XMP) ----------
// Stored as one JSON string under a custom XMP property, so they travel
// with the PSB: { exportName, halfEquirect, fog: {...}, preview: {...}, showExportDialog }.
// Changing them marks the document modified; they persist when it's saved.
const XMP_NS = "http://ndonel.com/mooncloud/1.0/";
const XMP_PREFIX = "mooncloud";
const XMP_PROP = "settings";
const DEFAULT_DOC_SETTINGS = { halfEquirect: false, fog: null, preview: null, showExportDialog: true };
const docSettingsCache = new Map(); // doc id -> settings

function xmpModule() {
  const { xmp } = require("uxp");
  if (!xmp || !xmp.XMPMeta) throw new Error("UXP xmp module not available");
  try {
    xmp.XMPMeta.registerNamespace(XMP_NS, XMP_PREFIX);
  } catch (err) {
    // already registered
  }
  return xmp;
}

async function getDocXmp(doc) {
  const res = await action.batchPlay(
    [{ _obj: "get", _target: [{ _property: "XMPMetadataAsUTF8" }, { _ref: "document", _id: doc.id }] }],
    { synchronousExecution: true }
  );
  return (res && res[0] && res[0].XMPMetadataAsUTF8) || "";
}

async function readDocSettings(doc) {
  if (docSettingsCache.has(doc.id)) return docSettingsCache.get(doc.id);
  let settings = { ...DEFAULT_DOC_SETTINGS };
  try {
    const { XMPMeta } = xmpModule();
    const xmpStr = await getDocXmp(doc);
    if (xmpStr) {
      const meta = new XMPMeta(xmpStr);
      const prop = meta.getProperty(XMP_NS, XMP_PROP);
      if (prop && prop.value) settings = { ...settings, ...JSON.parse(prop.value) };
    }
  } catch (err) {
    log(`couldn't read settings from "${doc.title}" metadata: ${describeError(err)}`, true);
  }
  docSettingsCache.set(doc.id, settings);
  return settings;
}

// Merges changes into the document's settings and writes them to its XMP.
async function updateDocSettings(doc, changes) {
  const settings = { ...(await readDocSettings(doc)), ...changes };
  Object.keys(settings).forEach((k) => settings[k] === undefined && delete settings[k]);
  docSettingsCache.set(doc.id, settings);
  try {
    const { XMPMeta } = xmpModule();
    await core.executeAsModal(async () => {
      const xmpStr = await getDocXmp(doc);
      const meta = xmpStr ? new XMPMeta(xmpStr) : new XMPMeta();
      meta.setProperty(XMP_NS, XMP_PROP, JSON.stringify(settings));
      await action.batchPlay(
        [{
          _obj: "set",
          _target: [{ _ref: "property", _property: "XMPMetadataAsUTF8" }, { _ref: "document", _id: doc.id }],
          to: { _obj: "document", XMPMetadataAsUTF8: meta.serialize() }
        }],
        { synchronousExecution: true }
      );
    }, { commandName: "Save Mooncloud settings" });
  } catch (err) {
    log(`couldn't save settings to "${doc.title}" metadata: ${describeError(err)}`, true);
  }
  return settings;
}

// Viewer changes (Half, fog sliders) arrive in bursts; save once they settle.
const SETTINGS_SAVE_DEBOUNCE_MS = 800;
let pendingDocChanges = null;
let pendingDocTimer = null;

function queueDocSettings(changes) {
  if (app.documents.length === 0) return;
  const doc = app.activeDocument;
  if (pendingDocChanges && pendingDocChanges.docId !== doc.id) flushDocSettings();
  pendingDocChanges = { docId: doc.id, doc, changes: { ...(pendingDocChanges ? pendingDocChanges.changes : {}), ...changes } };
  // keep the cache current immediately so tools see the new values
  const cached = docSettingsCache.get(doc.id);
  if (cached) docSettingsCache.set(doc.id, { ...cached, ...changes });
  if (pendingDocTimer) clearTimeout(pendingDocTimer);
  pendingDocTimer = setTimeout(flushDocSettings, SETTINGS_SAVE_DEBOUNCE_MS);
}

function flushDocSettings() {
  if (pendingDocTimer) clearTimeout(pendingDocTimer);
  pendingDocTimer = null;
  if (!pendingDocChanges) return;
  const { doc, changes } = pendingDocChanges;
  pendingDocChanges = null;
  updateDocSettings(doc, changes).catch((err) => log("settings save failed: " + describeError(err), true));
}

// When the active document changes, load its settings and push Half/Fog to
// the viewer and the export-dialog state to the panel menu.
let lastSyncedDocId = null;

async function syncActiveDocSettings(force) {
  if (app.documents.length === 0) {
    lastSyncedDocId = null;
    return;
  }
  const doc = app.activeDocument;
  if (!force && doc.id === lastSyncedDocId) return;
  flushDocSettings();
  lastSyncedDocId = doc.id;
  const settings = await readDocSettings(doc);
  halfEquirect = !!settings.halfEquirect;
  previewSettings = { ...DEFAULT_PREVIEW, ...(settings.preview || {}) };
  setExportDialogMenuState(settings.showExportDialog !== false);
  sendToWebview({ type: "apply-doc-settings", halfEquirect, fog: settings.fog || null, preview: previewSettings });
  log(`settings for "${doc.title}": half ${halfEquirect ? "on" : "off"}, fog ${settings.fog && settings.fog.enabled ? "on" : "off"}, preview ${previewSettings.resolution} ${previewSettings.color} ${previewSettings.exposure} EV${settings.exportName ? `, export name "${settings.exportName}"` : ""}`);
}

async function getEntryOrNull(parent, name) {
  try {
    return await parent.getEntry(name);
  } catch (err) {
    return null;
  }
}

// Output names: no extension, no characters Windows won't take in a file name.
function sanitizeExportName(name, fallback) {
  const clean = String(name || "").trim().replace(/\.exr$/i, "").replace(/[\\/:*?"<>|]/g, "_").trim();
  return clean || fallback;
}

// Pre-export summary: what will happen and where the file lands, with an
// editable output name. Returns { name, hide } to go ahead, or null.
// "Don't show again" is saved in the document and undone from the panel
// menu (Show Export Dialog).
async function showExportDialog(plan, srcDoc, existingDateFolder, initialName) {
  const dlg = document.getElementById("exportDialog");
  if (!dlg || typeof dlg.uxpShowModal !== "function") return { name: initialName, hide: false };

  const steps = [`Check ${srcDoc.name}: 32-bit RGB, saved in wip`];
  if (plan.croppedRows > 0) {
    steps.push(`Crop ${plan.croppedRows} rows off the bottom to make it 2:1`);
  }
  steps.push(plan.srcWidth === EXPORT_WIDTH
    ? `Keep size ${EXPORT_WIDTH}x${EXPORT_HEIGHT} (no resampling)`
    : `Downscale ${plan.srcWidth}x${plan.srcHeight} to ${EXPORT_WIDTH}x${EXPORT_HEIGHT} (area average)`);
  steps.push("Flatten visible layers into a temporary copy (master untouched)");
  steps.push("Save as 32-bit OpenEXR, no alpha");

  const list = document.getElementById("exportSteps");
  list.innerHTML = steps.map((t, i) => `<div class="estep"><span class="enum">${i + 1}</span>${escapeHtml(t)}</div>`).join("");
  const nameInput = document.getElementById("exportNameInput");
  const pathEl = document.getElementById("exportPath");
  const warn = document.getElementById("exportOverwrite");
  const resetLink = document.getElementById("exportNameReset");
  const refresh = async () => {
    const name = sanitizeExportName(nameInput.value, plan.baseName);
    pathEl.textContent = `${plan.skyboxFolderPath}/out/${plan.dateFolder}/${name}.exr`;
    resetLink.hidden = name === plan.baseName;
    warn.hidden = !(existingDateFolder && (await getEntryOrNull(existingDateFolder, name + ".exr")));
  };
  nameInput.value = initialName;
  nameInput.oninput = refresh;
  resetLink.onclick = () => { nameInput.value = plan.baseName; refresh(); };
  await refresh();
  const hideBox = document.getElementById("exportHideCheck");
  hideBox.checked = false;

  const result = await dlg.uxpShowModal({ title: "Export EXR", resize: "none" });
  if (result !== "export") return null;
  return { name: sanitizeExportName(nameInput.value, plan.baseName), hide: !!hideBox.checked };
}

function setExportDialogMenuState(shown) {
  try {
    const item = entrypoints.getPanel(PANEL_ID).menuItems.getItem("toggleExportDialog");
    item.checked = shown;
  } catch (err) {
    // menu not set up yet
  }
}

// Opens a folder in Explorer/Finder. shell.openPath needs the manifest's
// launchProcess permission; fall back to a file: URL, then to copying the
// path so there's always something useful.
async function openFolder(nativePath) {
  try {
    const res = await shell.openPath(nativePath);
    if (!res) return; // "" means success
    log("openPath: " + res, true);
  } catch (err) {
    log("openPath failed: " + describeError(err), true);
  }
  try {
    await shell.openExternal(toFileUrl(nativePath).replace(/^file:\/*/, "file:///"));
    return;
  } catch (err) {
    log("openExternal failed: " + describeError(err), true);
  }
  try {
    await navigator.clipboard.writeText(nativePath);
    showToast("Couldn't open the folder, path copied to clipboard", null);
  } catch (err) {
    log("clipboard failed: " + describeError(err), true);
  }
}

// Toast: floats over the 3D view (drawn by the viewer, since the webview is
// a native layer the panel can't draw over). Falls back to a row above the
// tool bar if the viewer isn't loaded. Auto-dismisses either way.
const TOAST_MS = 7000;
let toastTimer = null;

function showToast(message, folderPath) {
  log(`toast: ${message} (${webviewEl && webviewReady ? "viewer" : "panel strip"})`);
  if (webviewEl && webviewReady) {
    sendToWebview({ type: "toast", text: message, folderPath: folderPath || null, ms: TOAST_MS });
    return;
  }
  const toast = document.getElementById("toast");
  if (!toast) return;
  document.getElementById("toastText").textContent = message;
  const link = document.getElementById("toastOpen");
  link.hidden = !folderPath;
  link.onclick = folderPath ? () => openFolder(folderPath) : null;
  toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, TOAST_MS);
}

function hideToast() {
  const toast = document.getElementById("toast");
  if (toast) toast.hidden = true;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
}

async function confirmOverwrite(nativePath) {
  const dlg = document.getElementById("overwriteDialog");
  const msg = document.getElementById("overwriteMessage");
  if (!dlg || typeof dlg.uxpShowModal !== "function") return true;
  msg.textContent = `${nativePath} already exists. Overwrite it?`;
  const result = await dlg.uxpShowModal({ title: "Export EXR", resize: "none" });
  return result === "overwrite";
}

// Area-averaging (box) resampling weights for one axis. Each output pixel
// is the exact coverage-weighted mean of the source pixels under its
// footprint [d*s, (d+1)*s). Chosen over bicubic/Lanczos because all
// weights are non-negative, so a 32-bit HDR sun can't ring into dark halos
// or negative values, and total energy (mean radiance, what the lighting
// actually integrates) is preserved exactly. Footprints never leave
// [0, srcN), so the equirect seam needs no wrap handling: nothing from the
// right edge bleeds into the left. Works for non-integer ratios too.
function areaWeights(srcN, dstN) {
  const s = srcN / dstN;
  const out = new Array(dstN);
  for (let d = 0; d < dstN; d++) {
    const start = d * s;
    const end = start + s;
    const i0 = Math.floor(start);
    const i1 = Math.min(srcN, Math.ceil(end - 1e-9));
    const w = new Float64Array(i1 - i0);
    for (let i = i0; i < i1; i++) {
      w[i - i0] = (Math.min(end, i + 1) - Math.max(start, i)) / s;
    }
    out[d] = { i0, w };
  }
  return out;
}

// app.documents.add() can resolve to null instead of throwing (seen on Mac,
// e.g. when the master's colour profile name isn't installed there). Retry
// without the profile, then fall back to batchPlay "make" + activeDocument.
async function createExportDoc(width, height, profile) {
  const base = { width, height, resolution: 72, mode: "RGBColorMode", fill: "transparent", depth: 32 };
  const attempts = profile ? [{ ...base, profile }, base] : [base];
  for (const opts of attempts) {
    try {
      const doc = await app.documents.add(opts);
      if (doc) {
        log(`temp export document created (profile: ${opts.profile || "default"})`);
        return doc;
      }
      log(`documents.add returned null (profile: ${opts.profile || "default"})`, true);
    } catch (err) {
      log(`documents.add failed (profile: ${opts.profile || "default"}): ${describeError(err)}`, true);
    }
  }
  const countBefore = app.documents.length;
  await action.batchPlay(
    [{
      _obj: "make",
      new: {
        _obj: "document",
        name: "Mooncloud EXR export",
        mode: { _class: "RGBColorMode" },
        width: { _unit: "pixelsUnit", _value: width },
        height: { _unit: "pixelsUnit", _value: height },
        resolution: { _unit: "densityUnit", _value: 72 },
        depth: 32,
        fill: { _enum: "fill", _value: "transparent" }
      }
    }],
    { synchronousExecution: true, dialogOptions: "dontDisplay" }
  );
  const doc = app.activeDocument;
  if (!doc || app.documents.length <= countBefore || doc.width !== width || doc.height !== height) {
    throw new Error("Photoshop couldn't create the temporary 32-bit export document");
  }
  log("temp export document created via batchPlay (profile: default)");
  return doc;
}

async function exportSkyboxExr() {
  if (app.documents.length === 0) {
    throw new Error("No active document open");
  }
  const srcDoc = app.activeDocument;
  const plan = getExportPlan(srcDoc);
  if (plan.problems.length) {
    const text = "Can't export this document:\n\n• " + plan.problems.join("\n• ");
    plan.problems.forEach((p) => log("export check: " + p, true));
    await app.showAlert(text);
    return;
  }
  if (plan.croppedRows > 0) {
    log(`export: not 2:1, cropping ${plan.croppedRows} rows off the bottom (${plan.srcWidth}x${plan.srcHeight + plan.croppedRows} -> ${plan.srcWidth}x${plan.srcHeight})`);
  }
  log(`export: ${srcDoc.name} (${plan.srcWidth}x${plan.srcHeight}) -> ${plan.displayPath}`);

  // Look before creating anything, so cancelling leaves no empty folders.
  const skyboxFolder = await fs.getEntryWithUrl(toFileUrl(plan.skyboxFolderPath));
  const existingOut = await getEntryOrNull(skyboxFolder, "out");
  const existingDate = existingOut ? await getEntryOrNull(existingOut, plan.dateFolder) : null;
  const docSettings = await readDocSettings(srcDoc);
  let outName = sanitizeExportName(docSettings.exportName, plan.baseName);

  if (docSettings.showExportDialog !== false) {
    const choice = await showExportDialog(plan, srcDoc, existingDate, outName);
    if (!choice) {
      log("export cancelled");
      return;
    }
    outName = choice.name;
    // A custom name is remembered in the document; the default isn't stored,
    // so it keeps following the file name.
    const changes = { exportName: outName === plan.baseName ? undefined : outName };
    if (choice.hide) {
      changes.showExportDialog = false;
      setExportDialogMenuState(false);
      log("export dialog hidden for this document (re-enable from the panel menu: Show Export Dialog)");
    }
    if (changes.exportName !== docSettings.exportName || choice.hide) await updateDocSettings(srcDoc, changes);
  } else {
    const exists = !!(existingDate && (await getEntryOrNull(existingDate, outName + ".exr")));
    if (exists && !(await confirmOverwrite(`${plan.skyboxFolderPath}/out/${plan.dateFolder}/${outName}.exr`))) {
      log("export cancelled, existing file kept");
      return;
    }
  }
  plan.exrName = outName + ".exr";
  plan.displayPath = `${plan.skyboxFolderPath}/out/${plan.dateFolder}/${plan.exrName}`;
  log(`export: writing ${plan.displayPath}`);

  const outFolder = await getOrCreateFolder(skyboxFolder, "out");
  const dateFolder = await getOrCreateFolder(outFolder, plan.dateFolder);
  const exrFile = await dateFolder.createFile(plan.exrName, { overwrite: true });

  await core.executeAsModal(async (executionContext) => {
    const srcW = plan.srcWidth, srcH = plan.srcHeight;
    const dstW = EXPORT_WIDTH, dstH = EXPORT_HEIGHT;
    const xw = areaWeights(srcW, dstW);
    const yw = areaWeights(srcH, dstH);
    log(srcW === dstW ? "already at export size, no resampling" : `downscaling ${srcW}x${srcH} -> ${dstW}x${dstH} (area average)`);

    let profile;
    try {
      profile = srcDoc.colorProfileName;
    } catch (err) {
      profile = undefined;
    }
    const outDoc = await createExportDoc(dstW, dstH, profile);

    let step = "reading pixels";
    try {
      const outLayerId = outDoc.layers[0].id;
      const rowAcc = new Float32Array(srcW * 3);

      for (let b0 = 0; b0 < dstH; b0 += EXPORT_BAND_ROWS) {
        if (executionContext.isCancelled) throw new Error("Export cancelled");
        const b1 = Math.min(dstH, b0 + EXPORT_BAND_ROWS);
        const r0 = yw[b0].i0;
        const r1 = yw[b1 - 1].i0 + yw[b1 - 1].w.length;

        // Composite of visible layers only, so hidden layers are left out
        // the same way v5's deleteHiddenLayers() did, without touching the master.
        step = "reading pixels";
        const result = await imaging.getPixels({
          documentID: srcDoc.id,
          sourceBounds: { left: 0, top: r0, right: srcW, bottom: r1 },
          componentSize: 32
        });
        const imgData = result.imageData;
        const src = await imgData.getData();
        const comps = imgData.components;
        if (imgData.width !== srcW || imgData.height !== r1 - r0) {
          throw new Error(`getPixels returned ${imgData.width}x${imgData.height}, expected ${srcW}x${r1 - r0}`);
        }
        if (typeof imgData.dispose === "function") imgData.dispose();

        const band = new Float32Array((b1 - b0) * dstW * 3);
        for (let y = b0; y < b1; y++) {
          // vertical pass: weighted sum of the source rows under this output row
          rowAcc.fill(0);
          const { i0: ry0, w: wy } = yw[y];
          for (let j = 0; j < wy.length; j++) {
            const wgt = wy[j];
            let si = (ry0 + j - r0) * srcW * comps;
            for (let x = 0, ai = 0; x < srcW; x++, si += comps, ai += 3) {
              rowAcc[ai] += src[si] * wgt;
              rowAcc[ai + 1] += src[si + 1] * wgt;
              rowAcc[ai + 2] += src[si + 2] * wgt;
            }
          }
          // horizontal pass
          let oi = (y - b0) * dstW * 3;
          for (let x = 0; x < dstW; x++, oi += 3) {
            const { i0: cx0, w: wx } = xw[x];
            let r = 0, g = 0, bl = 0;
            for (let i = 0; i < wx.length; i++) {
              const ai = (cx0 + i) * 3;
              r += rowAcc[ai] * wx[i];
              g += rowAcc[ai + 1] * wx[i];
              bl += rowAcc[ai + 2] * wx[i];
            }
            band[oi] = r;
            band[oi + 1] = g;
            band[oi + 2] = bl;
          }
        }

        // No colorProfile tag: the temp doc was created with the master's
        // profile, so the pixels are already in its space. Passing names like
        // "OpenEXR Rec. 709" through fails with "Unknown color profile".
        step = "writing pixels";
        const bandData = await imaging.createImageDataFromBuffer(band, {
          width: dstW, height: b1 - b0, components: 3, componentSize: 32, colorSpace: "RGB"
        });
        await imaging.putPixels({
          documentID: outDoc.id,
          layerID: outLayerId,
          imageData: bandData,
          targetBounds: { left: 0, top: b0 }
        });
        if (typeof bandData.dispose === "function") bandData.dispose();

        executionContext.reportProgress({ value: b1 / dstH, commandName: "Exporting skybox EXR" });
        if ((b0 / EXPORT_BAND_ROWS) % 16 === 0) log(`export: rows ${b0}-${b1} of ${dstH}`);
      }

      // Flatten so the EXR has no alpha channel.
      step = "flattening";
      await action.batchPlay(
        [{ _obj: "flattenImage", _target: [{ _ref: "document", _id: outDoc.id }] }],
        { synchronousExecution: true }
      );
      step = "saving EXR";

      const token = await fs.createSessionToken(exrFile);
      await action.batchPlay(
        [{
          _obj: "save",
          _target: [{ _ref: "document", _id: outDoc.id }],
          as: "OpenEXR",
          in: { _path: token, _kind: "local" },
          copy: true,
          lowerCase: true
        }],
        { synchronousExecution: true, dialogOptions: "dontDisplay" }
      );
      log(`EXR written: ${exrFile.nativePath}`);
    } catch (err) {
      throw new Error(`${step}: ${describeError(err)}`);
    } finally {
      // Cleanup must never mask the real error above.
      try {
        await outDoc.closeWithoutSaving();
      } catch (err) {
        log(`couldn't close temp export document: ${describeError(err)}`, true);
      }
      try {
        app.activeDocument = srcDoc;
      } catch (err) {
        log(`couldn't reactivate source document: ${describeError(err)}`, true);
      }
    }
  }, { commandName: "Export skybox EXR" });

  showToast(`Exported ${plan.exrName} to out/${plan.dateFolder}`, dateFolder.nativePath);
}

// The UXP webview message bridge does not preserve TypedArray/ArrayBuffer
// identity across postMessage (it lands as a plain object with one key per
// index, e.g. {"0":12,...}), so binary pixel data is sent as a base64
// string instead, which every bridge implementation handles as a primitive.
function uint8ToBase64(bytes) {
  const chunkSize = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

let webviewEl = null;
let webviewReady = false;

function sendToWebview(data) {
  if (webviewEl) webviewEl.postMessage(data);
}

let refreshInFlight = false;
let refreshQueued = false;

// quickFirst: for a user-requested 4k/full load, stream a 2k pass first so
// the viewer updates right away (not for live mode, which refreshes often).
async function onRefresh(quickFirst) {
  // Live mode can fire another trigger while a slow (e.g. large document)
  // refresh is still in flight; queue at most one follow-up rather than
  // running overlapping executeAsModal calls.
  if (refreshInFlight) {
    refreshQueued = true;
    return;
  }
  refreshInFlight = true;
  try {
    if (!webviewEl || !webviewReady) {
      log("webview not ready yet, skipping refresh", true);
      return;
    }
    log(`fetching ${previewSettings.resolution} preview (viewer max texture ${viewerMaxTextureSize})…`);
    sendToWebview({ type: "equirect-syncing" });
    if (quickFirst === true && previewSettings.resolution !== "2k" && app.documents.length &&
        previewTargetWidth(app.activeDocument) > PREVIEW_WIDTHS["2k"]) {
      const quick = await streamEquirectPreview("2k");
      log(`quick 2k pass in ${quick.ms}ms`);
      sendToWebview({ type: "equirect-syncing" });
    }
    const info = await streamEquirectPreview();
    log(
      `doc: ${info.docTitle} (${info.docSize}) -> preview ${info.width}x${info.height} (${previewSettings.resolution}), ` +
      `RGBE ${info.megabytes.toFixed(1)} MB in ${info.chunks} chunks, ${info.ms}ms ` +
      `(PS read ${previewTimes.read}, waited on PS ${previewTimes.wait}, RGBE ${previewTimes.encode}, base64 ${previewTimes.base64}, send ${previewTimes.send} ms)`
    );
  } catch (err) {
    log("ERROR: " + (err && err.message ? err.message : String(err)), true);
    sendToWebview({ type: "equirect-abort" });
  } finally {
    refreshInFlight = false;
    if (refreshQueued) {
      refreshQueued = false;
      onRefresh();
    }
  }
}

// ---------- live mode (Generator-style auto refresh) ----------
const LIVE_DEBOUNCE_MS = 500;
let liveModeEnabled = false;
let liveDebounceTimer = null;

function debouncedLiveRefresh() {
  if (liveDebounceTimer) clearTimeout(liveDebounceTimer);
  liveDebounceTimer = setTimeout(() => {
    liveDebounceTimer = null;
    onRefresh();
  }, LIVE_DEBOUNCE_MS);
}

function setLiveMode(enabled) {
  if (enabled === liveModeEnabled) return;
  liveModeEnabled = enabled;
  if (enabled) {
    action.addNotificationListener(["historyStateChanged"], debouncedLiveRefresh);
    log("live mode enabled");
  } else {
    action.removeNotificationListener(["historyStateChanged"], debouncedLiveRefresh);
    if (liveDebounceTimer) {
      clearTimeout(liveDebounceTimer);
      liveDebounceTimer = null;
    }
    log("live mode disabled");
  }
}

function init() {
  const logToggleBtn = document.getElementById("logToggleBtn");
  const logPanel = document.getElementById("logPanel");
  if (logToggleBtn && logPanel) {
    logToggleBtn.addEventListener("click", () => {
      logPanel.hidden = !logPanel.hidden;
    });
  }

  const rangeCompressBtn = document.getElementById("rangeCompressBtn");
  const rangeExpandBtn = document.getElementById("rangeExpandBtn");
  if (rangeCompressBtn) {
    rangeCompressBtn.addEventListener("click", () => {
      applyRangeTransform("compress").catch((err) => log("ERROR range compress: " + err.message, true));
    });
  }
  if (rangeExpandBtn) {
    rangeExpandBtn.addEventListener("click", () => {
      applyRangeTransform("expand").catch((err) => log("ERROR range expand: " + err.message, true));
    });
  }

  const getZenithBtn = document.getElementById("getZenithBtn");
  const putZenithBtn = document.getElementById("putZenithBtn");
  const getNadirBtn = document.getElementById("getNadirBtn");
  const putNadirBtn = document.getElementById("putNadirBtn");
  if (getZenithBtn) {
    getZenithBtn.addEventListener("click", () => {
      extractPole("zenith").catch((err) => log("ERROR get zenith: " + describeError(err), true));
    });
  }
  if (putZenithBtn) {
    putZenithBtn.addEventListener("click", () => {
      putPole("zenith").catch((err) => log("ERROR put zenith: " + describeError(err), true));
    });
  }
  if (getNadirBtn) {
    getNadirBtn.addEventListener("click", () => {
      extractPole("nadir").catch((err) => log("ERROR get nadir: " + describeError(err), true));
    });
  }
  if (putNadirBtn) {
    putNadirBtn.addEventListener("click", () => {
      putPole("nadir").catch((err) => log("ERROR put nadir: " + describeError(err), true));
    });
  }

  const exportExrBtn = document.getElementById("exportExrBtn");
  if (exportExrBtn) {
    exportExrBtn.addEventListener("click", () => {
      exportSkyboxExr().catch((err) => {
        log("ERROR export EXR: " + describeError(err), true);
        showToast("Export failed: " + describeError(err), null);
      });
    });
  }
  const exportDialog = document.getElementById("exportDialog");
  if (exportDialog) {
    document.getElementById("exportCancelBtn").addEventListener("click", () => exportDialog.close("cancel"));
    document.getElementById("exportOkBtn").addEventListener("click", () => exportDialog.close("export"));
  }
  const toastClose = document.getElementById("toastClose");
  if (toastClose) toastClose.addEventListener("click", hideToast);

  const overwriteDialog = document.getElementById("overwriteDialog");
  if (overwriteDialog) {
    document.getElementById("overwriteCancelBtn").addEventListener("click", () => overwriteDialog.close("cancel"));
    document.getElementById("overwriteOkBtn").addEventListener("click", () => overwriteDialog.close("overwrite"));
  }

  webviewEl = document.getElementById("viewerWebview");
  if (webviewEl) {
    webviewEl.addEventListener("loaderror", (e) => {
      log("webview loaderror — see console for raw event", true);
      console.error(e);
    });
    webviewEl.addEventListener("loadstop", () => {
      webviewReady = true;
      log("viewer loaded");
      syncActiveDocSettings(true).catch((err) => log("settings sync failed: " + describeError(err), true));
    });
    webviewEl.addEventListener("message", (e) => {
      // The webview->host bridge delivers the payload as a JSON string on
      // e.message (not the standard MessageEvent e.data).
      let msg = null;
      if (typeof e.message === "string") {
        try {
          msg = JSON.parse(e.message);
        } catch (err) {
          msg = e.message;
        }
      }
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "webview-log") {
        log("[webview] " + msg.text);
        return;
      }
      const loggableMsg = msg.base64
        ? { ...msg, base64: `<${msg.base64.length} base64 chars>` }
        : msg;
      log("message from webview: " + JSON.stringify(loggableMsg));
      if (msg.type === "request-refresh") {
        onRefresh(true);
      } else if (msg.type === "mooncloud-load-key") {
        loadMcKey().then((apiKey) => sendToWebview({ type: "mooncloud-key", apiKey }));
      } else if (msg.type === "mooncloud-save-key") {
        saveMcKey(msg.apiKey).then(
          () => log("Mooncloud key saved"),
          (err) => log("failed to save Mooncloud key: " + err.message, true)
        );
      } else if (msg.type === "mooncloud-clear-key") {
        clearMcKey().then(() => log("Mooncloud key cleared"));
      } else if (msg.type === "open-folder") {
        openFolder(msg.path);
      } else if (msg.type === "open-external") {
        shell.openExternal(msg.url);
        log("opened externally: " + msg.url);
      } else if (msg.type === "set-half-mode") {
        halfEquirect = !!msg.enabled;
        log(`half equirect ${halfEquirect ? "on: zenith tools treat the image as the upper hemisphere" : "off"}`);
        queueDocSettings({ halfEquirect });
      } else if (msg.type === "set-fog") {
        queueDocSettings({ fog: msg.fog });
      } else if (msg.type === "viewer-caps") {
        if (msg.maxTextureSize > 0) viewerMaxTextureSize = msg.maxTextureSize;
        log(`viewer max texture size ${viewerMaxTextureSize}`);
      } else if (msg.type === "set-preview") {
        // exposure/colour are applied in the viewer; only a new resolution needs new pixels
        const resolutionChanged = msg.preview.resolution !== previewSettings.resolution;
        previewSettings = { ...DEFAULT_PREVIEW, ...msg.preview };
        queueDocSettings({ preview: previewSettings });
        if (resolutionChanged) onRefresh(true);
      } else if (msg.type === "set-live-mode") {
        setLiveMode(!!msg.enabled);
      } else if (msg.type === "push-draw-layer") {
        pushDrawLayerToDocument(msg.base64).then(
          () => log("draw layer added to document"),
          (err) => log("ERROR pushing draw layer: " + (err && err.message ? err.message : String(err)), true)
        );
      }
    });
  }

  entrypoints.setup({
    panels: {
      [PANEL_ID]: {
        show() {},
        menuItems: [
          { id: "toggleLog", label: "Show Log", checked: false },
          { id: "copyLog", label: "Copy Log to Clipboard" },
          { id: "sep1", label: "-" },
          { id: "manageMooncloud", label: "Manage Mooncloud Key…" },
          { id: "toggleExportDialog", label: "Show Export Dialog", checked: true },
          { id: "sep2", label: "-" },
          { id: "toggleViewportUI", label: "Hide Viewport UI", checked: false }
        ],
        invokeMenu(id) {
          if (id === "toggleLog") {
            const { menuItems } = entrypoints.getPanel(PANEL_ID);
            const item = menuItems.getItem("toggleLog");
            item.checked = !item.checked;
            item.label = item.checked ? "Hide Log" : "Show Log";
            const logPanel = document.getElementById("logPanel");
            if (logPanel) logPanel.hidden = !item.checked;
          } else if (id === "copyLog") {
            const text = logLines.map((l) => `${l.time}  ${l.msg}`).join("\n");
            try {
              navigator.clipboard.writeText(text).then(
                () => log("log copied to clipboard"),
                (err) => log("copy failed: " + err.message, true)
              );
            } catch (err) {
              log("copy failed: " + err.message, true);
            }
          } else if (id === "toggleExportDialog") {
            const { menuItems } = entrypoints.getPanel(PANEL_ID);
            const item = menuItems.getItem("toggleExportDialog");
            item.checked = !item.checked;
            if (app.documents.length) {
              updateDocSettings(app.activeDocument, { showExportDialog: item.checked });
            }
          } else if (id === "manageMooncloud") {
            sendToWebview({ type: "open-mooncloud-modal" });
          } else if (id === "toggleViewportUI") {
            const { menuItems } = entrypoints.getPanel(PANEL_ID);
            const item = menuItems.getItem("toggleViewportUI");
            item.checked = !item.checked;
            item.label = item.checked ? "Show Viewport UI" : "Hide Viewport UI";
            sendToWebview({ type: "toggle-ui", hidden: item.checked });
          }
        }
      }
    }
  });

  // Follow document switches (and new/opened documents) to apply each one's settings.
  action.addNotificationListener(["select", "open", "make", "close"], () => {
    setTimeout(() => syncActiveDocSettings(false).catch((err) => log("settings sync failed: " + describeError(err), true)), 50);
  });

  log(`panel ready (build ${BUILD}), waiting for viewer to load…`);
}

try {
  init();
} catch (err) {
  log("ERROR in init(): " + (err && err.message ? err.message : String(err)), true);
}
