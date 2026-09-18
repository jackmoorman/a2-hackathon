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

  async function startOrientation() {
    const DOE = window.DeviceOrientationEvent;
    // iOS 13+ requires an explicit permission request from a user gesture.
    if (DOE && typeof DOE.requestPermission === "function") {
      try {
        const res = await DOE.requestPermission();
        if (res !== "granted") {
          els.hdgText.textContent = "HDG: denied";
          return;
        }
      } catch (err) {
        showError("Motion permission error: " + err.message);
        return;
      }
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

  function render() {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    // Milestone 1: nothing projected yet. Projection lands in a later step.
    requestAnimationFrame(render);
  }

  // ---- Launch ----------------------------------------------------------
  async function launch() {
    els.launch.disabled = true;
    els.launch.textContent = "Starting…";
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
    await startOrientation();
    els.gate.classList.add("hidden");
    requestAnimationFrame(render);
  }

  els.launch.addEventListener("click", launch);
})();
