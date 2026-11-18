(function(){
  "use strict";

  // ---------- constants ----------
  const R = 500;
  // draw/annotation canvas size, also the base texture's size until Photoshop
  // pixels arrive (the base then follows the preview resolution, 2k/4k/full)
  const TEX_W = 2048, TEX_H = 1024;

  // ---------- DOM ----------
  const viewportCanvas = document.getElementById('viewport');
  const pinsLayer = document.getElementById('pins-layer');
  const modeLabel = document.getElementById('modeLabel');
  const coordsLabel = document.getElementById('coordsLabel');
  const fileInput = document.getElementById('fileInput');
  const labelModal = document.getElementById('labelModal');
  const labelInput = document.getElementById('labelInput');
  const syncDot = document.getElementById('syncDot');

  function logDebug(msg){
    console.log('[equirect-viewer]', msg);
  }
  logDebug('main.js starting');

  // ---------- three.js setup ----------
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(90, window.innerWidth/window.innerHeight, 0.5, 1200);
  camera.position.set(0,0,0);
  const renderer = new THREE.WebGLRenderer({ canvas: viewportCanvas, antialias:true, preserveDrawingBuffer:true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  // base panorama canvas/texture
  const baseCanvas = document.createElement('canvas');
  baseCanvas.width = TEX_W; baseCanvas.height = TEX_H;
  const baseCtx = baseCanvas.getContext('2d');
  const baseTexture = new THREE.CanvasTexture(baseCanvas);
  baseTexture.colorSpace = THREE.SRGBColorSpace || THREE.sRGBEncoding;
  baseTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();

  // draw/annotation overlay canvas/texture
  const drawCanvas = document.createElement('canvas');
  drawCanvas.width = TEX_W; drawCanvas.height = TEX_H;
  const drawCtx = drawCanvas.getContext('2d');
  const drawTexture = new THREE.CanvasTexture(drawCanvas);

  const baseGeo = new THREE.SphereGeometry(R, 64, 40);
  baseGeo.scale(-1, 1, 1);
  const baseMesh = new THREE.Mesh(baseGeo, new THREE.MeshBasicMaterial({ map: baseTexture }));
  scene.add(baseMesh);

  const overlayGeo = new THREE.SphereGeometry(R - 2, 64, 40);
  overlayGeo.scale(-1, 1, 1);
  const overlayMesh = new THREE.Mesh(overlayGeo, new THREE.MeshBasicMaterial({
    map: drawTexture, transparent: true, depthWrite: false
  }));
  scene.add(overlayMesh);

  // ---------- height fog (custom shader injection, base panorama only) ----------
  const fogUniforms = {
    fogColor:      { value: new THREE.Color('#b7c2cb') },
    fogDensity:    { value: 0.4 },
    fogHalfHeight: { value: 60 },
    fogFalloff:    { value: 1.0 },
    fogBaseHeight: { value: 0.0 },
    fogEnabled:    { value: 0.0 }
  };

  function injectHeightFog(material){
    material.onBeforeCompile = (shader) => {
      shader.uniforms.fogColor = fogUniforms.fogColor;
      shader.uniforms.fogDensity = fogUniforms.fogDensity;
      shader.uniforms.fogHalfHeight = fogUniforms.fogHalfHeight;
      shader.uniforms.fogFalloff = fogUniforms.fogFalloff;
      shader.uniforms.fogBaseHeight = fogUniforms.fogBaseHeight;
      shader.uniforms.fogEnabled = fogUniforms.fogEnabled;

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;');

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>',
          '#include <common>\n' +
          'varying vec3 vWorldPos;\n' +
          'uniform vec3 fogColor;\n' +
          'uniform float fogDensity;\n' +
          'uniform float fogHalfHeight;\n' +
          'uniform float fogFalloff;\n' +
          'uniform float fogBaseHeight;\n' +
          'uniform float fogEnabled;')
        .replace('#include <dithering_fragment>',
          '#include <dithering_fragment>\n' +
          'if(fogEnabled > 0.5){\n' +
          '  float dist = length(vWorldPos - cameraPosition);\n' +
          '  float h = max(vWorldPos.y - fogBaseHeight, 0.0);\n' +
          '  float halfH = max(fogHalfHeight, 0.001);\n' +
          '  float heightDensity = fogDensity * exp2(-h / halfH);\n' +
          '  float fogFactor = 1.0 - exp(-heightDensity * dist * fogFalloff * 0.001);\n' +
          '  fogFactor = clamp(fogFactor, 0.0, 1.0);\n' +
          '  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);\n' +
          '}');
    };
    material.needsUpdate = true;
  }
  injectHeightFog(baseMesh.material);

  // ---------- procedural default panorama (grid horizon test pattern) ----------
  function paintDefaultPanorama(){
    const g = baseCtx;
    const skyGrad = g.createLinearGradient(0,0,0,TEX_H*0.55);
    skyGrad.addColorStop(0, '#0d1b2a');
    skyGrad.addColorStop(1, '#3a5a78');
    g.fillStyle = skyGrad;
    g.fillRect(0,0,TEX_W,TEX_H*0.55);

    const groundGrad = g.createLinearGradient(0,TEX_H*0.55,0,TEX_H);
    groundGrad.addColorStop(0, '#2b2420');
    groundGrad.addColorStop(1, '#0e0b09');
    g.fillStyle = groundGrad;
    g.fillRect(0,TEX_H*0.55,TEX_W,TEX_H*0.45);

    g.strokeStyle = 'rgba(255,138,61,0.6)';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(0,TEX_H*0.55); g.lineTo(TEX_W,TEX_H*0.55); g.stroke();

    g.strokeStyle = 'rgba(255,255,255,0.10)';
    g.lineWidth = 1;
    for(let d=0; d<360; d+=30){
      const x = (d/360)*TEX_W;
      g.beginPath(); g.moveTo(x,0); g.lineTo(x,TEX_H); g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.font = '20px monospace';
      g.fillText(d + '°', x+6, 26);
    }
    for(let d=-60; d<=60; d+=30){
      const y = TEX_H/2 - (d/90)*(TEX_H/2);
      g.beginPath(); g.moveTo(0,y); g.lineTo(TEX_W,y); g.stroke();
    }
    g.beginPath();
    g.fillStyle = '#ffb877';
    g.arc(TEX_W*0.25, TEX_H*0.32, 46, 0, Math.PI*2);
    g.fill();

    baseTexture.needsUpdate = true;
  }
  paintDefaultPanorama();

  // ---------- half equirect mode ----------
  // A half equirect covers only the upper hemisphere (360 x 90deg, 4:1).
  // The last received image is kept in sourceCanvas, and baseCanvas (the
  // sphere texture) is always composed in full-equirect space from it: the
  // whole canvas in full mode, the top half in half mode with the lower
  // hemisphere filled flat. Keeping the texture/draw/pin space full-sphere
  // in both modes means raycasting, drawing and pins need no special-casing.
  const HALF_GROUND_COLOR = '#1a1a1a';
  let halfMode = false;
  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = TEX_W; sourceCanvas.height = TEX_H;
  const sourceCtx = sourceCanvas.getContext('2d');
  sourceCtx.drawImage(baseCanvas, 0, 0);

  function renderBase(){
    const W = baseCanvas.width, H = baseCanvas.height;
    baseCtx.clearRect(0,0,W,H);
    if(halfMode){
      baseCtx.drawImage(sourceCanvas, 0, 0, W, H/2);
      baseCtx.fillStyle = HALF_GROUND_COLOR;
      baseCtx.fillRect(0, H/2, W, H/2);
    } else {
      baseCtx.drawImage(sourceCanvas, 0, 0, W, H);
    }
    baseTexture.needsUpdate = true;
  }

  // The sphere texture follows the preview resolution (always 2:1).
  function setBaseSize(width, height){
    if(baseCanvas.width === width && baseCanvas.height === height) return;
    baseCanvas.width = width;
    baseCanvas.height = height;
    baseTexture.dispose(); // reallocate the GPU texture at the new size
  }

  function setSourceImage(drawable, width, height){
    hdrSource = null; // a loaded file is plain 8-bit, exposure/colour don't apply
    updateDisplayLabel();
    setBaseSize(TEX_W, TEX_H);
    if(sourceCanvas.width !== width || sourceCanvas.height !== height){
      sourceCanvas.width = width;
      sourceCanvas.height = height;
    }
    sourceCtx.clearRect(0,0,width,height);
    sourceCtx.drawImage(drawable, 0, 0, width, height);
    renderBase();
  }

  // fromHost: applying the document's saved settings, so don't echo back
  function setHalfMode(enabled, fromHost){
    halfMode = !!enabled;
    const halfBtn = document.getElementById('halfBtn');
    if(halfBtn) halfBtn.classList.toggle('active', halfMode);
    renderBase();
    // the plugin's Get/Put Zenith use the same mapping, and it saves this
    // in the document's metadata
    if(!fromHost) sendToHost({ type: 'set-half-mode', enabled: halfMode });
    logDebug('half equirect mode ' + (halfMode ? 'on' : 'off'));
  }

  // The drawing in the image's own space: the whole draw canvas in full
  // mode, only its upper hemisphere in half mode.
  function drawCanvasInImageSpace(){
    if(!halfMode) return { canvas: drawCanvas, width: TEX_W, height: TEX_H };
    const c = document.createElement('canvas');
    c.width = TEX_W; c.height = TEX_H/2;
    c.getContext('2d').drawImage(drawCanvas, 0, 0, TEX_W, TEX_H/2, 0, 0, TEX_W, TEX_H/2);
    return { canvas: c, width: TEX_W, height: TEX_H/2 };
  }

  // ---------- live pixels from the Photoshop host ----------
  // After a refresh the host (plugin/index.js) streams the document read as
  // 32-bit float and packed as RGBE (shared exponent, 4 bytes per pixel):
  // equirect-begin { width, height, docWidth, docHeight, linear }, then
  // equirect-chunk { offset, base64 } bands, then equirect-end. It's
  // kept here as-is, and exposure plus the display transform are applied
  // locally (displayHdrSource), so those controls never need a refetch.
  // linear: true for 32-bit documents; 8/16-bit values are already encoded.
  let hdrSource = null; // { rgbe, width, height, docWidth, docHeight, linear }
  let incoming = null; // the preview being streamed in

  // ---------- display settings (resolution, colour, exposure) ----------
  // Saved per document by the plugin. Resolution is fetched by the plugin;
  // colour and exposure only re-run the display transform below.
  const DEFAULT_PREVIEW = { resolution: '2k', color: 'srgb', exposure: 0 };
  let preview = { ...DEFAULT_PREVIEW };

  function srgbEncode(v){
    return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1/2.4) - 0.055;
  }
  function srgbDecode(v){
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  // RGBE (exponent << 8 | mantissa) -> 8-bit display value, rebuilt per
  // exposure/colour change, so the per-pixel pass is three table lookups.
  // Row 0 and mantissa 0 stay black.
  function buildDisplayLut(linear){
    const lut = new Uint8Array(65536);
    const gain = Math.pow(2, preview.exposure);
    const srgb = preview.color === 'srgb';
    for(let e = 1; e < 256; e++){
      const unit = Math.pow(2, e - 136);
      for(let m = 1; m < 256; m++){
        let v = (m + 0.5) * unit;
        if(srgb){
          // 8/16-bit values are already sRGB encoded: expose in linear light
          v = srgbEncode((linear ? v : srgbDecode(Math.min(v, 1))) * gain);
        } else {
          v *= gain; // raw: values as they are, no transform
        }
        lut[(e << 8) | m] = v >= 1 ? 255 : v <= 0 ? 0 : Math.round(v * 255);
      }
    }
    return lut;
  }

  let displayImageData = null;
  function ensureDisplayImageData(width, height){
    if(!displayImageData || displayImageData.width !== width || displayImageData.height !== height){
      displayImageData = new ImageData(width, height);
      displayImageData.data.fill(255); // alpha
    }
    return displayImageData.data;
  }

  // RGBE bytes [from, to) -> display RGBA at the same offsets
  function applyDisplayLut(lut, rgbe, out, from, to){
    for(let i = from; i < to; i += 4){
      const row = rgbe[i+3] << 8;
      out[i] = lut[row | rgbe[i]];
      out[i+1] = lut[row | rgbe[i+1]];
      out[i+2] = lut[row | rgbe[i+2]];
    }
  }

  function presentDisplayImage(width, height){
    if(sourceCanvas.width !== width || sourceCanvas.height !== height){
      sourceCanvas.width = width;
      sourceCanvas.height = height;
    }
    sourceCtx.putImageData(displayImageData, 0, 0);
    setBaseSize(width, Math.round(width / 2));
    renderBase();
  }

  function displayHdrSource(){
    if(!hdrSource) return;
    const { rgbe, width, height } = hdrSource;
    const start = performance.now();
    const out = ensureDisplayImageData(width, height);
    applyDisplayLut(buildDisplayLut(hdrSource.linear), rgbe, out, 0, rgbe.length);
    presentDisplayImage(width, height);
    logDebug(`display transform ${preview.color} ${preview.exposure} EV in ${(performance.now()-start).toFixed(0)}ms`);
  }

  // exposure drags fire faster than a 4k/full pass, so coalesce to one per frame
  let displayQueued = false;
  function queueDisplay(){
    if(displayQueued) return;
    displayQueued = true;
    requestAnimationFrame(()=>{ displayQueued = false; displayHdrSource(); });
  }

  function formatEv(v){
    return (v >= 0 ? '+' : '') + v.toFixed(1);
  }

  function updateDisplayLabel(){
    const el = document.getElementById('displayLabel');
    if(!el) return;
    let res = 'no PS pixels';
    if(hdrSource){
      res = `${hdrSource.width}x${hdrSource.height}`;
      if(hdrSource.docWidth && hdrSource.docWidth !== hdrSource.width) res += ` of ${hdrSource.docWidth}x${hdrSource.docHeight}`;
    }
    el.textContent = `${res} · ${preview.resolution.toUpperCase()} · ${preview.color === 'srgb' ? 'sRGB' : 'RAW'} · ${formatEv(preview.exposure)} EV`;
  }

  function syncDisplayControls(){
    document.querySelectorAll('#resolutionSeg .tbtn').forEach(b=> b.classList.toggle('active', b.dataset.value === preview.resolution));
    document.querySelectorAll('#colorSeg .tbtn').forEach(b=> b.classList.toggle('active', b.dataset.value === preview.color));
    document.getElementById('exposureSlider').value = preview.exposure;
    document.getElementById('exposureVal').textContent = formatEv(preview.exposure);
    updateDisplayLabel();
  }

  // fromHost: applying the document's saved settings, so don't echo back
  function setPreview(changes, fromHost){
    const prev = preview;
    preview = { ...DEFAULT_PREVIEW, ...preview, ...(changes || {}) };
    syncDisplayControls();
    if(preview.color !== prev.color || preview.exposure !== prev.exposure) queueDisplay();
    // the plugin saves it and refetches when the resolution changed
    if(!fromHost) sendToHost({ type: 'set-preview', preview });
  }

  function setSyncing(isSyncing){
    if (syncDot) syncDot.classList.toggle('syncing', !!isSyncing);
  }

  function base64ToUint8Array(base64){
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function uint8ArrayToBase64(bytes){
    const chunkSize = 8192;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function beginPhotoshopPixels(msg){
    logDebug(`receiving ${msg.width}x${msg.height} RGBE preview (document ${msg.docWidth}x${msg.docHeight})`);
    setSyncing(true);
    incoming = {
      rgbe: new Uint8Array(msg.width * msg.height * 4),
      width: msg.width, height: msg.height,
      docWidth: msg.docWidth, docHeight: msg.docHeight,
      linear: !!msg.linear, chunks: 0, start: performance.now(), decodeMs: 0
    };
    // each band is decoded and display-transformed as it lands, overlapping
    // the plugin's reading/encoding of the next one
    incoming.lut = buildDisplayLut(incoming.linear);
    incoming.lutFor = preview.color + preview.exposure;
    incoming.out = ensureDisplayImageData(msg.width, msg.height);
  }

  function receivePhotoshopChunk(msg){
    if(!incoming) return;
    const t = performance.now();
    const rgbe = incoming.rgbe;
    let length;
    if(typeof Uint8Array.fromBase64 === 'function'){ // native decoder, newer Chromium/WebKit
      const bytes = Uint8Array.fromBase64(msg.base64);
      rgbe.set(bytes, msg.offset);
      length = bytes.length;
    } else {
      const binary = atob(msg.base64);
      for(let i = 0, o = msg.offset; i < binary.length; i++, o++) rgbe[o] = binary.charCodeAt(i);
      length = binary.length;
    }
    applyDisplayLut(incoming.lut, rgbe, incoming.out, msg.offset, msg.offset + length);
    incoming.chunks++;
    incoming.decodeMs += performance.now() - t;
  }

  function endPhotoshopPixels(msg){
    if(!incoming) return;
    const src = incoming;
    incoming = null;
    try {
      if(src.chunks !== msg.chunks) logToHost(`preview: got ${src.chunks} of ${msg.chunks} chunks`);
      hdrSource = { rgbe: src.rgbe, width: src.width, height: src.height, docWidth: src.docWidth, docHeight: src.docHeight, linear: src.linear };
      const t = performance.now();
      // exposure/colour changed mid-stream: redo the whole transform
      if(src.lutFor !== preview.color + preview.exposure) applyDisplayLut(buildDisplayLut(src.linear), src.rgbe, src.out, 0, src.rgbe.length);
      presentDisplayImage(src.width, src.height);
      renderer.render(scene, camera); // upload the texture now so it's timed
      const presentMs = performance.now() - t;
      logToHost(`viewer: ${src.width}x${src.height} streamed over ${(t - src.start).toFixed(0)}ms (decode+transform ${src.decodeMs.toFixed(0)}ms), canvas+texture upload ${presentMs.toFixed(0)}ms`);
      updateDisplayLabel();
      logDebug('texture updated OK');
    } catch (err) {
      logToHost('ERROR applying pixel update: ' + (err && err.message ? err.message : String(err)));
    }
    setSyncing(false);
  }

  function sendToHost(data){
    if (window.uxpHost && window.uxpHost.postMessage){
      try {
        window.uxpHost.postMessage(data);
      } catch (err) {
        logDebug('sendToHost failed: ' + err.message);
      }
    } else {
      logDebug('cannot send to host, window.uxpHost.postMessage unavailable');
    }
  }

  // Relays a line into the panel's own Log window (flyout menu -> Show Log),
  // so diagnostics land somewhere copyable without needing to attach
  // DevTools to this webview's separate JS context.
  function logToHost(msg){
    logDebug(msg);
    sendToHost({ type: 'webview-log', text: String(msg) });
  }

  // ---------- toast (sent by the plugin, e.g. after an EXR export) ----------
  const toastEl = document.getElementById('toast');
  let toastTimer = null;
  let toastFolder = null;
  function hideToast(){
    toastEl.classList.remove('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = null;
  }
  function showToast(text, folderPath, ms){
    document.getElementById('toastMsg').textContent = text;
    toastFolder = folderPath || null;
    document.getElementById('toastOpen').style.display = toastFolder ? '' : 'none';
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, ms || 7000);
  }
  // hovering keeps it up; leaving restarts a short timer
  toastEl.addEventListener('mouseenter', ()=>{ if (toastTimer) clearTimeout(toastTimer); toastTimer = null; });
  toastEl.addEventListener('mouseleave', ()=>{ if (toastEl.classList.contains('show')) toastTimer = setTimeout(hideToast, 2500); });
  document.getElementById('toastOpen').addEventListener('click', ()=>{
    if (toastFolder) sendToHost({ type: 'open-folder', path: toastFolder });
  });
  document.getElementById('toastClose').addEventListener('click', hideToast);

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'equirect-begin'){
      beginPhotoshopPixels(msg);
    } else if (msg.type === 'equirect-chunk'){
      receivePhotoshopChunk(msg);
    } else if (msg.type === 'equirect-end'){
      endPhotoshopPixels(msg);
    } else if (msg.type === 'equirect-abort'){
      incoming = null;
      setSyncing(false);
    } else if (msg.type === 'equirect-syncing'){
      setSyncing(true);
    } else if (msg.type === 'mooncloud-key'){
      if (msg.apiKey) mcValidateAndShow(msg.apiKey);
      else mcShowConnectState();
    } else if (msg.type === 'open-mooncloud-modal'){
      openMooncloudModal();
    } else if (msg.type === 'apply-doc-settings'){
      // document switched (or opened): show its saved Half/Fog state
      setHalfMode(!!msg.halfEquirect, true);
      applyFogSettings(msg.fog);
      setPreview(msg.preview || DEFAULT_PREVIEW, true);
    } else if (msg.type === 'toast'){
      showToast(msg.text, msg.folderPath, msg.ms);
    } else if (msg.type === 'toggle-ui'){
      document.body.classList.toggle('ui-hidden', !!msg.hidden);
    }
  });

  logDebug('window.uxpHost present: ' + !!window.uxpHost);
  // lets the plugin cap the "full" preview resolution to what WebGL can hold
  sendToHost({ type: 'viewer-caps', maxTextureSize: renderer.capabilities.maxTextureSize });
  if (window.uxpHost && window.uxpHost.postMessage){
    try {
      window.uxpHost.postMessage('viewer-ready');
      logDebug('sent viewer-ready string message');
    } catch (err) {
      logDebug('postMessage(string) threw: ' + err.message);
    }
  } else {
    logDebug('window.uxpHost.postMessage not available');
  }

  // ---------- look controls ----------
  let mode = 'look';
  let lon = 0, lat = 0;
  let isPointerDown = false, dragStartX=0, dragStartY=0, dragStartLon=0, dragStartLat=0;
  let movedDuringPress = false;
  let pressLooks = false; // this press orbits the view: Look mode, or a middle-button drag in any mode

  function setMode(m){
    mode = m;
    document.querySelectorAll('.tbtn[data-mode]').forEach(b=>{
      b.classList.toggle('active', b.dataset.mode === m);
    });
    viewportCanvas.classList.remove('mode-draw','mode-erase','mode-annotate');
    if(m==='draw') viewportCanvas.classList.add('mode-draw');
    if(m==='erase') viewportCanvas.classList.add('mode-erase');
    if(m==='annotate') viewportCanvas.classList.add('mode-annotate');
    modeLabel.textContent = m.toUpperCase();

    // picking a mode is a natural "done with this popover" action
    const annotatePanel = document.getElementById('annotatePanel');
    const annotateBtn = document.getElementById('annotateBtn');
    if(annotatePanel && !annotatePanel.hidden){
      annotatePanel.hidden = true;
      if(annotateBtn) annotateBtn.classList.remove('active');
    }
  }
  setMode('look');

  // ---------- raycasting helpers ----------
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function getIntersection(clientX, clientY){
    const rect = viewportCanvas.getBoundingClientRect();
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObject(overlayMesh, false);
    return hits.length ? hits[0] : null;
  }

  // ---------- drawing ----------
  let strokes = [];
  let currentStroke = null;

  function uvToPixel(uv){
    return { x: uv.x * TEX_W, y: (1 - uv.y) * TEX_H };
  }

  function applyStrokeStyle(stroke){
    drawCtx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
    drawCtx.strokeStyle = stroke.color;
    drawCtx.lineWidth = stroke.size;
    drawCtx.lineCap = 'round';
    drawCtx.lineJoin = 'round';
  }

  function drawSegmentLine(a, b, stroke){
    applyStrokeStyle(stroke);
    drawCtx.beginPath();
    drawCtx.moveTo(a.x, a.y);
    drawCtx.lineTo(b.x, b.y);
    drawCtx.stroke();
  }

  function drawDot(p, stroke){
    applyStrokeStyle(stroke);
    drawCtx.beginPath();
    drawCtx.arc(p.x, p.y, stroke.size/2, 0, Math.PI*2);
    drawCtx.fillStyle = stroke.color;
    drawCtx.fill();
  }

  function replayAllStrokes(){
    drawCtx.clearRect(0,0,TEX_W,TEX_H);
    for(const stroke of strokes){
      for(const seg of stroke.segments){
        if(seg.length === 1){ drawDot(seg[0], stroke); continue; }
        for(let i=1;i<seg.length;i++){ drawSegmentLine(seg[i-1], seg[i], stroke); }
      }
    }
    drawCtx.globalCompositeOperation = 'source-over';
    drawTexture.needsUpdate = true;
  }

  function handleDrawPoint(clientX, clientY){
    const hit = getIntersection(clientX, clientY);
    if(!hit || !hit.uv) return;
    const p = uvToPixel(hit.uv);
    const segs = currentStroke.segments;
    const seg = segs[segs.length-1];
    if(seg.length === 0){
      seg.push(p);
      drawDot(p, currentStroke);
    } else {
      const prev = seg[seg.length-1];
      if(Math.abs(p.x - prev.x) > TEX_W*0.5){
        segs.push([p]);
        drawDot(p, currentStroke);
      } else {
        seg.push(p);
        drawSegmentLine(prev, p, currentStroke);
      }
    }
    drawCtx.globalCompositeOperation = 'source-over';
    drawTexture.needsUpdate = true;
  }

  function undo(){
    if(strokes.length === 0) return;
    strokes.pop();
    replayAllStrokes();
  }

  function clearDrawing(){
    strokes = [];
    drawCtx.clearRect(0,0,TEX_W,TEX_H);
    drawTexture.needsUpdate = true;
  }

  // ---------- annotations ----------
  let annotations = [];
  let pendingAnnotation = null;

  function worldDirFromEvent(clientX, clientY){
    const hit = getIntersection(clientX, clientY);
    if(!hit) return null;
    return hit.point.clone().normalize();
  }

  function showLabelModal(clientX, clientY, dir){
    pendingAnnotation = { dir };
    labelModal.hidden = false;
    const rect = document.getElementById('app').getBoundingClientRect();
    let left = clientX - rect.left + 14;
    let top = clientY - rect.top + 14;
    left = Math.min(left, rect.width - 240);
    top = Math.min(top, rect.height - 60);
    labelModal.style.left = left + 'px';
    labelModal.style.top = top + 'px';
    labelInput.value = '';
    setTimeout(()=>labelInput.focus(), 0);
  }

  function hideLabelModal(){
    labelModal.hidden = true;
    pendingAnnotation = null;
  }

  function commitAnnotation(){
    if(!pendingAnnotation) return;
    const text = labelInput.value.trim();
    hideLabelModal();
    if(!text) return;
    createPin(pendingAnnotation.dir, text);
  }

  function createPin(dir, text){
    const el = document.createElement('div');
    el.className = 'pin';
    el.innerHTML = '<div class="dot"></div><div class="label"><span class="txt"></span><button title="Remove">✕</button></div>';
    el.querySelector('.txt').textContent = text;
    pinsLayer.appendChild(el);
    const rec = { dir, text, el };
    el.querySelector('button').addEventListener('click', (ev)=>{
      ev.stopPropagation();
      el.remove();
      annotations = annotations.filter(a => a !== rec);
    });
    annotations.push(rec);
  }

  function clearPins(){
    annotations.forEach(a => a.el.remove());
    annotations = [];
  }

  function updatePins(){
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    const w = window.innerWidth, h = window.innerHeight;
    for(const a of annotations){
      const worldPos = a.dir.clone().multiplyScalar(R - 8);
      const toPoint = worldPos.clone().sub(camera.position).normalize();
      if(toPoint.dot(camDir) < 0.08){ a.el.style.display = 'none'; continue; }
      const proj = worldPos.clone().project(camera);
      const x = (proj.x * 0.5 + 0.5) * w;
      const y = (1 - (proj.y * 0.5 + 0.5)) * h;
      a.el.style.display = 'flex';
      a.el.style.left = x + 'px';
      a.el.style.top = y + 'px';
    }
  }

  // ---------- pointer events ----------
  let dragThreshold = 5;

  viewportCanvas.addEventListener('pointerdown', (e)=>{
    if(!labelModal.hidden) return;
    isPointerDown = true;
    movedDuringPress = false;
    dragStartX = e.clientX; dragStartY = e.clientY;
    dragStartLon = lon; dragStartLat = lat;
    viewportCanvas.setPointerCapture(e.pointerId);
    pressLooks = mode === 'look' || e.button === 1;

    if(pressLooks){
      if(e.button === 1) e.preventDefault(); // no autoscroll
      viewportCanvas.classList.add('dragging');
    } else if(mode === 'draw' || mode === 'erase'){
      currentStroke = {
        color: document.getElementById('colorPicker').value,
        size: parseInt(document.getElementById('sizeSlider').value, 10),
        erase: mode === 'erase',
        segments: [[]]
      };
      strokes.push(currentStroke);
      handleDrawPoint(e.clientX, e.clientY);
    }
  });
  // stop the browser's middle-click autoscroll/paste over the viewport
  viewportCanvas.addEventListener('mousedown', (e)=>{ if(e.button === 1) e.preventDefault(); });
  viewportCanvas.addEventListener('auxclick', (e)=>{ if(e.button === 1) e.preventDefault(); });

  viewportCanvas.addEventListener('pointermove', (e)=>{
    if(!isPointerDown) return;
    const dx = e.clientX - dragStartX, dy = e.clientY - dragStartY;
    if(Math.abs(dx) > dragThreshold || Math.abs(dy) > dragThreshold) movedDuringPress = true;

    if(pressLooks){
      lon = dragStartLon - dx * 0.12;
      lat = dragStartLat + dy * 0.12;
      lat = Math.max(-85, Math.min(85, lat));
    } else if((mode === 'draw' || mode === 'erase') && currentStroke){
      handleDrawPoint(e.clientX, e.clientY);
    }
  });

  function endPress(e){
    if(!isPointerDown) return;
    isPointerDown = false;
    viewportCanvas.classList.remove('dragging');

    if(mode === 'annotate' && !pressLooks && !movedDuringPress){
      const dir = worldDirFromEvent(e.clientX, e.clientY);
      if(dir) showLabelModal(e.clientX, e.clientY, dir);
    }
    currentStroke = null;
  }
  viewportCanvas.addEventListener('pointerup', endPress);
  viewportCanvas.addEventListener('pointercancel', endPress);

  viewportCanvas.addEventListener('wheel', (e)=>{
    e.preventDefault();
    camera.fov = Math.max(28, Math.min(100, camera.fov + e.deltaY * 0.04));
    camera.updateProjectionMatrix();
  }, { passive:false });

  // ---------- toolbar wiring ----------
  document.querySelectorAll('.tbtn[data-mode]').forEach(btn=>{
    btn.addEventListener('click', ()=> setMode(btn.dataset.mode));
  });
  document.getElementById('undoBtn').addEventListener('click', undo);
  document.getElementById('clearDrawBtn').addEventListener('click', clearDrawing);
  document.getElementById('clearPinsBtn').addEventListener('click', clearPins);
  document.getElementById('sizeSlider').addEventListener('input', (e)=>{
    document.getElementById('sizeLabel').textContent = e.target.value;
  });

  document.getElementById('pushLayerBtn').addEventListener('click', async ()=>{
    const btn = document.getElementById('pushLayerBtn');
    btn.disabled = true;
    try {
      // Photoshop's Place appears to trim a transparent PNG down to its
      // opaque content's bounding box, which loses the full-canvas framing
      // we rely on to scale/position the layer correctly (and splits any
      // stroke that wraps the equirect seam). Export a copy with a handful
      // of near-invisible corner markers so the "content" always spans the
      // full 2048x1024 canvas.
      // In half mode only the upper hemisphere is sent, matching the
      // document's own 4:1 framing.
      const src = drawCanvasInImageSpace();
      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = src.width;
      exportCanvas.height = src.height;
      const exportCtx = exportCanvas.getContext('2d');
      exportCtx.drawImage(src.canvas, 0, 0);
      exportCtx.fillStyle = 'rgba(0,0,0,0.004)'; // ~alpha 1/255, imperceptible
      exportCtx.fillRect(0, 0, 1, 1);
      exportCtx.fillRect(src.width - 1, 0, 1, 1);
      exportCtx.fillRect(0, src.height - 1, 1, 1);
      exportCtx.fillRect(src.width - 1, src.height - 1, 1, 1);

      const blob = await new Promise((resolve, reject)=>{
        exportCanvas.toBlob((b)=> b ? resolve(b) : reject(new Error('canvas.toBlob returned null')), 'image/png');
      });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const base64 = uint8ArrayToBase64(bytes);
      logToHost(`pushing draw layer to Photoshop, ${(bytes.length/1024/1024).toFixed(2)} MB PNG`);
      sendToHost({ type: 'push-draw-layer', base64 });
    } catch (err) {
      logToHost('failed to capture draw layer: ' + err.message);
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- annotate popup wiring ----------
  const annotateBtn = document.getElementById('annotateBtn');
  const annotatePanel = document.getElementById('annotatePanel');
  annotateBtn.addEventListener('click', (e)=>{
    e.stopPropagation();
    annotatePanel.hidden = !annotatePanel.hidden;
    annotateBtn.classList.toggle('active', !annotatePanel.hidden);
  });
  document.addEventListener('click', (e)=>{
    if(!annotatePanel.hidden && !document.getElementById('annotateGroup').contains(e.target)){
      annotatePanel.hidden = true;
      annotateBtn.classList.remove('active');
    }
  });
  annotatePanel.addEventListener('click', (e)=> e.stopPropagation());

  // ---------- file popup wiring ----------
  const fileBtn = document.getElementById('fileBtn');
  const filePanel = document.getElementById('filePanel');
  fileBtn.addEventListener('click', (e)=>{
    e.stopPropagation();
    filePanel.hidden = !filePanel.hidden;
    fileBtn.classList.toggle('active', !filePanel.hidden);
  });
  document.addEventListener('click', (e)=>{
    if(!filePanel.hidden && !document.getElementById('fileGroup').contains(e.target)){
      filePanel.hidden = true;
      fileBtn.classList.remove('active');
    }
  });
  // unlike fog/annotate, file actions are one-shot, so clicking any of them
  // should close the popover afterward rather than requiring a second click
  // outside — no stopPropagation here, letting the click bubble to this
  // delegated handler after the button's own action has run.
  filePanel.addEventListener('click', (e)=>{
    if(e.target.closest('.tbtn')){
      filePanel.hidden = true;
      fileBtn.classList.remove('active');
    }
  });

  // ---------- fog popup wiring ----------
  const fogBtn = document.getElementById('fogBtn');
  const fogPanel = document.getElementById('fogPanel');
  fogBtn.addEventListener('click', (e)=>{
    e.stopPropagation();
    fogPanel.hidden = !fogPanel.hidden;
    fogBtn.classList.toggle('active', !fogPanel.hidden);
  });
  document.addEventListener('click', (e)=>{
    if(!fogPanel.hidden && !document.getElementById('fogGroup').contains(e.target)){
      fogPanel.hidden = true;
      fogBtn.classList.remove('active');
    }
  });
  fogPanel.addEventListener('click', (e)=> e.stopPropagation());

  function bindFogRange(id, valId, uniform, fmt){
    const el = document.getElementById(id);
    const valEl = document.getElementById(valId);
    el.addEventListener('input', ()=>{
      const v = parseFloat(el.value);
      fogUniforms[uniform].value = v;
      valEl.textContent = fmt ? v.toFixed(fmt) : v;
    });
  }
  bindFogRange('fogDensity', 'fogDensityVal', 'fogDensity', 2);
  bindFogRange('fogHalfHeight', 'fogHalfHeightVal', 'fogHalfHeight', 0);
  bindFogRange('fogFalloff', 'fogFalloffVal', 'fogFalloff', 2);
  bindFogRange('fogBaseHeight', 'fogBaseHeightVal', 'fogBaseHeight', 0);

  document.getElementById('fogEnabled').addEventListener('change', (e)=>{
    fogUniforms.fogEnabled.value = e.target.checked ? 1.0 : 0.0;
  });
  document.getElementById('fogColor').addEventListener('input', (e)=>{
    fogUniforms.fogColor.value.set(e.target.value);
  });

  // Fog settings are saved per document by the plugin (in its metadata).
  // Any user change is reported (the plugin debounces the save); settings
  // applied from the plugin set the controls without reporting back.
  const FOG_RANGES = [
    ['fogDensity', 'fogDensityVal', 2],
    ['fogHalfHeight', 'fogHalfHeightVal', 0],
    ['fogFalloff', 'fogFalloffVal', 2],
    ['fogBaseHeight', 'fogBaseHeightVal', 0]
  ];
  function currentFogSettings(){
    const f = { enabled: document.getElementById('fogEnabled').checked, color: document.getElementById('fogColor').value };
    FOG_RANGES.forEach(([id])=>{ f[id] = parseFloat(document.getElementById(id).value); });
    return f;
  }
  const FOG_DEFAULTS = currentFogSettings(); // the HTML's initial values
  function applyFogSettings(f){
    if(!f) f = FOG_DEFAULTS; // document with nothing saved
    const en = document.getElementById('fogEnabled');
    en.checked = !!f.enabled;
    fogUniforms.fogEnabled.value = en.checked ? 1.0 : 0.0;
    if(typeof f.color === 'string'){
      document.getElementById('fogColor').value = f.color;
      fogUniforms.fogColor.value.set(f.color);
    }
    FOG_RANGES.forEach(([id, valId, fmt])=>{
      if(typeof f[id] !== 'number') return;
      document.getElementById(id).value = f[id];
      fogUniforms[id].value = f[id];
      document.getElementById(valId).textContent = fmt ? f[id].toFixed(fmt) : f[id];
    });
  }
  document.getElementById('fogPanel').addEventListener('input', ()=> sendToHost({ type: 'set-fog', fog: currentFogSettings() }));
  document.getElementById('fogPanel').addEventListener('change', ()=> sendToHost({ type: 'set-fog', fog: currentFogSettings() }));

  // ---------- display popup wiring ----------
  const displayBtn = document.getElementById('displayBtn');
  const displayPanel = document.getElementById('displayPanel');
  displayBtn.addEventListener('click', (e)=>{
    e.stopPropagation();
    displayPanel.hidden = !displayPanel.hidden;
    displayBtn.classList.toggle('active', !displayPanel.hidden);
  });
  document.addEventListener('click', (e)=>{
    if(!displayPanel.hidden && !document.getElementById('displayGroup').contains(e.target)){
      displayPanel.hidden = true;
      displayBtn.classList.remove('active');
    }
  });
  displayPanel.addEventListener('click', (e)=> e.stopPropagation());

  document.querySelectorAll('#resolutionSeg .tbtn').forEach(b=>{
    b.addEventListener('click', ()=>{
      if(b.dataset.value === preview.resolution) return;
      setPreview({ resolution: b.dataset.value });
    });
  });
  document.querySelectorAll('#colorSeg .tbtn').forEach(b=>{
    b.addEventListener('click', ()=> setPreview({ color: b.dataset.value }));
  });
  const exposureSlider = document.getElementById('exposureSlider');
  exposureSlider.addEventListener('input', ()=> setPreview({ exposure: parseFloat(exposureSlider.value) }));
  exposureSlider.addEventListener('dblclick', ()=> setPreview({ exposure: 0 }));
  document.getElementById('exposureReset').addEventListener('click', ()=> setPreview({ exposure: 0 }));
  syncDisplayControls();

  document.getElementById('loadBtn').addEventListener('click', ()=> fileInput.click());
  fileInput.addEventListener('change', (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    const img = new Image();
    img.onload = ()=>{
      // A loaded file that's about 4:1 is a half equirect; switch modes to match.
      setHalfMode(img.width / img.height > 3);
      setSourceImage(img, TEX_W, halfMode ? TEX_H/2 : TEX_H);
    };
    img.src = URL.createObjectURL(file);
  });

  document.getElementById('snapBtn').addEventListener('click', ()=>{
    renderer.render(scene, camera);
    viewportCanvas.toBlob((blob)=>{
      if(!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `panorama-snap-${Date.now()}.png`;
      a.click();
    }, 'image/png');
  });

  document.getElementById('exportPngBtn').addEventListener('click', ()=>{
    // exported in the image's own framing (4:1 in half mode)
    const draw = drawCanvasInImageSpace();
    const out = document.createElement('canvas');
    out.width = draw.width; out.height = draw.height;
    const octx = out.getContext('2d');
    octx.drawImage(sourceCanvas, 0, 0, draw.width, draw.height);
    octx.drawImage(draw.canvas, 0, 0);
    out.toBlob((blob)=>{
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'panorama-annotated.png';
      a.click();
    });
  });

  document.getElementById('exportJsonBtn').addEventListener('click', ()=>{
    const data = annotations.map(a=>{
      const lonDeg = THREE.MathUtils.radToDeg(Math.atan2(a.dir.z, a.dir.x));
      const latDeg = THREE.MathUtils.radToDeg(Math.asin(Math.max(-1,Math.min(1,a.dir.y))));
      return { text: a.text, lon: +lonDeg.toFixed(2), lat: +latDeg.toFixed(2) };
    });
    const blob = new Blob([JSON.stringify({ annotations: data }, null, 2)], { type:'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'annotations.json';
    a.click();
  });

  // ---------- refresh ----------
  document.getElementById('refreshBtn').addEventListener('click', ()=>{
    logDebug('refresh button clicked, sending request-refresh to host');
    sendToHost({ type: 'request-refresh' });
  });

  document.getElementById('halfBtn').addEventListener('click', ()=> setHalfMode(!halfMode));

  // ---------- live mode ----------
  let liveMode = false;
  const liveBtn = document.getElementById('liveBtn');
  liveBtn.addEventListener('click', ()=>{
    liveMode = !liveMode;
    liveBtn.classList.toggle('active', liveMode);
    liveBtn.title = liveMode
      ? 'Live mode: on — auto-refreshing on every Photoshop edit'
      : 'Live mode: auto-refresh on every Photoshop edit';
    sendToHost({ type: 'set-live-mode', enabled: liveMode });
  });

  // ---------- mooncloud review ----------
  // fetch/FormData/File/canvas.toBlob all work fine in this webview, so the
  // network calls stay here (per the API doc's note that CORS is set up for
  // calling straight from the browser/webview). localStorage, however,
  // throws "Storage is not supported" inside this webview, so the API key
  // is persisted via the panel's file-based storage instead, relayed by
  // message (mooncloud-load-key / mooncloud-save-key / mooncloud-clear-key).
  const MC_BASE = 'https://mooncloudstudios.com/api/public/v1';
  let mcApiKey = null;

  const mcOverlay = document.getElementById('mcOverlay');
  const mcConnectState = document.getElementById('mcConnectState');
  const mcPublishState = document.getElementById('mcPublishState');
  const mcApiKeyInput = document.getElementById('mcApiKeyInput');
  const mcConnectBtn = document.getElementById('mcConnectBtn');
  const mcConnectStatus = document.getElementById('mcConnectStatus');
  const mcIdentity = document.getElementById('mcIdentity');
  const mcDisconnectBtn = document.getElementById('mcDisconnectBtn');
  const mcProjectSelect = document.getElementById('mcProjectSelect');
  const mcAssetSelect = document.getElementById('mcAssetSelect');
  const mcNotesInput = document.getElementById('mcNotesInput');
  const mcPublishBtn = document.getElementById('mcPublishBtn');
  const mcPublishStatus = document.getElementById('mcPublishStatus');

  const mcState = { isStudio: false, projects: [], assets: [] };

  function escapeHtmlMc(s){
    return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  }

  function mcSetStatus(el, msg, kind){
    el.textContent = msg || '';
    el.className = 'mcStatus' + (kind ? ' ' + kind : '');
  }

  async function mcParseError(res){
    const body = await res.json().catch(()=>({}));
    return new Error(body.error || `HTTP ${res.status}`);
  }

  // Wraps fetch() so a low-level network failure (blocked by CSP/CORS, DNS,
  // offline, etc.) gets logged with full detail to the panel's Log window
  // before rethrowing the (deliberately vague, per the fetch spec) error
  // the UI shows the user.
  async function mcFetchRaw(url, options){
    logToHost(`mooncloud: fetching ${url}`);
    try {
      const res = await fetch(url, options);
      logToHost(`mooncloud: response ${res.status} ${res.statusText} for ${url}`);
      return res;
    } catch (err) {
      logToHost(`mooncloud: fetch threw for ${url} — name=${err.name} message=${err.message}`);
      throw err;
    }
  }

  async function mcValidateKey(apiKey){
    const res = await mcFetchRaw(`${MC_BASE}/me`, { headers: { Authorization: `Bearer ${apiKey}` } });
    if(!res.ok) throw await mcParseError(res);
    return res.json();
  }

  async function mcFetch(path){
    if(!mcApiKey) throw new Error('Not connected to Mooncloud');
    const res = await mcFetchRaw(`${MC_BASE}${path}`, { headers: { Authorization: `Bearer ${mcApiKey}` } });
    if(!res.ok) throw await mcParseError(res);
    return res.json();
  }

  function mcCaptureCurrentViewPng(){
    return new Promise((resolve, reject) => {
      baseCanvas.toBlob((blob) => {
        if(blob) resolve(blob); else reject(new Error('canvas.toBlob returned null'));
      }, 'image/png');
    });
  }

  async function mcPublish(assetId, notes){
    if(!mcApiKey) throw new Error('Not connected to Mooncloud');

    const blob = await mcCaptureCurrentViewPng();
    logDebug(`mooncloud: PNG encoded, ${(blob.size/1024/1024).toFixed(2)} MB, uploading…`);

    const form = new FormData();
    form.append('asset_id', assetId);
    if(notes) form.append('notes', notes);
    form.append('file', new File([blob], 'equirect-preview.png', { type: 'image/png' }));

    const res = await mcFetchRaw(`${MC_BASE}/versions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mcApiKey}` },
      body: form
    });
    if(!res.ok) throw await mcParseError(res);
    const data = await res.json();
    return data.version;
  }

  function mcShowPublishState(displayName, isStudio){
    mcState.isStudio = isStudio;
    mcConnectState.hidden = true;
    mcPublishState.hidden = false;
    mcIdentity.textContent = displayName + (isStudio ? '' : ' (read-only)');
    mcConnectBtn.disabled = false;
    mcApiKeyInput.value = '';
    mcPublishBtn.disabled = !isStudio;
    mcSetStatus(mcPublishStatus, isStudio ? '' : 'This key is client/read-only — uploads require a studio account.', isStudio ? '' : 'error');

    mcProjectSelect.innerHTML = '<option>Loading projects…</option>';
    mcFetch('/projects').then((data) => {
      mcState.projects = data.projects || [];
      mcProjectSelect.innerHTML = mcState.projects.length
        ? mcState.projects.map(p => `<option value="${p.id}">${escapeHtmlMc(p.code ? `${p.code} — ${p.title}` : p.title)}</option>`).join('')
        : '<option value="">No projects</option>';
      if(mcState.projects.length){
        mcProjectSelect.dispatchEvent(new Event('change'));
      } else {
        mcAssetSelect.innerHTML = '<option value="">No projects</option>';
      }
    }).catch((err) => {
      mcProjectSelect.innerHTML = '<option value="">Failed to load</option>';
      mcSetStatus(mcPublishStatus, err.message, 'error');
    });
  }

  function mcShowConnectState(errorMsg){
    mcState.isStudio = false;
    mcPublishState.hidden = true;
    mcConnectState.hidden = false;
    mcConnectBtn.disabled = false;
    mcSetStatus(mcConnectStatus, errorMsg || '', errorMsg ? 'error' : '');
  }

  function mcValidateAndShow(apiKey){
    mcValidateKey(apiKey)
      .then((me) => {
        mcApiKey = apiKey;
        mcShowPublishState(me.display_name, me.is_studio);
      })
      .catch((err) => {
        mcApiKey = null;
        sendToHost({ type: 'mooncloud-clear-key' });
        mcShowConnectState('Saved key is no longer valid: ' + err.message);
      });
  }

  function openMooncloudModal(){
    mcOverlay.hidden = false;
    if(mcApiKey){
      mcSetStatus(mcConnectStatus, 'Checking connection…');
      mcValidateAndShow(mcApiKey);
    } else {
      mcSetStatus(mcConnectStatus, 'Loading saved key…');
      sendToHost({ type: 'mooncloud-load-key' });
    }
  }

  function closeMooncloudModal(){
    mcOverlay.hidden = true;
  }

  document.getElementById('mooncloudBtn').addEventListener('click', openMooncloudModal);
  document.getElementById('mcCloseBtn').addEventListener('click', closeMooncloudModal);
  mcOverlay.addEventListener('click', (e)=>{ if(e.target === mcOverlay) closeMooncloudModal(); });

  mcConnectBtn.addEventListener('click', async ()=>{
    const key = mcApiKeyInput.value.trim();
    if(!key){ mcSetStatus(mcConnectStatus, 'Enter an API key first.', 'error'); return; }
    mcConnectBtn.disabled = true;
    mcSetStatus(mcConnectStatus, 'Connecting…');
    try {
      const me = await mcValidateKey(key);
      mcApiKey = key;
      sendToHost({ type: 'mooncloud-save-key', apiKey: key });
      mcShowPublishState(me.display_name, me.is_studio);
    } catch (err) {
      mcConnectBtn.disabled = false;
      mcSetStatus(mcConnectStatus, err.message, 'error');
    }
  });

  mcApiKeyInput.addEventListener('keydown', (e)=>{
    if(e.key === 'Enter') mcConnectBtn.click();
  });

  mcDisconnectBtn.addEventListener('click', ()=>{
    mcApiKey = null;
    sendToHost({ type: 'mooncloud-clear-key' });
    mcShowConnectState();
  });

  mcProjectSelect.addEventListener('change', ()=>{
    const projectId = mcProjectSelect.value;
    mcAssetSelect.innerHTML = '<option>Loading…</option>';
    mcAssetSelect.disabled = true;
    if(!projectId) return;
    mcFetch(`/assets?project_id=${encodeURIComponent(projectId)}`).then((data) => {
      mcState.assets = data.assets || [];
      mcAssetSelect.disabled = false;
      mcAssetSelect.innerHTML = mcState.assets.length
        ? mcState.assets.map(a => `<option value="${a.id}">${escapeHtmlMc(a.internal_name || a.name)} (${a.status})</option>`).join('')
        : '<option value="">No assets</option>';
    }).catch((err) => {
      mcAssetSelect.innerHTML = '<option value="">Failed to load</option>';
      mcSetStatus(mcPublishStatus, err.message, 'error');
    });
  });

  mcPublishBtn.addEventListener('click', async ()=>{
    const assetId = mcAssetSelect.value;
    const projectId = mcProjectSelect.value;
    if(!assetId){ mcSetStatus(mcPublishStatus, 'Pick an asset first.', 'error'); return; }
    mcPublishBtn.disabled = true;
    mcSetStatus(mcPublishStatus, 'Encoding & uploading current preview…');
    try {
      const version = await mcPublish(assetId, mcNotesInput.value.trim());
      mcPublishBtn.disabled = !mcState.isStudio;
      const link = `https://mooncloudstudios.com/projects/${projectId}/assets/${assetId}`;
      mcPublishStatus.innerHTML = `Published v${version.version_number}. <a href="#" id="mcOpenLink">Open in Mooncloud</a>`;
      mcPublishStatus.className = 'mcStatus success';
      // target="_blank" doesn't reliably open the system browser from inside
      // a UXP webview, so route it through the panel's shell.openExternal.
      document.getElementById('mcOpenLink').addEventListener('click', (e) => {
        e.preventDefault();
        sendToHost({ type: 'open-external', url: link });
      });
    } catch (err) {
      mcPublishBtn.disabled = !mcState.isStudio;
      mcSetStatus(mcPublishStatus, err.message, 'error');
    }
  });

  labelModal.querySelector('#labelSave').addEventListener('click', commitAnnotation);
  labelModal.querySelector('#labelCancel').addEventListener('click', hideLabelModal);
  labelInput.addEventListener('keydown', (e)=>{
    if(e.key === 'Enter') commitAnnotation();
    if(e.key === 'Escape') hideLabelModal();
  });

  // ---------- keyboard shortcuts ----------
  window.addEventListener('keydown', (e)=>{
    const tag = document.activeElement && document.activeElement.tagName;
    if(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const k = e.key.toLowerCase();
    if(k === 'v') setMode('look');
    else if(k === 'd') setMode('draw');
    else if(k === 'e') setMode('erase');
    else if(k === 'a') setMode('annotate');
    else if(k === 'r') sendToHost({ type: 'request-refresh' });
    else if((e.ctrlKey || e.metaKey) && k === 'z'){ e.preventDefault(); undo(); }
  });

  // ---------- resize ----------
  window.addEventListener('resize', ()=>{
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ---------- render loop ----------
  function animate(){
    requestAnimationFrame(animate);
    const phi = THREE.MathUtils.degToRad(90 - lat);
    const theta = THREE.MathUtils.degToRad(lon);
    const target = new THREE.Vector3(
      R * Math.sin(phi) * Math.cos(theta),
      R * Math.cos(phi),
      R * Math.sin(phi) * Math.sin(theta)
    );
    camera.lookAt(target);

    coordsLabel.innerHTML = `lon ${lon.toFixed(1)}&deg; &nbsp; lat ${lat.toFixed(1)}&deg; &nbsp; fov ${camera.fov.toFixed(0)}&deg;`;
    updatePins();
    renderer.render(scene, camera);
  }
  animate();
})();
