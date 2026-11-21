// Runs plugin/skydome.js end to end against a mocked Photoshop (no UI):
// node test/skydome.mock.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const SL = require("../plugin/skylayout.js");

function run(depth, W, H, half, settings) {
  const C = 4;
  const docs = [];
  const src = { id: 1, name: "INTER_test_v001.psb", width: W, height: H, mode: "RGB", bitsPerChannel: depth, colorProfileName: "sRGB IEC61966-2.1" };
  docs.push(src);
  const written = {};
  const max = depth === 8 ? 255 : depth === 16 ? 32768 : 1;
  const ps = {
    constants: { BitsPerChannelType: { EIGHT: 8, SIXTEEN: 16, THIRTYTWO: 32 }, DocumentMode: { RGB: "RGB" } },
    app: {
      documents: { get length() { return docs.length; }, add: async (o) => { const d = { id: docs.length + 1, ...o, layers: [{ id: 99, name: "Layer 1" }], closeWithoutSaving: async () => {} }; docs.push(d); written.doc = d; return d; } },
      activeDocument: src,
      showAlert: async (t) => { throw new Error("alert: " + t); }
    },
    imaging: {
      getPixels: async (o) => {
        const b = o.sourceBounds, w = b.right - b.left, h = b.bottom - b.top;
        if (o.componentSize !== depth) throw new Error("depth mismatch");
        const Arr = depth === 8 ? Uint8Array : depth === 16 ? Uint16Array : Float32Array;
        const a = new Arr(w * h * C);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const i = (y * w + x) * C, yy = y + b.top;
          a[i] = Math.round(max * ((x >> 4) & 1)) || (depth === 32 ? 0 : 0);
          a[i + 1] = depth === 32 ? 0.5 + yy / H * 3 : Math.round(max * yy / H);
          a[i + 2] = depth === 32 ? 0.25 : Math.round(max / 4);
          a[i + 3] = max;
        }
        return { imageData: { width: w, height: h, components: C, getData: async () => a, dispose() {} } };
      },
      createImageDataFromBuffer: async (buf, o) => ({ buf, ...o, dispose() {} }),
      putPixels: async (o) => { (written.puts = written.puts || []).push(o); }
    },
    core: { executeAsModal: async (fn) => fn({ isCancelled: false, reportProgress: (p) => { written.lastProgress = p; } }) },
    action: { batchPlay: async () => [] }
  };
  const logs = [];
  const store = settings ? { file: JSON.stringify(settings) } : {};
  let clickHandler = null;
  const ctx = {
    require: (m) => { if (m === "photoshop") return ps; if (m === "uxp") return { storage: { localFileSystem: { getDataFolder: async () => ({ getEntry: async () => { if (!store.file) throw new Error("none"); return { read: async () => store.file }; }, createFile: async () => ({ write: async (t) => { store.file = t; } }) }) } } }; throw new Error(m); },
    log: (m, e) => logs.push((e ? "ERR " : "") + m),
    describeError: (e) => (e && e.message) || String(e),
    showToast: (m) => logs.push("toast: " + m),
    equirectLatSpan: (w, h) => (half ? Math.PI / 2 : Math.min(Math.PI, Math.PI * 2 * h / w)),
    halfEquirect: half,
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
    document: {
      getElementById: (id) => (id === "skyDomeBtn" ? { addEventListener: (ev, fn) => { clickHandler = fn; } } : null),
      querySelectorAll: () => [], querySelector: () => null
    },
    console, Math, Date, JSON, Float32Array, Float64Array, Uint8Array, Uint16Array, Error, Number, String, parseInt, parseFloat
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../plugin/skylayout.js"), "utf8"), ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../plugin/skydome.js"), "utf8"), ctx);
  return new Promise((resolve) => {
    clickHandler();
    const t = setInterval(() => {
      if (logs.some((l) => l.startsWith("toast"))) { clearInterval(t); resolve({ logs, written }); }
    }, 20);
  });
}

(async () => {
  for (const [depth, W, H, half, s] of [[32, 1440, 720, false, { size: 2048 }], [16, 1440, 360, false, { size: 2048, layout: "disc", corners: "transparent" }], [8, 1440, 720, true, { size: 2048 }]]) {
    const { logs, written } = await run(depth, W, H, half, s);
    const puts = written.puts || [];
    const rows = puts.reduce((n, p) => n + p.imageData.height, 0);
    const p0 = puts[0].imageData;
    let bad = 0;
    for (const p of puts) for (const v of p.imageData.buf) if (!Number.isFinite(v)) bad++;
    console.log(`${depth}-bit ${W}x${H}${half ? " half" : ""}: doc "${written.doc.name}" ${written.doc.width}x${written.doc.height} depth ${written.doc.depth}, ` +
      `${puts.length} bands, ${rows} rows, ${p0.components}ch ${p0.buf.constructor.name}, non-finite ${bad}, progress ${written.lastProgress.value.toFixed(2)}`);
    logs.forEach((l) => console.log("   " + l));
  }
})();
