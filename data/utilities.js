// Real-world utility data is generated locally from the supplied Haverhill
// shapefile export. The app fetches this static file; it never calls a GIS
// service at runtime.
window.UTILITIES = { lines: [], points: [] };
window.GEOJSON_URL = "data/haverhill-utilities.geojson";

// Downtown Haverhill project-polygon centroid, used when GPS is denied.
window.DEFAULT_ORIGIN = { lng: -71.0850218, lat: 42.7761498 };
