#!/usr/bin/env python3
"""Convert the nested Haverhill shapefile export into app-ready GeoJSON."""

from __future__ import annotations

import argparse
import io
import json
import re
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path
from typing import Any


LAYER_CONFIG = {
    "Sanitary Pipes": ("sewer", 2.5),
    "Sanitary Points": ("sewer", 0.0),
    "Storm Pipes": ("storm", 1.5),
    "Storm Points": ("storm", 0.0),
    "Water Main": ("water", 1.2),
    "Water Points": ("water", 0.0),
    "projectGeometry": ("project", 0.0),
}

NETWORK_LABELS = {
    "sewer": "Sanitary",
    "storm": "Storm",
    "water": "Water",
    "project": "Project",
}

POINT_TYPES = {
    "Hydrant": "hydrant",
    "Valve": "valve",
    "Fitting": "valve",
    "Manhole": "manhole",
    "Catch Basin": "catchbasin",
}

SELECTED_FIELDS = {
    "Sanitary Pipes": "diameter,material,subtype,type",
    "Sanitary Points": "diameter,material,subtype,type",
    "Storm Pipes": "diameter,material,subtype,type",
    "Storm Points": "diameter,material,subtype,type",
    "Water Main": "diameter,material,subtype,type",
    "Water Points": "diameter,material,subtype,type",
    "projectGeometry": "layer_name,CateTitle",
}

EXPECTED_SOURCE_COUNT = 837


def slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def meaningful(value: Any) -> bool:
    return value is not None and str(value).strip() not in {"", "-"}


def rounded_coordinates(value: Any) -> Any:
    if isinstance(value, list):
        return [rounded_coordinates(item) for item in value]
    if isinstance(value, float):
        return round(value, 7)
    return value


def diameter_value(value: Any) -> float | None:
    if not meaningful(value):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def format_diameter(value: float) -> str:
    return str(int(value)) if value.is_integer() else str(value)


def make_label(
    network: str, asset_type: str, diameter_inches: float | None
) -> str:
    parts = []
    if diameter_inches is not None:
        parts.append(f'{format_diameter(diameter_inches)}"')
    parts.extend([NETWORK_LABELS[network], asset_type])
    return " ".join(parts)


def read_nested_shapefiles(source: Path, destination: Path) -> None:
    with zipfile.ZipFile(source) as outer:
        nested_names = [
            name for name in outer.namelist() if name.lower().endswith(".zip")
        ]
        if len(nested_names) != 1:
            raise RuntimeError(
                f"Expected one nested ZIP, found {len(nested_names)}"
            )
        nested_bytes = outer.read(nested_names[0])

    with zipfile.ZipFile(io.BytesIO(nested_bytes)) as nested:
        nested.extractall(destination)


def layer_name_for(path: Path) -> str | None:
    for layer_name in LAYER_CONFIG:
        if path.stem.endswith(f"_{layer_name}"):
            return layer_name
    return None


def ogr_geojson(path: Path, layer_name: str) -> dict[str, Any]:
    command = [
        "ogr2ogr",
        "-f",
        "GeoJSON",
        "/vsistdout/",
        str(path),
        "-t_srs",
        "EPSG:4326",
        "-select",
        SELECTED_FIELDS[layer_name],
    ]
    result = subprocess.run(
        command,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return json.loads(result.stdout)


def validate_coordinates(geometry: dict[str, Any]) -> None:
    def coordinate_pairs(value: Any):
        if (
            isinstance(value, list)
            and len(value) >= 2
            and isinstance(value[0], (int, float))
            and isinstance(value[1], (int, float))
        ):
            yield value
            return
        if isinstance(value, list):
            for item in value:
                yield from coordinate_pairs(item)

    for lng, lat, *_ in coordinate_pairs(geometry["coordinates"]):
        if not (-72 <= lng <= -70 and 41 <= lat <= 44):
            raise RuntimeError(
                f"Coordinate outside the Haverhill safety envelope: {lng}, {lat}"
            )


def convert_feature(
    source_feature: dict[str, Any],
    layer_name: str,
    index: int,
) -> list[dict[str, Any]]:
    network, default_depth = LAYER_CONFIG[layer_name]
    source_properties = source_feature.get("properties") or {}
    geometry = source_feature.get("geometry")
    if not geometry:
        return []

    validate_coordinates(geometry)
    if layer_name == "projectGeometry":
        properties: dict[str, Any] = {
            "type": "project",
            "assetType": "Boundary",
            "label": "Project Boundary",
            "depth": 0.0,
            "depthSource": "n/a",
            "sourceLayer": layer_name,
        }
        geometry_type = geometry["type"]
        if geometry_type not in {"Polygon", "MultiPolygon"}:
            raise RuntimeError(
                f"Unsupported geometry {geometry_type} in {layer_name}"
            )
        base_id = f"haverhill-{slug(layer_name)}-{index:04d}"
        return [
            {
                "type": "Feature",
                "id": base_id,
                "properties": {**properties, "id": base_id},
                "geometry": {
                    "type": geometry_type,
                    "coordinates": rounded_coordinates(geometry["coordinates"]),
                },
            }
        ]

    asset_type = (
        str(source_properties.get("type")).strip()
        if meaningful(source_properties.get("type"))
        else "Asset"
    )
    diameter_inches = diameter_value(source_properties.get("diameter"))
    marker_type = POINT_TYPES.get(asset_type, network)
    properties: dict[str, Any] = {
        "type": marker_type
        if geometry.get("type") == "Point"
        else network,
        "network": network,
        "assetType": asset_type,
        "label": make_label(network, asset_type, diameter_inches),
        "depth": default_depth,
        "depthSource": "nominal-demo",
        "sourceLayer": layer_name,
    }
    if diameter_inches is not None:
        properties["diameterIn"] = diameter_inches
    for source_key, output_key in (
        ("material", "material"),
        ("subtype", "subtype"),
    ):
        value = source_properties.get(source_key)
        if meaningful(value):
            properties[output_key] = str(value).strip()

    base_id = f"haverhill-{slug(layer_name)}-{index:04d}"
    geometry_type = geometry["type"]
    if geometry_type == "MultiLineString":
        return [
            {
                "type": "Feature",
                "id": f"{base_id}-{part_index}",
                "properties": {
                    **properties,
                    "id": f"{base_id}-{part_index}",
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": rounded_coordinates(coordinates),
                },
            }
            for part_index, coordinates in enumerate(
                geometry["coordinates"], start=1
            )
        ]

    if geometry_type not in {"LineString", "Point"}:
        raise RuntimeError(
            f"Unsupported geometry {geometry_type} in {layer_name}"
        )

    return [
        {
            "type": "Feature",
            "id": base_id,
            "properties": {**properties, "id": base_id},
            "geometry": {
                "type": geometry_type,
                "coordinates": rounded_coordinates(geometry["coordinates"]),
            },
        }
    ]


def convert(source: Path, output: Path) -> dict[str, Any]:
    if shutil.which("ogr2ogr") is None:
        raise RuntimeError("ogr2ogr is required but was not found on PATH")

    features: list[dict[str, Any]] = []
    source_feature_count = 0
    with tempfile.TemporaryDirectory() as temp_dir:
        extracted = Path(temp_dir)
        read_nested_shapefiles(source, extracted)
        shapefiles = sorted(extracted.glob("*.shp"))

        for shapefile in shapefiles:
            layer_name = layer_name_for(shapefile)
            if layer_name is None:
                continue
            collection = ogr_geojson(shapefile, layer_name)
            for index, source_feature in enumerate(
                collection.get("features", []), start=1
            ):
                source_feature_count += 1
                features.extend(
                    convert_feature(source_feature, layer_name, index)
                )

    if source_feature_count != EXPECTED_SOURCE_COUNT:
        raise RuntimeError(
            f"Expected {EXPECTED_SOURCE_COUNT} source features, "
            f"found {source_feature_count}"
        )

    collection = {
        "type": "FeatureCollection",
        "name": "Downtown Haverhill utility assets",
        "metadata": {
            "sourceArchive": source.name,
            "sourceCrs": "EPSG:3857",
            "outputCrs": "EPSG:4326",
            "sourceFeatureCount": source_feature_count,
            "outputFeatureCount": len(features),
            "depthPolicy": (
                "Source depth/elevation fields were blank. Rendering depths are "
                "nominal demo values and are not suitable for excavation."
            ),
            "license": "Not specified in source archive",
        },
        "features": features,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(collection, separators=(",", ":"), ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return collection


def feature_centroid(collection: dict[str, Any]) -> tuple[float, float]:
    lngs: list[float] = []
    lats: list[float] = []

    def walk(value: Any) -> None:
        if (
            isinstance(value, list)
            and len(value) >= 2
            and isinstance(value[0], (int, float))
            and isinstance(value[1], (int, float))
        ):
            lngs.append(float(value[0]))
            lats.append(float(value[1]))
            return
        if isinstance(value, list):
            for item in value:
                walk(item)

    for feature in collection["features"]:
        if feature.get("properties", {}).get("type") == "project":
            walk(feature["geometry"]["coordinates"])
            break
    else:
        for feature in collection["features"]:
            walk(feature["geometry"]["coordinates"])

    return (sum(lngs) / len(lngs), sum(lats) / len(lats))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path, help="Outer Haverhill ZIP export")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("data/haverhill-utilities.geojson"),
    )
    args = parser.parse_args()

    collection = convert(args.source.resolve(), args.output.resolve())
    lng, lat = feature_centroid(collection)
    print(
        f"Wrote {len(collection['features'])} features to "
        f"{args.output.resolve()}"
    )
    print(f"Suggested DEFAULT_ORIGIN: {{ lng: {lng:.7f}, lat: {lat:.7f} }}")


if __name__ == "__main__":
    main()
