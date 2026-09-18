// geo.js — coordinate + projection math, isolated so it can be reasoned about
// without a phone. All angles in degrees unless noted. Local frame is ENU:
// east (+x), north (+y), up (+z), meters.

(function () {
  "use strict";

  const DEG = Math.PI / 180;

  // Meters per degree of latitude/longitude at a given latitude.
  function metersPerDegree(lat) {
    const latRad = lat * DEG;
    return {
      lat: 111132.92 - 559.82 * Math.cos(2 * latRad) + 1.175 * Math.cos(4 * latRad),
      lng: 111412.84 * Math.cos(latRad) - 93.5 * Math.cos(3 * latRad),
    };
  }

  // Convert an absolute {lat,lng} to local {east,north} meters from an origin.
  function toLocal(origin, pos) {
    const m = metersPerDegree(origin.lat);
    return {
      east: (pos.lng - origin.lng) * m.lng,
      north: (pos.lat - origin.lat) * m.lat,
    };
  }

  // Build the camera basis (right, up, forward) as ENU unit vectors, from a
  // compass heading (0=N, clockwise) and pitch (0=horizon, negative=looking
  // down).
  function cameraBasis(heading, pitch) {
    const th = heading * DEG;
    const ph = pitch * DEG;
    const cph = Math.cos(ph), sph = Math.sin(ph);
    const forward = [Math.sin(th) * cph, Math.cos(th) * cph, sph];
    const right = [Math.cos(th), -Math.sin(th), 0];
    // up = right x forward
    const up = [
      right[1] * forward[2] - right[2] * forward[1],
      right[2] * forward[0] - right[0] * forward[2],
      right[0] * forward[1] - right[1] * forward[0],
    ];
    return { right, up, forward };
  }

  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

  // Project a point given in camera-relative ENU meters onto the screen.
  // Returns { x, y, visible, distance }. `visible` is false when the point is
  // behind the camera. Screen: { w, h, hfov } (hfov in degrees).
  function project(rel, basis, screen) {
    const fwd = dot(rel, basis.forward);
    const distance = Math.hypot(rel[0], rel[1], rel[2]);
    if (fwd <= 0.1) return { x: 0, y: 0, visible: false, distance };

    const rx = dot(rel, basis.right);
    const uy = dot(rel, basis.up);

    // Focal length in pixels from horizontal FOV.
    const f = (screen.w / 2) / Math.tan((screen.hfov * DEG) / 2);
    const x = screen.w / 2 + f * (rx / fwd);
    const y = screen.h / 2 - f * (uy / fwd);
    return { x, y, visible: true, distance };
  }

  // Densify a polyline (list of {east,north}) into points spaced ~step meters
  // apart, so straight lines curve correctly under perspective.
  function densify(path, step) {
    const out = [];
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1];
      const de = b.east - a.east, dn = b.north - a.north;
      const len = Math.hypot(de, dn);
      const n = Math.max(1, Math.round(len / step));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        out.push({ east: a.east + de * t, north: a.north + dn * t });
      }
    }
    out.push(path[path.length - 1]);
    return out;
  }

  window.Geo = { metersPerDegree, toLocal, cameraBasis, project, densify };
})();
