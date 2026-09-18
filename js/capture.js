// capture.js — composite the live camera frame + projected GIS overlay + a
// metadata panel (capture header + visible feature properties) into a photo or
// video, and save it to the phone via the Web Share sheet (Save to Photos on
// iOS) with a download fallback.
//
// Reads only through the window.CivilGridAR bridge exposed by app.js.

(function () {
  "use strict";

  const AR = window.CivilGridAR;
  if (!AR) return;

  const els = {
    ui: document.getElementById("capture-ui"),
    modePhoto: document.getElementById("mode-photo"),
    modeVideo: document.getElementById("mode-video"),
    shutter: document.getElementById("shutter"),
    timer: document.getElementById("rec-timer"),
    toast: document.getElementById("capture-toast"),
  };

  const FONT = "-apple-system, system-ui, Segoe UI, Roboto, sans-serif";
  const PHOTO_SCALE = Math.min(window.devicePixelRatio || 1, 2);
  const VIDEO_SCALE = 1; // keep the compose loop light enough for MediaRecorder

  // Mirror of app.js's palette so the baked-in panel color-codes features
  // without reaching into rendering internals.
  const COLORS = {
    storm: "#19A92A", sewer: "#03F01F", water: "#257DF8", fiber: "#ff8c00",
    gas: "#ffb300", electric: "#ff4dd8", _default: "#00e5ff",
  };
  const colorFor = (t) => COLORS[t] || COLORS._default;

  let mode = "photo";
  let recorder = null;
  let recChunks = [];
  let recTimerId = null;
  let recStartMs = 0;
  let composeLoopId = null;

  // Offscreen compositing surface.
  const canvas = document.createElement("canvas");
  const cctx = canvas.getContext("2d");

  // ---- Reveal once AR launches ----------------------------------------
  window.addEventListener("civilgrid:launched", () => {
    els.ui.classList.remove("hidden");
  });

  // ---- Mode toggle -----------------------------------------------------
  function setMode(m) {
    mode = m;
    const isVideo = m === "video";
    els.modePhoto.classList.toggle("active", !isVideo);
    els.modeVideo.classList.toggle("active", isVideo);
    els.modePhoto.setAttribute("aria-selected", String(!isVideo));
    els.modeVideo.setAttribute("aria-selected", String(isVideo));
    els.shutter.classList.toggle("video", isVideo);
  }
  els.modePhoto.addEventListener("click", () => { if (!recorder) setMode("photo"); });
  els.modeVideo.addEventListener("click", () => { if (!recorder) setMode("video"); });

  // ---- Toast -----------------------------------------------------------
  let toastId = null;
  function toast(msg, ms = 3600) {
    els.toast.textContent = msg;
    els.toast.classList.remove("hidden");
    clearTimeout(toastId);
    toastId = setTimeout(() => els.toast.classList.add("hidden"), ms);
  }

  // ---- Helpers ---------------------------------------------------------
  function pad2(n) { return String(n).padStart(2, "0"); }

  function stamp(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
      `T${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`;
  }

  function compassDir(deg) {
    return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Draw the camera frame with object-fit: cover semantics.
  function drawVideoCover(ctx, video, W, H) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H); return; }
    const scale = Math.max(W / vw, H / vh);
    const dw = vw * scale, dh = vh * scale;
    ctx.drawImage(video, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }

  // ---- Metadata panel --------------------------------------------------
  // A "panel" is a glass card holding styled text rows. Each row:
  //   { text, font, color, h, indent?, dot? }
  function panelSize(ctx, rows, padX, padY, gap) {
    let w = 0, h = padY * 2;
    for (const r of rows) {
      ctx.font = r.font;
      w = Math.max(w, (r.indent || 0) + ctx.measureText(r.text).width);
    }
    for (const r of rows) h += r.h + gap;
    return { w: w + padX * 2, h: h - gap };
  }

  function drawPanel(ctx, x, y, rows) {
    const padX = 14, padY = 12, gap = 6;
    const { w, h } = panelSize(ctx, rows, padX, padY, gap);
    ctx.fillStyle = "rgba(4, 12, 18, 0.72)";
    roundRect(ctx, x, y, w, h, 12); ctx.fill();
    ctx.strokeStyle = "rgba(0, 229, 255, 0.35)"; ctx.lineWidth = 1;
    roundRect(ctx, x, y, w, h, 12); ctx.stroke();

    ctx.textAlign = "left"; ctx.textBaseline = "top";
    let ty = y + padY;
    for (const r of rows) {
      const tx = x + padX + (r.indent || 0);
      if (r.dot) {
        ctx.fillStyle = r.dot;
        ctx.beginPath();
        ctx.arc(tx - 8, ty + r.h / 2, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.font = r.font;
      ctx.fillStyle = r.color;
      ctx.fillText(r.text, tx, ty);
      ty += r.h + gap;
    }
    return { w, h };
  }

  function drawMetadata(ctx, W, H) {
    const state = AR.getState();
    if (!state) return;
    const margin = 16;

    // Header (top-left): brand + capture context.
    const now = new Date();
    const pos = state.position;
    let gpsLine;
    if (pos) {
      gpsLine = `${pos.lat.toFixed(6)}, ${pos.lng.toFixed(6)}  ±${Math.round(pos.accuracy)}m`;
    } else if (state.originIsFallback && state.origin) {
      gpsLine = `${state.origin.lat.toFixed(6)}, ${state.origin.lng.toFixed(6)}  (demo)`;
    } else {
      gpsLine = "location unavailable";
    }
    const hdgLine = state.heading !== null
      ? `${Math.round(state.heading)}°  ${compassDir(state.heading)}`
      : "—";

    const header = [
      { text: "CIVILGRID AR", font: `800 15px ${FONT}`, color: "#00e5ff", h: 17 },
      { text: "Utility X-Ray Capture", font: `600 11px ${FONT}`, color: "rgba(255,255,255,0.6)", h: 13 },
      { text: now.toLocaleString(), font: `600 12px ${FONT}`, color: "#fff", h: 14 },
      { text: `GPS   ${gpsLine}`, font: `500 12px ${FONT}`, color: "rgba(255,255,255,0.85)", h: 14 },
      { text: `HDG   ${hdgLine}`, font: `500 12px ${FONT}`, color: "rgba(255,255,255,0.85)", h: 14 },
    ];
    drawPanel(ctx, margin, margin, header);

    // Feature list (bottom-left): visible utilities and their properties.
    const feats = AR.getVisibleFeatures();
    const rows = [{
      text: `VISIBLE UTILITIES · ${feats.length}`,
      font: `700 11px ${FONT}`, color: "rgba(255,255,255,0.6)", h: 13,
    }];
    if (feats.length === 0) {
      rows.push({ text: "None in view", font: `500 12px ${FONT}`, color: "rgba(255,255,255,0.7)", h: 14 });
    } else {
      for (const f of feats.slice(0, 8)) {
        rows.push({
          text: f.label, font: `700 13px ${FONT}`, color: colorFor(f.type), h: 15, indent: 14, dot: colorFor(f.type),
        });
        const depth = f.depth ? `${f.depth}m deep` : "at surface";
        rows.push({
          text: `${f.type} · ${depth} · ${Math.round(f.distance)}m away`,
          font: `500 11px ${FONT}`, color: "rgba(255,255,255,0.75)", h: 13, indent: 14,
        });
      }
      if (feats.length > 8) {
        rows.push({ text: `+${feats.length - 8} more`, font: `500 11px ${FONT}`, color: "rgba(255,255,255,0.6)", h: 13, indent: 14 });
      }
    }
    const size = panelSize(ctx, rows, 14, 12, 6);
    drawPanel(ctx, margin, H - margin - size.h, rows);
  }

  // ---- Compose one full frame -----------------------------------------
  function compose(scale) {
    const W = window.innerWidth, H = window.innerHeight;
    const cw = Math.round(W * scale), ch = Math.round(H * scale);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw; canvas.height = ch;
    }
    cctx.setTransform(scale, 0, 0, scale, 0, 0);
    cctx.clearRect(0, 0, W, H);
    drawVideoCover(cctx, AR.video, W, H);
    cctx.drawImage(AR.overlay, 0, 0, W, H); // projected GIS lines/points
    drawMetadata(cctx, W, H);
  }

  // ---- Photo -----------------------------------------------------------
  async function capturePhoto() {
    compose(PHOTO_SCALE);
    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.92));
    if (!blob) { toast("Capture failed. Try again."); return; }
    await save(blob, "jpg", "image/jpeg", "photo");
  }

  // ---- Video -----------------------------------------------------------
  function pickMime() {
    if (!window.MediaRecorder) return null;
    const cands = ["video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
    for (const c of cands) {
      if (MediaRecorder.isTypeSupported(c)) return c;
    }
    return "";
  }

  function updateTimer() {
    const s = Math.floor((Date.now() - recStartMs) / 1000);
    els.timer.textContent = `${Math.floor(s / 60)}:${pad2(s % 60)}`;
  }

  function startRecording() {
    if (!window.MediaRecorder) {
      toast("Video recording isn't supported on this browser. Try Photo mode.");
      return;
    }
    compose(VIDEO_SCALE); // fix the capture surface size before streaming
    let stream;
    try {
      stream = canvas.captureStream(30);
    } catch (e) {
      toast("Recording failed: " + e.message);
      return;
    }
    const mime = pickMime();
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch (e) {
      toast("Recording failed: " + e.message);
      recorder = null;
      return;
    }
    recChunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
    recorder.onstop = onRecStop;

    const loop = () => { compose(VIDEO_SCALE); composeLoopId = requestAnimationFrame(loop); };
    composeLoopId = requestAnimationFrame(loop);

    recorder.start();
    recStartMs = Date.now();
    els.shutter.classList.add("recording");
    els.timer.classList.remove("hidden");
    updateTimer();
    recTimerId = setInterval(updateTimer, 250);
  }

  function stopRecording() {
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }

  async function onRecStop() {
    if (composeLoopId) { cancelAnimationFrame(composeLoopId); composeLoopId = null; }
    if (recTimerId) { clearInterval(recTimerId); recTimerId = null; }
    els.shutter.classList.remove("recording");
    els.timer.classList.add("hidden");

    const type = (recorder && recorder.mimeType) || "video/webm";
    const blob = new Blob(recChunks, { type });
    recorder = null;
    recChunks = [];
    if (!blob.size) { toast("No video captured."); return; }
    const ext = type.includes("mp4") ? "mp4" : "webm";
    await save(blob, ext, type, "video");
  }

  // ---- Save to phone ---------------------------------------------------
  async function save(blob, ext, type, kind) {
    const name = `civilgrid-ar-${stamp(new Date())}.${ext}`;
    const file = new File([blob], name, { type });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "CivilGrid AR capture" });
        toast(`Shared — choose “Save ${kind === "video" ? "Video" : "Image"}” to add to Photos.`);
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return; // user dismissed the sheet
        // Otherwise fall through to a direct download.
      }
    }
    downloadBlob(blob, name);
    toast("Saved to your downloads.");
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // ---- Shutter ---------------------------------------------------------
  els.shutter.addEventListener("click", async () => {
    if (mode === "photo") {
      els.shutter.disabled = true;
      try { await capturePhoto(); }
      catch (e) { toast("Capture failed: " + e.message); }
      finally { els.shutter.disabled = false; }
    } else {
      if (recorder) stopRecording();
      else startRecording();
    }
  });
})();
