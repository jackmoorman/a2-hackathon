// app.js — orchestrates the three layers: camera, overlay canvas, HUD.
// Milestone 1: camera hello-world behind a launch gesture, plus live
// GPS + heading readouts in the HUD so we can confirm sensor data flows.

(function () {
  "use strict";

  const els = {
    gate: document.getElementById("gate"),
    launch: document.getElementById("launch"),
    camera: document.getElementById("camera"),
    overlay: document.getElementById("overlay"),
    error: document.getElementById("error"),
    gpsDot: document.getElementById("gps-dot"),
    gpsText: document.getElementById("gps-text"),
    hdgDot: document.getElementById("hdg-dot"),
    hdgText: document.getElementById("hdg-text"),
  };

  // Live sensor state, updated by watchers and read by the render loop.
  const state = {
    origin: null,        // { lat, lng } captured at first GPS fix
    position: null,      // latest { lat, lng, accuracy }
    heading: null,       // degrees, 0 = north, clockwise
    tilt: null,          // beta (front-back tilt) in degrees
  };

  const CONFIG = {
    cameraHeight: 1.5,   // phone height above ground, meters
    hfov: 63,            // approximate horizontal camera FOV, degrees
    densifyStep: 2,      // polyline sampling, meters
  };

  const COLORS = {
    water: "#29b6ff",
    gas: "#ffb300",
    electric: "#ff4dd8",
    sewer: "#22e07a",
    manhole: "#cfd8dc",
    valve: "#ffb300",
    hydrant: "#ff5252",
    _default: "#00e5ff",
  };
  const colorFor = (t) => COLORS[t] || COLORS._default;

  function showError(msg) {
    els.error.textContent = msg;
    els.error.classList.remove("hidden");
  }

  // ---- Camera ----------------------------------------------------------
  async function startCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
    els.camera.srcObject = stream;
    await els.camera.play();
  }

  // ---- Geolocation -----------------------------------------------------
  function startGeolocation() {
    if (!("geolocation" in navigator)) {
      showError("Geolocation not supported on this device.");
      return;
    }
    navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        state.position = { lat: latitude, lng: longitude, accuracy };
        if (!state.origin) state.origin = { lat: latitude, lng: longitude };
        const cls = accuracy <= 15 ? "ok" : accuracy <= 40 ? "warn" : "";
        els.gpsDot.className = "dot " + cls;
        els.gpsText.textContent = `GPS: ±${Math.round(accuracy)}m`;
      },
      (err) => {
        els.gpsText.textContent = "GPS: denied";
        showError("Location error: " + err.message);
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
    );
  }

  // ---- Device orientation (compass heading + tilt) ---------------------
  function handleOrientation(e) {
    let heading = null;
    if (typeof e.webkitCompassHeading === "number") {
      // iOS: already true-north referenced, clockwise.
      heading = e.webkitCompassHeading;
    } else if (typeof e.alpha === "number") {
      // Android/others: alpha is counter-clockwise from north.
      heading = (360 - e.alpha) % 360;
    }
    if (heading !== null) {
      state.heading = heading;
      els.hdgDot.className = "dot ok";
      els.hdgText.textContent = `HDG: ${Math.round(heading)}°`;
    }
    if (typeof e.beta === "number") state.tilt = e.beta;
  }

  // Must be called SYNCHRONOUSLY from the launch gesture (before any await),
  // or iOS rejects with "requires a user gesture".
  function requestOrientationPermission() {
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === "function") {
      return DOE.requestPermission();
    }
    return Promise.resolve("granted"); // non-iOS: no prompt needed
  }

  function startOrientation(permissionResult) {
    if (permissionResult !== "granted") {
      els.hdgText.textContent = "HDG: denied";
      return;
    }
    // Prefer the absolute (compass-referenced) event when available.
    window.addEventListener("deviceorientationabsolute", handleOrientation, true);
    window.addEventListener("deviceorientation", handleOrientation, true);
  }

  // ---- Overlay canvas --------------------------------------------------
  const ctx = els.overlay.getContext("2d");

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    els.overlay.width = Math.round(window.innerWidth * dpr);
    els.overlay.height = Math.round(window.innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener("resize", resizeCanvas);
  window.addEventListener("orientationchange", resizeCanvas);

  // User's current local position (east/north meters) relative to origin.
  function userLocal() {
    if (!state.origin || !state.position) return { east: 0, north: 0 };
    return Geo.toLocal(state.origin, state.position);
  }

  // Build a camera-relative ENU vector for a feature at local (east,north)
  // and given depth below ground.
  function relVector(feat, user, depth) {
    return [
      feat.east - user.east,
      feat.north - user.north,
      -(CONFIG.cameraHeight + depth),
    ];
  }

  function drawLines(basis, screen, user) {
    const W = window.UTILITIES.lines;
    for (const line of W) {
      const color = colorFor(line.type);
      const pts = Geo.densify(line.path, CONFIG.densifyStep).map((v) => {
        const rel = relVector(v, user, line.depth);
        return Geo.project(rel, basis, screen);
      });

      ctx.lineWidth = 5;
      ctx.strokeStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      let drawing = false;
      for (const p of pts) {
        if (!p.visible) { drawing = false; continue; }
        if (!drawing) { ctx.moveTo(p.x, p.y); drawing = true; }
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Label at the midpoint vertex if visible.
      const mid = pts.find((p) => p.visible && p.x > 0 && p.x < screen.w);
      if (mid) drawTag(mid.x, mid.y, line.label, color);
    }
  }

  function drawPoints(basis, screen, user) {
    for (const pt of window.UTILITIES.points) {
      const rel = relVector(pt, user, pt.depth);
      const p = Geo.project(rel, basis, screen);
      if (!p.visible) continue;

      const color = colorFor(pt.type);
      // Marker: filled diamond with glow.
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.fillStyle = color;
      ctx.strokeStyle = "#04121a";
      ctx.lineWidth = 2;
      ctx.shadowColor = color;
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.moveTo(0, -9); ctx.lineTo(9, 0); ctx.lineTo(0, 9); ctx.lineTo(-9, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      drawTag(p.x, p.y - 18, `${pt.label} · ${Math.round(p.distance)}m`, color);
    }
  }

  function drawTag(x, y, text, color) {
    ctx.font = "600 13px -apple-system, system-ui, sans-serif";
    const padX = 7, padY = 4;
    const w = ctx.measureText(text).width + padX * 2;
    const h = 20;
    const bx = x - w / 2, by = y - h - 4;
    ctx.fillStyle = "rgba(4, 18, 26, 0.72)";
    roundRect(bx, by, w, h, 6);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    roundRect(bx, by, w, h, 6);
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x, by + h / 2 + 0.5);
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function render() {
    const W = window.innerWidth, H = window.innerHeight;
    ctx.clearRect(0, 0, W, H);

    if (state.origin && state.heading !== null) {
      const pitch = state.tilt !== null ? state.tilt - 90 : 0;
      const basis = Geo.cameraBasis(state.heading, pitch);
      const screen = { w: W, h: H, hfov: CONFIG.hfov };
      const user = userLocal();
      drawLines(basis, screen, user);
      drawPoints(basis, screen, user);
    }
    requestAnimationFrame(render);
  }

  // ---- Launch ----------------------------------------------------------
  async function launch() {
    els.launch.disabled = true;
    els.launch.textContent = "Starting…";

    // Kick off the motion-permission request FIRST, inside the gesture.
    const orientationPromise = requestOrientationPermission();

    try {
      await startCamera();
    } catch (err) {
      showError("Camera error: " + err.message + " — AR needs HTTPS + camera permission.");
      els.launch.disabled = false;
      els.launch.textContent = "Retry";
      return;
    }
    resizeCanvas();
    startGeolocation();

    try {
      const res = await orientationPromise;
      startOrientation(res);
    } catch (err) {
      showError("Motion permission error: " + err.message);
    }

    els.gate.classList.add("hidden");
    requestAnimationFrame(render);
  }

  els.launch.addEventListener("click", launch);
})();
