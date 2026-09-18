# a2-hackathon

Mobile AR overlay for underground utilities. Static GeoJSON is loaded from
`data/haverhill-utilities.geojson` — the phone never talks to an ArcGIS service.

## Data

Downtown Haverhill export converted locally with GDAL:

```
python scripts/convert-haverhill.py path/to/Downtown_Haverhill_*.zip
```

The output includes:

- water mains, sanitary pipes, storm pipes
- hydrants, valves, manholes, catch basins
- the project-boundary polygon (dashed white outline in AR)

Depth values are **nominal demo offsets**. Source elevation fields were blank.

## Run

Serve the folder over HTTPS (or localhost HTTP) so the camera and GPS APIs work:

```
python -m http.server 8080
```
