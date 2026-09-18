// Local offset features (anchored to the GPS origin at launch). Empty now that
// the demo runs on the real Downtown Haverhill dataset in data/haverhill.js.
window.UTILITIES = { lines: [], points: [] };

// Fallback origin if GPS is denied/absent: center of the Downtown Haverhill
// network, so the demo dataset renders around the user.
window.DEFAULT_ORIGIN = { lng: -71.085617, lat: 42.775736 };
