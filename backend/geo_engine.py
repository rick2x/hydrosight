import json
import math
import shutil
import threading
import uuid
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import geopandas as gpd
import networkx as nx
import numpy as np
import osmnx as ox
import pandas as pd
import rasterio
from pyproj import Transformer
from rasterio.features import shapes
from rasterio.transform import from_origin
from rasterio.windows import Window, from_bounds
from shapely.geometry import LineString, MultiPolygon, Point, Polygon, box, mapping, shape
from shapely.ops import unary_union
from scipy.ndimage import label

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
OUTPUTS_DIR = BASE_DIR / "outputs"
ROOT_DIR = BASE_DIR.parent

DEFAULT_DEM_PATH = DATA_DIR / "rodriguez_dem.tif"
BUILDINGS_PARQUET_PATH = DATA_DIR / "rodriguez_buildings.parquet"
ROADS_GRAPHML_PATH = DATA_DIR / "rodriguez_roads.graphml"
EVAC_CENTERS_CSV_PATH = DATA_DIR / "evacuationcenters.csv"
BOUNDARY_SHP_PATH = ROOT_DIR / "boundary" / "political_boundary_rodriguez.shp"

to_utm = Transformer.from_crs("EPSG:4326", "EPSG:32651", always_xy=True)
to_wgs84 = Transformer.from_crs("EPSG:32651", "EPSG:4326", always_xy=True)

_EXPORT_LOCK = threading.Lock()
_BOUNDARY_GDF_WGS84: Optional[gpd.GeoDataFrame] = None
_EVAC_CENTERS_CACHE: Optional[List[Dict[str, Any]]] = None

# All 11 Barangays + key flood sectors across the entire Municipality of Rodriguez (Montalban), Rizal
SCENARIO_ZONES = [
    {
        "id": "kasiglahan_village",
        "barangay": "SAN JOSE",
        "cluster_prefix": "KV-BLK",
        "center_lon": 121.1372,
        "center_lat": 14.7498,
        "evac_name": "Kasiglahan Village Elementary School (MDRRMO Sector 1)",
        "evac_lon": 121.1414,
        "evac_lat": 14.7528,
    },
    {
        "id": "san_jose_riverfront",
        "barangay": "SAN JOSE",
        "cluster_prefix": "SJ-RIV",
        "center_lon": 121.1348,
        "center_lat": 14.7425,
        "evac_name": "Brgy. San Jose Covered Court & Rescue Command Post",
        "evac_lon": 121.1305,
        "evac_lat": 14.7458,
    },
    {
        "id": "montalban_town_center",
        "barangay": "ROSARIO",
        "cluster_prefix": "MTC-ZN",
        "center_lon": 121.1422,
        "center_lat": 14.7328,
        "evac_name": "Rodriguez Municipal Gymnasium (Montalban Command Center)",
        "evac_lon": 121.1468,
        "evac_lat": 14.7362,
    },
    {
        "id": "san_isidro_southville",
        "barangay": "SAN ISIDRO",
        "cluster_prefix": "SI-SV8",
        "center_lon": 121.1485,
        "center_lat": 14.7645,
        "evac_name": "San Isidro National High School Evacuation Complex",
        "evac_lon": 121.1532,
        "evac_lat": 14.7678,
    },
    {
        "id": "burgos_lowland",
        "barangay": "BURGOS",
        "cluster_prefix": "BRG-MHD",
        "center_lon": 121.1362,
        "center_lat": 14.7218,
        "evac_name": "Burgos Elementary School & Barangay Rescue Hall",
        "evac_lon": 121.1404,
        "evac_lat": 14.7248,
    },
    {
        "id": "san_rafael_wawa",
        "barangay": "SAN RAFAEL",
        "cluster_prefix": "SR-WAW",
        "center_lon": 121.1535,
        "center_lat": 14.7285,
        "evac_name": "San Rafael Elementary School (Wawa Dam Sector)",
        "evac_lon": 121.1580,
        "evac_lat": 14.7315,
    },
    {
        "id": "manggahan_highway",
        "barangay": "MANGGAHAN",
        "cluster_prefix": "MNG-HWY",
        "center_lon": 121.1418,
        "center_lat": 14.7282,
        "evac_name": "Manggahan Covered Court & MDRRMO Staging Post",
        "evac_lon": 121.1458,
        "evac_lat": 14.7305,
    },
    {
        "id": "balite_proper",
        "barangay": "BALITE",
        "cluster_prefix": "BLT-JPR",
        "center_lon": 121.1455,
        "center_lat": 14.7325,
        "evac_name": "Balite Elementary School Evacuation Center",
        "evac_lon": 121.1492,
        "evac_lat": 14.7355,
    },
    {
        "id": "geronimo_riverbank",
        "barangay": "GERONIMO",
        "cluster_prefix": "GER-RIV",
        "center_lon": 121.1488,
        "center_lat": 14.7352,
        "evac_name": "Geronimo National High School Command Center",
        "evac_lon": 121.1528,
        "evac_lat": 14.7380,
    },
    {
        "id": "macabud_upland",
        "barangay": "MACABUD",
        "cluster_prefix": "MCB-BAS",
        "center_lon": 121.1435,
        "center_lat": 14.7865,
        "evac_name": "Macabud Barangay Multi-Purpose Evacuation Hall",
        "evac_lon": 121.1475,
        "evac_lat": 14.7895,
    },
    {
        "id": "mascap_valley",
        "barangay": "MASCAP",
        "cluster_prefix": "MSC-VAL",
        "center_lon": 121.1820,
        "center_lat": 14.7553,
        "evac_name": "Mascap Elementary School & Relief Center",
        "evac_lon": 121.1862,
        "evac_lat": 14.7582,
    },
    {
        "id": "puray_basin",
        "barangay": "PURAY",
        "cluster_prefix": "PRY-RIV",
        "center_lon": 121.1980,
        "center_lat": 14.7920,
        "evac_name": "Puray Elementary School & Upland Rescue Post",
        "evac_lon": 121.2022,
        "evac_lat": 14.7950,
    },
]


def ensure_dem_exists(dem_path: Optional[str] = None) -> Path:
    """
    Ensure that the local DEM raster exists in EPSG:32651.
    Copies from repo ./dem/ if available, or generates a synthetic DEM fallback.
    """
    target_path = Path(dem_path) if dem_path else DEFAULT_DEM_PATH
    if target_path.exists():
        return target_path

    target_path.parent.mkdir(parents=True, exist_ok=True)
    repo_dem = ROOT_DIR / "dem" / "rodriguez_cop30_10m_utm51n.tif"
    if not repo_dem.exists():
        repo_dem = ROOT_DIR / "dem" / "rodriguez_srtmgl1_10m_utm51n.tif"
    if repo_dem.exists():
        shutil.copyfile(repo_dem, target_path)
        return target_path

    # Synthetic DEM fallback in EPSG:32651 covering Rodriguez, Rizal
    west_utm, north_utm = 295000.0, 1647000.0
    pixel_size = 10.0
    width, height = 1800, 1800
    transform = from_origin(west_utm, north_utm, pixel_size, pixel_size)

    yy, xx = np.mgrid[0:height, 0:width]
    base_elev = 28.0 + 0.015 * xx + 0.01 * (height - yy)
    channel = -4.5 * np.exp(-((xx - 440.0) ** 2) / (2 * 65.0 ** 2))
    micro = 1.2 * np.sin(xx / 18.0) * np.cos(yy / 18.0)
    dem_data = (base_elev + channel + micro).astype(np.float32)

    with rasterio.open(
        target_path,
        "w",
        driver="GTiff",
        height=height,
        width=width,
        count=1,
        dtype="float32",
        crs="EPSG:32651",
        transform=transform,
        nodata=-9999.0,
    ) as dst:
        dst.write(dem_data, 1)

    return target_path


def _clamp_utm_to_dem(src: rasterio.DatasetReader, x: float, y: float, margin: float = 80.0) -> Tuple[float, float]:
    """Clamp UTM coordinates safely inside the DEM bounding box."""
    clamped_x = max(src.bounds.left + margin, min(src.bounds.right - margin, x))
    clamped_y = max(src.bounds.bottom + margin, min(src.bounds.top - margin, y))
    return clamped_x, clamped_y


def _bare_earth_filter_3x3(arr: np.ndarray, nodata: Optional[float] = -9999.0) -> np.ndarray:
    """
    Strips single-pixel SRTM radar rooftop/tree-canopy spikes using a 3x3 local minimum
    filter so floodwater follows actual bare-earth street elevation.
    """
    if arr.ndim != 2 or arr.shape[0] < 3 or arr.shape[1] < 3:
        return arr
    clean = np.where((arr == nodata) | (arr < -100), np.nan, arr.astype(np.float32))
    padded = np.pad(clean, 1, mode="edge")
    neighbors = [
        padded[0:-2, 0:-2],
        padded[0:-2, 1:-1],
        padded[0:-2, 2:],
        padded[1:-1, 0:-2],
        padded[1:-1, 1:-1],
        padded[1:-1, 2:],
        padded[2:, 0:-2],
        padded[2:, 1:-1],
        padded[2:, 2:],
    ]
    stacked = np.stack(neighbors, axis=0)
    # 25th percentile across 3x3 neighborhood approximates bare-earth street grade
    bare = np.nanpercentile(stacked, 25, axis=0)
    return np.where(np.isnan(bare), arr, bare).astype(np.float32)


def _box_blur_2d(arr: np.ndarray, radius: int = 4) -> np.ndarray:
    """Fast 2D moving average filter to extract macro valley slope on the 10m DEM."""
    if arr.ndim != 2 or radius < 1:
        return arr.astype(np.float32)
    padded = np.pad(arr.astype(np.float32), radius, mode="edge")
    k = 2 * radius + 1
    acc = np.zeros_like(arr, dtype=np.float32)
    for dy in range(k):
        for dx in range(k):
            acc += padded[dy : dy + arr.shape[0], dx : dx + arr.shape[1]]
    return acc / float(k * k)


def _mask_to_clean_zone_geom(
    mask: np.ndarray,
    win_transform: Any,
    corridor_geom: Any,
    corridor_probe: Any,
    include_corridor: bool = True,
) -> Any:
    """
    Vectorizes a binary DEM depth threshold mask into a clean, topologically valid
    polygon connected to the camera-to-target corridor, removing SRTM rooftop holes.
    """
    raw_polys = []
    if np.any(mask):
        for geom, val in shapes(mask.astype(np.uint8), mask=mask, transform=win_transform):
            if val == 1:
                poly_geom = shape(geom).buffer(0)
                if not poly_geom.is_empty and poly_geom.area >= 20.0:
                    raw_polys.append(poly_geom)

    if include_corridor and corridor_geom is not None and not corridor_geom.is_empty:
        raw_polys.append(corridor_geom)

    if not raw_polys:
        return Polygon()

    connected = [p for p in raw_polys if p.intersects(corridor_probe)]
    if not connected:
        connected = raw_polys

    merged = unary_union(connected)
    cleaned_parts = []
    parts_iter = merged.geoms if isinstance(merged, MultiPolygon) else [merged]
    for part in parts_iter:
        if isinstance(part, Polygon) and not part.is_empty:
            # Fill interior holes smaller than 7500 sqm or any hole inside the camera viewcone
            kept_holes = [
                ring
                for ring in part.interiors
                if Polygon(ring).area > 7500.0 and not Polygon(ring).intersects(corridor_probe)
            ]
            cleaned_parts.append(Polygon(part.exterior, kept_holes))

    if not cleaned_parts:
        return Polygon()

    smoothed = unary_union(cleaned_parts).buffer(4.5).buffer(-3.0).simplify(1.2, preserve_topology=True)
    return smoothed.buffer(0) if not smoothed.is_empty else Polygon()


def _sample_dem_elevation(src: rasterio.DatasetReader, x: float, y: float) -> float:
    """Safely sample bare-earth street elevation in meters from an open DEM dataset in EPSG:32651."""
    cx, cy = _clamp_utm_to_dem(src, x, y, margin=20.0)
    full_win = Window(0, 0, src.width, src.height)
    win30 = from_bounds(cx - 18, cy - 18, cx + 18, cy + 18, src.transform).intersection(full_win)
    if win30.width >= 1 and win30.height >= 1:
        arr30 = src.read(1, window=win30)
        valid30 = arr30[(arr30 != src.nodata) & (arr30 > -100)]
        if valid30.size > 0:
            return float(np.percentile(valid30, 25))
    try:
        val = float(list(src.sample([(cx, cy)]))[0][0])
    except Exception:
        val = -9999.0
    if src.nodata is not None and (math.isclose(val, src.nodata) or val < -100):
        win = from_bounds(cx - 150, cy - 150, cx + 150, cy + 150, src.transform).intersection(full_win)
        if win.width >= 1 and win.height >= 1:
            arr = src.read(1, window=win)
            valid = arr[(arr != src.nodata) & (arr > -100)]
            if valid.size > 0:
                return float(valid.mean())
        return 32.0
    return val


def load_evacuation_centers() -> List[Dict[str, Any]]:
    """
    Loads all 61 real evacuation centers across Rodriguez (Montalban) from
    backend/data/evacuationcenters.csv (columns: x=lon, y=lat, ec=name).
    """
    global _EVAC_CENTERS_CACHE
    if _EVAC_CENTERS_CACHE is not None:
        return _EVAC_CENTERS_CACHE

    centers: List[Dict[str, Any]] = []
    if EVAC_CENTERS_CSV_PATH.exists():
        try:
            df = pd.read_csv(EVAC_CENTERS_CSV_PATH)
            for idx, row in df.iterrows():
                lon = float(row["x"])
                lat = float(row["y"])
                name = str(row["ec"]).strip()
                ux, uy = to_utm.transform(lon, lat)
                centers.append(
                    {
                        "id": f"ec_{idx + 1}",
                        "name": name,
                        "lon": round(lon, 6),
                        "lat": round(lat, 6),
                        "utm_x": round(ux, 2),
                        "utm_y": round(uy, 2),
                    }
                )
        except Exception:
            centers = []

    if not centers:
        for idx, z in enumerate(SCENARIO_ZONES):
            ux, uy = to_utm.transform(z["evac_lon"], z["evac_lat"])
            centers.append(
                {
                    "id": f"ec_fallback_{idx + 1}",
                    "name": z["evac_name"],
                    "lon": z["evac_lon"],
                    "lat": z["evac_lat"],
                    "utm_x": round(ux, 2),
                    "utm_y": round(uy, 2),
                }
            )

    _EVAC_CENTERS_CACHE = centers
    return centers


def find_nearest_evacuation_center(lat: float, lon: float, min_safe_dist_m: float = 55.0) -> Dict[str, Any]:
    """
    Finds the evacuation center from backend/data/evacuationcenters.csv with the
    shortest actual road network distance along backend/data/rodriguez_roads.shp.
    """
    centers = load_evacuation_centers()
    tx, ty = to_utm.transform(lon, lat)

    euclid_ranked = []
    for ec in centers:
        dist_m = math.hypot(ec["utm_x"] - tx, ec["utm_y"] - ty)
        euclid_ranked.append((dist_m, ec))

    euclid_ranked.sort(key=lambda item: item[0])
    candidates = [item for item in euclid_ranked if item[0] >= min_safe_dist_m][:6] or euclid_ranked[:3]

    G_shp, node_list, node_arr = _get_road_shapefile_graph()
    if G_shp is not None and node_arr is not None and len(node_list) > 0:
        dest_node = _snap_to_road_node(lon, lat, node_list, node_arr)
        max_euclid = max(c[0] for c in candidates)
        lengths_map = nx.single_source_dijkstra_path_length(
            G_shp, dest_node, cutoff=max(1800.0, max_euclid * 2.4), weight="length"
        )
        best_road_dist = float("inf")
        best_ec = candidates[0][1]
        best_euclid = candidates[0][0]
        for euclid_d, ec in candidates:
            orig_node = _snap_to_road_node(ec["lon"], ec["lat"], node_list, node_arr)
            road_d = float(lengths_map.get(orig_node, euclid_d * 1.45))
            if road_d < best_road_dist:
                best_road_dist = road_d
                best_ec = ec
                best_euclid = euclid_d
        return {**best_ec, "straight_dist_m": round(best_euclid, 1), "road_dist_m": round(best_road_dist, 1)}

    best_dist, best_ec = candidates[0]
    return {**best_ec, "straight_dist_m": round(best_dist, 1), "road_dist_m": round(best_dist * 1.2, 1)}


def get_evacuation_centers_geojson() -> Dict[str, Any]:
    """Returns all 61 real evacuation centers from evacuationcenters.csv as a GeoJSON FeatureCollection."""
    centers = load_evacuation_centers()
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "id": ec["id"],
                    "name": ec["name"],
                    "lon": ec["lon"],
                    "lat": ec["lat"],
                },
                "geometry": {
                    "type": "Point",
                    "coordinates": [ec["lon"], ec["lat"]],
                },
            }
            for ec in centers
        ],
    }


def resolve_location_metadata(lat: float, lon: float, fallback_barangay: str = "SAN JOSE") -> Dict[str, Any]:
    """
    Given any (lat, lon) in Rodriguez (Montalban), resolves the containing or nearest
    Barangay from political_boundary_rodriguez.shp and the nearest real evacuation center
    from backend/data/evacuationcenters.csv.
    """
    global _BOUNDARY_GDF_WGS84
    barangay_name = fallback_barangay.upper()

    if BOUNDARY_SHP_PATH.exists():
        if _BOUNDARY_GDF_WGS84 is None:
            _BOUNDARY_GDF_WGS84 = gpd.read_file(BOUNDARY_SHP_PATH).to_crs("EPSG:4326")
        pt = Point(lon, lat)
        hits = _BOUNDARY_GDF_WGS84[_BOUNDARY_GDF_WGS84.geometry.contains(pt)]
        if not hits.empty:
            b_col = "Barangay" if "Barangay" in hits.columns else "BRGYNAME"
            barangay_name = str(hits.iloc[0][b_col]).upper()
        else:
            dists = _BOUNDARY_GDF_WGS84.geometry.distance(pt)
            nearest_idx = dists.idxmin()
            b_col = "Barangay" if "Barangay" in _BOUNDARY_GDF_WGS84.columns else "BRGYNAME"
            barangay_name = str(_BOUNDARY_GDF_WGS84.loc[nearest_idx, b_col]).upper()

    best_zone = SCENARIO_ZONES[0]
    best_dist = float("inf")
    for z in SCENARIO_ZONES:
        d = math.hypot(z["center_lon"] - lon, z["center_lat"] - lat)
        if z["barangay"].upper() == barangay_name and d < best_dist:
            best_dist = d
            best_zone = z
    if best_dist == float("inf"):
        for z in SCENARIO_ZONES:
            d = math.hypot(z["center_lon"] - lon, z["center_lat"] - lat)
            if d < best_dist:
                best_dist = d
                best_zone = z

    nearest_ec = find_nearest_evacuation_center(lat, lon)

    return {
        "barangay": barangay_name,
        "nearest_zone": best_zone,
        "evac_name": nearest_ec["name"],
        "evac_lat": nearest_ec["lat"],
        "evac_lon": nearest_ec["lon"],
        "evac_straight_dist_m": nearest_ec["straight_dist_m"],
    }


def ensure_spatial_assets(dem_path: Optional[str] = None) -> Tuple[Path, Path]:
    """
    Ensure pre-computed OSM building footprints (rodriguez_buildings.parquet)
    and road graph (rodriguez_roads.graphml) exist in backend/data/ for all 12 Montalban sectors.
    """
    dem_file = ensure_dem_exists(dem_path)
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    rebuild_buildings = not BUILDINGS_PARQUET_PATH.exists()
    if not rebuild_buildings:
        try:
            existing_bldgs = gpd.read_parquet(BUILDINGS_PARQUET_PATH)
            if existing_bldgs["scenario_id"].nunique() < len(SCENARIO_ZONES):
                rebuild_buildings = True
        except Exception:
            rebuild_buildings = True

    if rebuild_buildings:
        _generate_buildings_parquet(dem_file, BUILDINGS_PARQUET_PATH)

    rebuild_roads = not ROADS_GRAPHML_PATH.exists()
    if not rebuild_roads:
        try:
            # Quick check if all 12 zones are present
            txt = ROADS_GRAPHML_PATH.read_text(encoding="utf-8", errors="ignore")
            if "puray_basin" not in txt or "burgos_lowland" not in txt:
                rebuild_roads = True
        except Exception:
            rebuild_roads = True

    if rebuild_roads:
        _generate_roads_graphml(dem_file, ROADS_GRAPHML_PATH)

    load_evacuation_centers()
    _get_road_shapefile_graph()
    _load_osm_buildings()

    return BUILDINGS_PARQUET_PATH, ROADS_GRAPHML_PATH


def _generate_buildings_parquet(dem_file: Path, out_parquet: Path) -> None:
    rng = np.random.default_rng(20261027)
    records = []

    with rasterio.open(dem_file) as src:
        for zone in SCENARIO_ZONES:
            cx, cy = to_utm.transform(zone["center_lon"], zone["center_lat"])
            cx, cy = _clamp_utm_to_dem(src, cx, cy, margin=400.0)
            b_idx = 1
            for gx in range(-320, 340, 38):
                for gy in range(-320, 340, 34):
                    if abs(gx) < 14 or abs(gy) < 14:
                        continue
                    jitter_x = float(rng.uniform(-5.0, 5.0))
                    jitter_y = float(rng.uniform(-5.0, 5.0))
                    bx = cx + gx + jitter_x
                    by = cy + gy + jitter_y
                    w = float(rng.uniform(11.0, 20.0))
                    h = float(rng.uniform(10.0, 18.0))
                    footprint = box(bx - w / 2.0, by - h / 2.0, bx + w / 2.0, by + h / 2.0)

                    ground_m = _sample_dem_elevation(src, bx, by)
                    floors = int(rng.choice([1, 1, 2, 2, 2, 3], p=[0.28, 0.22, 0.20, 0.15, 0.10, 0.05]))
                    height_m = round(floors * 3.2 + float(rng.uniform(0.3, 1.4)), 1)
                    b_type = "residential" if floors <= 2 else "mixed_commercial"
                    residents = int(floors * rng.integers(3, 7))

                    records.append(
                        {
                            "building_id": f"{zone['cluster_prefix']}-{b_idx:03d}",
                            "scenario_id": zone["id"],
                            "barangay": zone["barangay"],
                            "building_type": b_type,
                            "floors": floors,
                            "height_m": height_m,
                            "ground_elev_m": round(ground_m, 2),
                            "est_residents": residents,
                            "geometry": footprint,
                        }
                    )
                    b_idx += 1

    gdf = gpd.GeoDataFrame(records, crs="EPSG:32651")
    gdf.to_parquet(out_parquet)


def _generate_roads_graphml(dem_file: Path, out_graphml: Path) -> None:
    G = nx.MultiDiGraph()
    G.graph["crs"] = "EPSG:4326"
    G.graph["simplified"] = True

    with rasterio.open(dem_file) as src:
        node_id = 1000
        for zone in SCENARIO_ZONES:
            cx, cy = to_utm.transform(zone["center_lon"], zone["center_lat"])
            ex, ey = to_utm.transform(zone["evac_lon"], zone["evac_lat"])
            cx, cy = _clamp_utm_to_dem(src, cx, cy, margin=400.0)
            ex, ey = _clamp_utm_to_dem(src, ex, ey, margin=400.0)
            base_elev = _sample_dem_elevation(src, cx, cy)

            min_x = min(cx, ex) - 320.0
            max_x = max(cx, ex) + 320.0
            min_y = min(cy, ey) - 320.0
            max_y = max(cy, ey) + 320.0

            xs = np.linspace(min_x, max_x, 9)
            ys = np.linspace(min_y, max_y, 9)

            grid_nodes: Dict[Tuple[int, int], int] = {}
            for ix, x_val in enumerate(xs):
                for iy, y_val in enumerate(ys):
                    lon, lat = to_wgs84.transform(float(x_val), float(y_val))
                    dist_from_basin = math.hypot(float(x_val) - cx, float(y_val) - cy)
                    is_perimeter_ridge = ix in (0, len(xs) - 1) or iy in (0, len(ys) - 1)
                    if is_perimeter_ridge:
                        rel_elev = base_elev + 0.95
                    elif dist_from_basin < 220.0:
                        rel_elev = base_elev - 0.35 + (dist_from_basin / 220.0) * 0.45
                    else:
                        rel_elev = base_elev + 0.35 + min(0.8, (dist_from_basin - 220.0) / 400.0)

                    nid = node_id
                    node_id += 1
                    grid_nodes[(ix, iy)] = nid
                    G.add_node(
                        nid,
                        x=round(lon, 6),
                        y=round(lat, 6),
                        utm_x=round(float(x_val), 2),
                        utm_y=round(float(y_val), 2),
                        elevation_m=round(rel_elev, 2),
                        barangay=zone["barangay"],
                        scenario_id=zone["id"],
                    )

            for ix in range(len(xs)):
                for iy in range(len(ys)):
                    u = grid_nodes[(ix, iy)]
                    for dx, dy in [(1, 0), (0, 1)]:
                        nx_i, ny_i = ix + dx, iy + dy
                        if (nx_i, ny_i) in grid_nodes:
                            v = grid_nodes[(nx_i, ny_i)]
                            ux, uy = G.nodes[u]["utm_x"], G.nodes[u]["utm_y"]
                            vx, vy = G.nodes[v]["utm_x"], G.nodes[v]["utm_y"]
                            length_m = round(math.hypot(vx - ux, vy - uy), 2)
                            mid_elev = round((G.nodes[u]["elevation_m"] + G.nodes[v]["elevation_m"]) / 2.0, 2)
                            road_name = (
                                f"{zone['barangay'].title()} Ridge Bypass Hwy"
                                if iy in (0, len(ys) - 1) or ix in (0, len(xs) - 1)
                                else f"{zone['cluster_prefix']} Street {ix + iy}"
                            )
                            G.add_edge(
                                u,
                                v,
                                key=0,
                                length=length_m,
                                elevation_m=mid_elev,
                                name=road_name,
                                highway="secondary" if "Hwy" in road_name else "residential",
                            )
                            G.add_edge(
                                v,
                                u,
                                key=0,
                                length=length_m,
                                elevation_m=mid_elev,
                                name=road_name,
                                highway="secondary" if "Hwy" in road_name else "residential",
                            )

    ox.save_graphml(G, filepath=out_graphml)


def project_photo_to_flood_shapefile(
    dem_path: str,
    cam_lon: float,
    cam_lat: float,
    azimuth_deg: float,
    fov_deg: float,
    click_u: float,
    est_distance_m: float,
    water_depth_m: float,
    search_radius_m: float = 400.0,
    output_dir: str = "./outputs",
    run_id: str = "latest",
    barangay: str = "SAN JOSE",
) -> dict:
    """
    Projects street-level camera ray onto EPSG:32651 DEM, samples Z_DEM, computes
    WSE = Z_DEM + h_w, flood-fills connected lowland catchment where DEM <= WSE,
    and exports multi-file ESRI Shapefile (.shp, .shx, .dbf, .prj) + GeoJSON.
    Thread-safe on Windows using isolated per-request temporary staging directories.
    """
    resolved_dem = ensure_dem_exists(dem_path)
    ensure_spatial_assets(str(resolved_dem))

    loc_meta = resolve_location_metadata(cam_lat, cam_lon, fallback_barangay=barangay)
    resolved_barangay = loc_meta["barangay"]

    cam_x, cam_y = to_utm.transform(cam_lon, cam_lat)
    angle_offset_deg = (click_u - 0.5) * fov_deg
    target_bearing_rad = math.radians(azimuth_deg + angle_offset_deg)

    target_x = cam_x + est_distance_m * math.sin(target_bearing_rad)
    target_y = cam_y + est_distance_m * math.cos(target_bearing_rad)

    polys = []
    profile_points: List[Dict[str, float]] = []
    with rasterio.open(resolved_dem) as src:
        b_left, b_bottom, b_right, b_top = src.bounds
        # Explicit validation: Reject coordinates far outside the Rodriguez pilot DEM (e.g. lat/lon 0, 0)
        if not (b_left - 5000.0 <= cam_x <= b_right + 5000.0 and b_bottom - 5000.0 <= cam_y <= b_top + 5000.0):
            raise ValueError(
                f"Camera coordinate ({cam_lat:.4f}, {cam_lon:.4f}) is outside the Rodriguez, Rizal pilot DEM extent "
                f"(WGS84 coverage: 14.69°N–14.89°N, 121.10°E–121.35°E). "
                "Please place the camera pin within the Rodriguez municipality boundary."
            )
        cam_x, cam_y = _clamp_utm_to_dem(src, cam_x, cam_y, margin=search_radius_m + 20.0)
        target_x, target_y = _clamp_utm_to_dem(src, target_x, target_y, margin=search_radius_m + 20.0)
        ground_elev = _sample_dem_elevation(src, target_x, target_y)
        cam_ground_elev = _sample_dem_elevation(src, cam_x, cam_y)

        # Solution B: Ground-truth observer calibration & flooded street corridor reconciliation
        # The camera operator is the ground-truth physical witness standing at (cam_x, cam_y).
        # Standing water depth at the camera operator cannot exceed observed flood depth or human physical limits.
        delta_z = ground_elev - cam_ground_elev
        max_street_grade_m = max(0.40, est_distance_m * 0.025)

        if abs(delta_z) > max_street_grade_m:
            if delta_z > 0:
                # Target DEM has an uphill artifact (e.g. tree/roof bounce or DEM step error).
                # Anchor WSE to camera observer ground truth so camera depth matches the observed scene:
                wse = cam_ground_elev + water_depth_m
                cam_street_elev = cam_ground_elev
                eff_target_z = min(ground_elev, wse - max(0.15, min(water_depth_m * 0.85, 0.45)))
            else:
                # Camera DEM is higher than target; anchor to target waterline and ensure camera is at water edge:
                wse = ground_elev + water_depth_m
                cam_street_elev = min(cam_ground_elev, wse - max(0.15, water_depth_m * 0.5))
                eff_target_z = ground_elev
        else:
            # Elevations are consistent; anchor WSE to camera observer ground truth
            wse = cam_ground_elev + water_depth_m
            cam_street_elev = cam_ground_elev
            eff_target_z = ground_elev

        # Sample real DEM elevation profile along the camera ray from 0m (Camera) to 1.6x target distance
        for frac in [0.0, 0.25, 0.50, 0.75, 1.0, 1.30, 1.60]:
            d_m = round(est_distance_m * frac, 1)
            px = cam_x + d_m * math.sin(target_bearing_rad)
            py = cam_y + d_m * math.cos(target_bearing_rad)
            raw_z = _sample_dem_elevation(src, px, py)
            if frac <= 1.0:
                # Smooth street transition from camera observer to target
                interp_street = cam_street_elev + frac * (eff_target_z - cam_street_elev)
                eff_z = min(raw_z, interp_street)
            elif frac <= 1.3:
                eff_z = min(raw_z, eff_target_z + (frac - 1.0) * 0.35)
            else:
                eff_z = raw_z
            profile_points.append(
                {
                    "dist_m": d_m,
                    "ground_m": round(eff_z, 2),
                    "wse_m": round(wse, 2),
                    "depth_m": round(max(0.0, wse - eff_z), 2),
                }
            )

        full_win = Window(0, 0, src.width, src.height)
        raw_win = from_bounds(
            min(cam_x, target_x) - search_radius_m,
            min(cam_y, target_y) - search_radius_m,
            max(cam_x, target_x) + search_radius_m,
            max(cam_y, target_y) + search_radius_m,
            src.transform,
        )
        win = raw_win.intersection(full_win).round_offsets().round_lengths()

        corridor_geom = LineString([(cam_x, cam_y), (target_x, target_y)]).buffer(
            max(28.0, min(52.0, est_distance_m * 0.78))
        )
        corridor_probe = LineString([(cam_x, cam_y), (target_x, target_y)]).buffer(68.0)

        poly_low = Polygon()
        poly_med = Polygon()
        poly_crit = Polygon()

        if win.width >= 3 and win.height >= 3:
            dem_sub_raw = src.read(1, window=win)
            dem_sub = _bare_earth_filter_3x3(dem_sub_raw, src.nodata)
            win_transform = src.window_transform(win)

            valid_dem = (dem_sub_raw != src.nodata) & (dem_sub_raw > -100)
            # Physical depth: WSE - bare-earth DEM elevation per SPEC.md
            raw_depth_grid = np.where(valid_dem, np.maximum(0.0, float(wse) - dem_sub), 0.0)

            # Connected flood fill: cells where bare-earth DEM <= WSE and depth >= 0.05m
            flooded_cells = valid_dem & (dem_sub <= wse) & (raw_depth_grid >= 0.05)
            lbl, num_features = label(flooded_cells)

            inv_win = ~win_transform
            tc_f, tr_f = inv_win * (target_x, target_y)
            tc = int(np.clip(np.round(tc_f), 0, dem_sub.shape[1] - 1))
            tr = int(np.clip(np.round(tr_f), 0, dem_sub.shape[0] - 1))

            target_lbl = lbl[tr, tc]
            if target_lbl == 0:
                r_min = max(0, tr - 3)
                r_max = min(dem_sub.shape[0], tr + 4)
                c_min = max(0, tc - 3)
                c_max = min(dem_sub.shape[1], tc + 4)
                sub_lbl = lbl[r_min:r_max, c_min:c_max]
                non_zero = sub_lbl[sub_lbl > 0]
                if len(non_zero) > 0:
                    target_lbl = np.bincount(non_zero).argmax()

            cc_f, cr_f = inv_win * (cam_x, cam_y)
            cc = int(np.clip(np.round(cc_f), 0, dem_sub.shape[1] - 1))
            cr = int(np.clip(np.round(cr_f), 0, dem_sub.shape[0] - 1))
            cam_lbl = lbl[cr, cc]

            connected_ids = [i for i in [target_lbl, cam_lbl] if i > 0]
            if connected_ids:
                connected_mask = np.isin(lbl, connected_ids)
            else:
                connected_mask = flooded_cells

            depth_grid = np.where(connected_mask, raw_depth_grid, 0.0)

            mask_total = depth_grid >= 0.05
            mask_med_plus = depth_grid >= 0.50
            mask_crit = depth_grid > 1.50

            clean_total = _mask_to_clean_zone_geom(
                mask_total, win_transform, corridor_geom, corridor_probe, include_corridor=(water_depth_m > 0.05)
            )
            clean_med_plus = _mask_to_clean_zone_geom(
                mask_med_plus, win_transform, corridor_geom, corridor_probe, include_corridor=(water_depth_m > 0.50)
            )
            clean_crit = _mask_to_clean_zone_geom(
                mask_crit, win_transform, corridor_geom, corridor_probe, include_corridor=(water_depth_m > 1.50)
            )

            # Ensure topological nesting: crit <= med_plus <= total
            if not clean_crit.is_empty:
                clean_med_plus = unary_union([clean_med_plus, clean_crit.buffer(2.0)])
            if not clean_med_plus.is_empty:
                clean_total = unary_union([clean_total, clean_med_plus.buffer(2.0)])

            poly_crit = clean_crit.buffer(0)
            poly_med = clean_med_plus.difference(poly_crit).buffer(0) if not clean_med_plus.is_empty else Polygon()
            poly_low = clean_total.difference(clean_med_plus).buffer(0) if not clean_total.is_empty else Polygon()

    tier_Specs = [
        (
            "low",
            "< 0.5 m (Low)",
            "#1e7b4f",
            "#155e3b",
            poly_low,
            round(min(0.45, max(0.15, float(water_depth_m) * 0.45)), 2),
        ),
        (
            "medium",
            "0.5–1.5 m (Medium)",
            "#d97706",
            "#b45309",
            poly_med,
            round(min(1.45, max(0.55, float(water_depth_m) * 0.85)), 2),
        ),
        (
            "critical",
            "> 1.5 m (Critical)",
            "#c4242a",
            "#991b1b",
            poly_crit,
            round(max(1.55, float(water_depth_m)), 2),
        ),
    ]

    tier_records = []
    for r_tier, z_label, f_col, o_col, z_geom, rep_depth in tier_Specs:
        if z_geom is not None and not z_geom.is_empty and z_geom.area >= 15.0:
            tier_records.append(
                {
                    "geometry": z_geom,
                    "risk_tier": r_tier,
                    "zone_label": z_label,
                    "fill_color": f_col,
                    "line_color": o_col,
                    "wse_m": round(wse, 2),
                    "ground_m": round(ground_elev, 2),
                    "depth_m": rep_depth,
                    "max_dpth_m": round(float(water_depth_m) * 1.15, 2),
                    "area_sqm": round(float(z_geom.area), 1),
                    "barangay": resolved_barangay,
                }
            )

    if not tier_records:
        fallback_tier = "critical" if water_depth_m > 1.5 else ("medium" if water_depth_m >= 0.5 else "low")
        fallback_col = "#c4242a" if fallback_tier == "critical" else ("#d97706" if fallback_tier == "medium" else "#1e7b4f")
        fallback_geom = corridor_geom.union(Point(target_x, target_y).buffer(65.0))
        tier_records.append(
            {
                "geometry": fallback_geom,
                "risk_tier": fallback_tier,
                "zone_label": f"{water_depth_m:.2f} m",
                "fill_color": fallback_col,
                "line_color": fallback_col,
                "wse_m": round(wse, 2),
                "ground_m": round(ground_elev, 2),
                "depth_m": round(float(water_depth_m), 2),
                "max_dpth_m": round(float(water_depth_m), 2),
                "area_sqm": round(float(fallback_geom.area), 1),
                "barangay": resolved_barangay,
            }
        )

    gdf_connected = gpd.GeoDataFrame(tier_records, crs="EPSG:32651")
    flood_area_sqm = round(float(gdf_connected.geometry.area.sum()), 1)

    safe_run_id = "".join(c for c in (run_id or "latest") if c.isalnum() or c in ("_", "-")) or "latest"
    out_path = Path(output_dir)
    out_path.mkdir(parents=True, exist_ok=True)
    zip_path = out_path / f"flood_extent_{safe_run_id}.zip"
    geojson_path = out_path / f"flood_extent_{safe_run_id}.geojson"

    gdf_wgs84 = gdf_connected.to_crs("EPSG:4326")
    flood_geojson_dict = gdf_wgs84.__geo_interface__

    # Write shapefile components inside an isolated temp dir to avoid Windows WinError 32 file lock collisions
    tmp_dir = out_path / f"_tmp_{safe_run_id}_{uuid.uuid4().hex[:8]}"
    try:
        tmp_dir.mkdir(parents=True, exist_ok=True)
        tmp_shp_base = tmp_dir / f"flood_extent_{safe_run_id}"
        gdf_connected.to_file(tmp_shp_base.with_suffix(".shp"))

        tmp_zip = tmp_dir / f"flood_extent_{safe_run_id}.zip"
        with zipfile.ZipFile(tmp_zip, "w", zipfile.ZIP_DEFLATED) as zf:
            for ext in [".shp", ".shx", ".dbf", ".prj", ".cpg"]:
                f = tmp_shp_base.with_suffix(ext)
                if f.exists():
                    zf.write(f, arcname=f.name)

        with _EXPORT_LOCK:
            try:
                shutil.copyfile(tmp_zip, zip_path)
            except PermissionError:
                pass
            try:
                geojson_path.write_text(json.dumps(flood_geojson_dict), encoding="utf-8")
            except PermissionError:
                pass
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    target_lon, target_lat = to_wgs84.transform(target_x, target_y)

    inundation_data = get_inundated_structures(
        wse_m=wse,
        barangay=resolved_barangay,
        flood_gdf_utm=gdf_connected,
        center_utm=(target_x, target_y),
        water_depth_m=water_depth_m,
    )

    ray_geojson = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "run_id": safe_run_id,
                    "est_distance_m": round(est_distance_m, 1),
                    "azimuth_deg": round(azimuth_deg, 1),
                    "click_u": round(click_u, 3),
                    "water_depth_m": round(water_depth_m, 2),
                    "wse_m": round(wse, 2),
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": [
                        [round(cam_lon, 6), round(cam_lat, 6)],
                        [round(target_lon, 6), round(target_lat, 6)],
                    ],
                },
            }
        ],
    }

    return {
        "run_id": safe_run_id,
        "target_lat": round(target_lat, 6),
        "target_lon": round(target_lon, 6),
        "ground_dem_m": round(eff_target_z, 2),
        "cam_ground_dem_m": round(cam_street_elev, 2),
        "camera_in_water": True,
        "profile_points": profile_points,
        "measured_depth_m": round(water_depth_m, 2),
        "water_surface_elev_m": round(wse, 2),
        "flood_area_sqm": flood_area_sqm,
        "flood_geojson": flood_geojson_dict,
        "buildings_geojson": inundation_data["buildings_geojson"],
        "ray_geojson": ray_geojson,
        "inundated_structures": inundation_data["summary"],
        "zip_shapefile_path": str(zip_path),
        "download_shp_url": f"/api/v1/download-shp/{safe_run_id}",
    }


BUILDINGS_SHP_PATH = DATA_DIR / "Buildings.shp"
ENRICHED_BUILDINGS_PATH = DATA_DIR / "rodriguez_buildings_enriched.parquet"
_OSM_BUILDINGS_GDF: Optional[gpd.GeoDataFrame] = None
_OSM_BUILDINGS_LOCK = threading.Lock()

_TYPE_DISPLAY_HEIGHT_M = {
    "school": 9.0,
    "college": 9.0,
    "university": 9.0,
    "hospital": 10.0,
    "church": 10.0,
    "commercial": 8.0,
    "retail": 7.0,
    "industrial": 8.0,
    "warehouse": 8.0,
    "apartments": 10.0,
    "garage": 3.0,
    "shed": 3.0,
    "roof": 3.5,
    "education": 9.0,
    "healthcare": 10.0,
    "emergency_civic": 8.0,
    "religious": 10.0,
    "commercial_logistics": 8.0,
    "residential": 5.0,
}


def _load_osm_buildings() -> Optional[gpd.GeoDataFrame]:
    """
    Loads the real OSM building footprints from backend/data/Buildings.shp (or cached
    rodriguez_buildings_enriched.parquet). Every footprint is enriched with:
      - building_id, building_name, building_type
      - infra_category (healthcare, education, emergency_civic, religious, commercial_logistics, residential)
      - is_evac_center, evac_center_name (matched against evacuationcenters.csv)
      - barangay (spatially joined against political_boundary_rodriguez.shp)
      - footprint_sqm, height_m
      - ground_elev_m (3x3 DEM bare-earth minimum)
    """
    global _OSM_BUILDINGS_GDF
    if _OSM_BUILDINGS_GDF is not None:
        return _OSM_BUILDINGS_GDF

    with _OSM_BUILDINGS_LOCK:
        if _OSM_BUILDINGS_GDF is not None:
            return _OSM_BUILDINGS_GDF

        # 1. Fast path: load pre-enriched parquet if available
        if ENRICHED_BUILDINGS_PATH.exists():
            try:
                gdf = gpd.read_parquet(ENRICHED_BUILDINGS_PATH)
                required = [
                    "building_id", "building_name", "building_type", "infra_category",
                    "is_evac_center", "evac_center_name", "barangay", "footprint_sqm",
                    "height_m", "ground_elev_m", "geometry"
                ]
                if all(col in gdf.columns for col in required):
                    _ = gdf.sindex
                    _OSM_BUILDINGS_GDF = gdf
                    return _OSM_BUILDINGS_GDF
            except Exception:
                pass

        if not BUILDINGS_SHP_PATH.exists():
            return None

        # 2. Enrich raw Buildings.shp
        gdf = gpd.read_file(BUILDINGS_SHP_PATH)
        if gdf.crs is None or gdf.crs.to_epsg() != 32651:
            gdf = gdf.set_crs("EPSG:32651", allow_override=True) if gdf.crs is None else gdf.to_crs("EPSG:32651")
        gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty].copy()

        osm_ids = gdf["osm_id"].astype(str) if "osm_id" in gdf.columns else pd.Series(gdf.index.astype(str), index=gdf.index)
        gdf["building_id"] = "OSM-" + osm_ids

        raw_type = gdf["type"].fillna("").astype(str).str.lower() if "type" in gdf.columns else pd.Series([""] * len(gdf), index=gdf.index)
        raw_name = gdf["name"].fillna("").astype(str) if "name" in gdf.columns else pd.Series([""] * len(gdf), index=gdf.index)
        name_lower = raw_name.str.lower()
        gdf["building_name"] = raw_name

        # Spatial join with political boundaries
        brgy_path = ROOT_DIR / "boundary" / "political_boundary_rodriguez.shp"
        if brgy_path.exists():
            try:
                brgy = gpd.read_file(brgy_path)
                if brgy.crs != gdf.crs:
                    brgy = brgy.to_crs(gdf.crs)
                joined_brgy = gpd.sjoin(gdf, brgy[["Barangay", "geometry"]], how="left", predicate="intersects")
                joined_brgy = joined_brgy[~joined_brgy.index.duplicated(keep="first")]
                gdf["barangay"] = joined_brgy["Barangay"].fillna("SAN JOSE").astype(str).str.upper()
            except Exception:
                gdf["barangay"] = "SAN JOSE"
        else:
            gdf["barangay"] = "SAN JOSE"

        # Match with official evacuation centers
        gdf["evac_center_name"] = ""
        gdf["is_evac_center"] = False
        ec_path = DATA_DIR / "evacuationcenters.csv"
        if ec_path.exists():
            try:
                ec_df = pd.read_csv(ec_path)
                ec_pts = gpd.GeoDataFrame(
                    ec_df,
                    geometry=[Point(xy) for xy in zip(ec_df["x"], ec_df["y"])],
                    crs="EPSG:4326"
                ).to_crs(gdf.crs)
                ec_match = gpd.sjoin_nearest(gdf, ec_pts, max_distance=35, how="left", distance_col="ec_dist_m")
                ec_match = ec_match[~ec_match.index.duplicated(keep="first")]
                gdf["evac_center_name"] = ec_match["ec"].fillna("").astype(str)
                gdf["is_evac_center"] = gdf["evac_center_name"] != ""
            except Exception:
                pass

        # Infrastructure categorization
        infra_cat = pd.Series("residential", index=gdf.index)
        is_health = (
            raw_type.isin(["hospital", "clinic"]) |
            name_lower.str.contains("hospital|clinic|health center|rural health|rhu|medical", regex=True)
        )
        infra_cat[is_health] = "healthcare"

        is_edu = (
            raw_type.isin(["school", "university", "college", "kindergarten"]) |
            name_lower.str.contains("school|elementary|high school|college|university|academy|learning center", regex=True)
        )
        infra_cat[is_edu] = "education"

        is_civic = (
            raw_type.isin(["public", "civic"]) |
            name_lower.str.contains("barangay hall|brgy hall|municipal hall|municipal gym|police|pnp|fire|bfp|mdrrmo|disaster|covered court|gymnasium|court|tourism office|hall|guard house|guardhouse", regex=True)
        )
        infra_cat[is_civic] = "emergency_civic"

        is_religion = (
            raw_type.isin(["church", "chapel", "mosque"]) |
            name_lower.str.contains("church|parish|chapel|kapilya|mosque|iglesia|cathedral", regex=True)
        )
        infra_cat[is_religion] = "religious"

        is_comm = (
            raw_type.isin(["commercial", "retail", "supermarket", "warehouse", "industrial"]) |
            name_lower.str.contains("market|supermarket|mall|center|commercial|gasoline|caltex|seaoil|petron|shell|store|warehouse|terminal", regex=True)
        )
        infra_cat[is_comm] = "commercial_logistics"

        # Evacuation center facilities are critical civic/emergency infra
        infra_cat[gdf["is_evac_center"] & ~is_health & ~is_edu & ~is_civic] = "emergency_civic"
        gdf["infra_category"] = infra_cat

        type_labels = {
            "healthcare": "Hospital / Clinic",
            "education": "School / Educational",
            "emergency_civic": "Civic / Emergency Center",
            "religious": "Place of Worship",
            "commercial_logistics": "Commercial / Logistics Hub",
            "residential": "Residential Building",
        }
        clean_raw_type = raw_type.replace({"": np.nan})
        gdf["building_type"] = clean_raw_type.fillna(gdf["infra_category"].map(type_labels))

        gdf["height_m"] = raw_type.map(_TYPE_DISPLAY_HEIGHT_M).fillna(gdf["infra_category"].map(_TYPE_DISPLAY_HEIGHT_M)).fillna(5.0)
        gdf["footprint_sqm"] = gdf.geometry.area.round(1)

        # Vectorized bare-earth DEM sampling
        cents = gdf.geometry.centroid
        with rasterio.open(ensure_dem_exists()) as src:
            dem = src.read(1).astype(np.float32)
            nodata = src.nodata if src.nodata is not None else -9999.0
            dem = np.where((dem == nodata) | (dem < -100), np.nan, dem)
            inv = ~src.transform
            cols_f, rows_f = inv * (cents.x.to_numpy(), cents.y.to_numpy())
            rows = np.clip(np.floor(rows_f).astype(int), 1, src.height - 2)
            cols = np.clip(np.floor(cols_f).astype(int), 1, src.width - 2)
        stack = np.stack(
            [dem[rows + dr, cols + dc] for dr in (-1, 0, 1) for dc in (-1, 0, 1)],
            axis=0,
        )
        with np.errstate(all="ignore"):
            ground = np.nanmin(stack, axis=0)
        fallback = np.nanmedian(dem) if np.isfinite(np.nanmedian(dem)) else 30.0
        gdf["ground_elev_m"] = np.round(np.where(np.isfinite(ground), ground, fallback), 2).astype(np.float32)

        keep = [
            "building_id", "building_name", "building_type", "infra_category",
            "is_evac_center", "evac_center_name", "barangay", "footprint_sqm",
            "height_m", "ground_elev_m", "geometry"
        ]
        gdf = gdf[keep].reset_index(drop=True)
        try:
            gdf.to_parquet(ENRICHED_BUILDINGS_PATH)
        except Exception:
            pass

        _ = gdf.sindex
        _OSM_BUILDINGS_GDF = gdf
        return _OSM_BUILDINGS_GDF


_TIER_RANGES = {
    "critical": (1.51, 6.0, "#c4242a"),
    "medium": (0.50, 1.50, "#d97706"),
    "low": (0.05, 0.49, "#1e7b4f"),
}


def get_inundated_structures(
    wse_m: float,
    barangay: str,
    flood_gdf_utm: Optional[gpd.GeoDataFrame] = None,
    center_utm: Optional[Tuple[float, float]] = None,
    water_depth_m: Optional[float] = None,
    radius_m: float = 380.0,
) -> Dict[str, Any]:
    """
    Spatial join between the DEM flood extent and the enriched OSM building footprints
    (Buildings.shp), accurately identifying affected infrastructures:
      - Critical facilities: schools, clinics, barangay/municipal halls, evacuation centers
      - Physical flood depth: WSE - bare-earth DEM ground elevation
      - Risk tiers: Critical (>1.5m), Medium (0.5m-1.5m), Low (<0.5m), Safe
    """
    if center_utm is None:
        zone = next((z for z in SCENARIO_ZONES if z["barangay"].upper() == barangay.upper()), SCENARIO_ZONES[0])
        center_utm = to_utm.transform(zone["center_lon"], zone["center_lat"])
    cx, cy = center_utm

    osm = _load_osm_buildings()
    if osm is None or osm.empty:
        sub_gdf = gpd.GeoDataFrame(
            {"building_id": [], "building_name": [], "building_type": [], "infra_category": [],
             "is_evac_center": [], "evac_center_name": [], "barangay": [], "footprint_sqm": [],
             "height_m": [], "ground_elev_m": []},
            geometry=[],
            crs="EPSG:32651",
        )
    else:
        minx, miny, maxx, maxy = cx - radius_m, cy - radius_m, cx + radius_m, cy + radius_m
        if flood_gdf_utm is not None and not flood_gdf_utm.empty:
            f_minx, f_miny, f_maxx, f_maxy = flood_gdf_utm.total_bounds
            minx = min(minx, f_minx - 60.0)
            miny = min(miny, f_miny - 60.0)
            maxx = max(maxx, f_maxx + 60.0)
            maxy = max(maxy, f_maxy + 60.0)
        query_box = box(minx, miny, maxx, maxy)
        idx = osm.sindex.query(query_box, predicate="intersects")
        sub_gdf = osm.iloc[idx].copy()

    zone_geoms: Dict[str, Any] = {"critical": Polygon(), "medium": Polygon(), "low": Polygon()}
    zone_areas = {"critical": 0.0, "medium": 0.0, "low": 0.0}
    if flood_gdf_utm is not None and not flood_gdf_utm.empty and "risk_tier" in flood_gdf_utm.columns:
        for tier in zone_geoms:
            rows = flood_gdf_utm[flood_gdf_utm["risk_tier"] == tier]
            if not rows.empty:
                zone_geoms[tier] = unary_union(rows.geometry)
                zone_areas[tier] = round(float(zone_geoms[tier].area), 1)

    has_zones = any(not g.is_empty for g in zone_geoms.values())
    n = len(sub_gdf)
    tiers = np.array(["safe"] * n, dtype=object)
    raw_depth = np.round(np.maximum(0.0, float(wse_m) - sub_gdf["ground_elev_m"].to_numpy()), 2) if n > 0 else np.array([])

    if n > 0:
        if has_zones:
            # Building intersects flood polygon and has physical depth >= 0.05m
            for tier in ("low", "medium", "critical"):
                geom = zone_geoms[tier]
                if geom.is_empty:
                    continue
                hit = sub_gdf.geometry.intersects(geom).to_numpy()
                tiers[hit & (raw_depth >= 0.05)] = tier
        else:
            tiers = np.where(raw_depth > 1.5, "critical", np.where(raw_depth >= 0.5, "medium", np.where(raw_depth >= 0.05, "low", "safe")))

    # True unclipped physical building depth: WSE - ground_elev_m per SPEC.md
    depths = np.where(tiers != "safe", raw_depth, 0.0)
    colors = np.where(
        tiers == "critical", "#c4242a",
        np.where(tiers == "medium", "#d97706",
        np.where(tiers == "low", "#1e7b4f", "#94a3b8"))
    )

    sub_gdf["risk_tier"] = tiers
    sub_gdf["flood_depth_m"] = np.round(depths, 2)
    sub_gdf["extrusion_color"] = colors
    sub_gdf["wse_m"] = round(float(wse_m), 2)

    low_count = int((tiers == "low").sum())
    med_count = int((tiers == "medium").sum())
    crit_count = int((tiers == "critical").sum())
    safe_count = int((tiers == "safe").sum())
    affected_mask = np.isin(tiers, ["low", "medium", "critical"])
    affected_footprint_sqm = round(float(sub_gdf.loc[affected_mask, "footprint_sqm"].sum()), 1) if n > 0 else 0.0

    affected_bldgs = sub_gdf[affected_mask] if n > 0 else sub_gdf
    affected_count = int(affected_mask.sum())

    # Infrastructure breakdown
    if affected_count > 0:
        schools_count = int((affected_bldgs["infra_category"] == "education").sum())
        healthcare_count = int((affected_bldgs["infra_category"] == "healthcare").sum())
        civic_count = int((affected_bldgs["infra_category"] == "emergency_civic").sum())
        commercial_count = int((affected_bldgs["infra_category"] == "commercial_logistics").sum())
        religious_count = int((affected_bldgs["infra_category"] == "religious").sum())
        residential_count = int((affected_bldgs["infra_category"] == "residential").sum())

        evac_sub = affected_bldgs[affected_bldgs["is_evac_center"] == True]
        evac_count = int(len(evac_sub))
        compromised_evac_centers = [name for name in evac_sub["evac_center_name"].unique() if name]
    else:
        schools_count = healthcare_count = civic_count = commercial_count = religious_count = residential_count = evac_count = 0
        compromised_evac_centers = []

    sub_wgs84 = sub_gdf.to_crs("EPSG:4326")

    # Critical infrastructure highlight records
    critical_infras = []
    if affected_count > 0:
        special_mask = (
            (affected_bldgs["is_evac_center"] == True) |
            (affected_bldgs["infra_category"] != "residential") |
            (affected_bldgs["building_name"] != "")
        )
        spec = affected_bldgs[special_mask].copy()
        if spec.empty:
            spec = affected_bldgs.copy()

        # Prioritize evacuation centers, healthcare, emergency civic, education, then depth
        cat_order = {"healthcare": 1, "emergency_civic": 2, "education": 3, "religious": 4, "commercial_logistics": 5, "residential": 6}
        spec["_cat_rank"] = spec["infra_category"].map(cat_order).fillna(9)
        spec["_evac_rank"] = np.where(spec["is_evac_center"], 0, 1)
        spec_sorted = spec.sort_values(by=["_evac_rank", "_cat_rank", "flood_depth_m"], ascending=[True, True, False])

        for _, r in spec_sorted.head(10).iterrows():
            name = r["building_name"]
            if not name and r["is_evac_center"]:
                name = r["evac_center_name"]
            if not name:
                name = f"{r['building_type']} ({r['building_id']})"
            critical_infras.append({
                "building_id": str(r["building_id"]),
                "building_name": str(name),
                "building_type": str(r["building_type"]),
                "infra_category": str(r["infra_category"]),
                "barangay": str(r["barangay"]),
                "is_evac_center": bool(r["is_evac_center"]),
                "evac_center_name": str(r["evac_center_name"]),
                "flood_depth_m": float(r["flood_depth_m"]),
                "ground_elev_m": float(r["ground_elev_m"]),
                "footprint_sqm": float(r["footprint_sqm"]),
                "risk_tier": str(r["risk_tier"]),
            })

    # Critical buildings for Muse Glimmer dispatch tickets (top 6 prioritized by infra importance and depth)
    if affected_count > 0:
        aff_wgs84 = sub_wgs84[affected_mask].copy()
        aff_wgs84["_evac_rank"] = np.where(aff_wgs84["is_evac_center"], 0, 1)
        cat_order = {"healthcare": 1, "emergency_civic": 2, "education": 3, "religious": 4, "commercial_logistics": 5, "residential": 6}
        aff_wgs84["_cat_rank"] = aff_wgs84["infra_category"].map(cat_order).fillna(9)
        aff_sorted = aff_wgs84.sort_values(by=["_evac_rank", "_cat_rank", "flood_depth_m"], ascending=[True, True, False])
        critical_buildings = aff_sorted.drop(columns=["geometry", "_evac_rank", "_cat_rank"], errors="ignore").head(6).to_dict(orient="records")
    else:
        critical_buildings = []

    summary = {
        "barangay": barangay.upper(),
        "wse_m": round(float(wse_m), 2),
        "total_structures": int(n),
        "low_depth_count": low_count,
        "medium_depth_count": med_count,
        "critical_depth_count": crit_count,
        "safe_count": safe_count,
        "affected_structures": affected_count,
        "affected_footprint_sqm": affected_footprint_sqm,
        "low_area_sqm": zone_areas["low"],
        "medium_area_sqm": zone_areas["medium"],
        "critical_area_sqm": zone_areas["critical"],
        "building_source": "OSM Buildings.shp (Enriched)",
        "affected_schools_count": schools_count,
        "affected_healthcare_count": healthcare_count,
        "affected_civic_count": civic_count,
        "affected_evac_centers_count": evac_count,
        "affected_commercial_count": commercial_count,
        "affected_religious_count": religious_count,
        "affected_residential_count": residential_count,
        "compromised_evac_centers": compromised_evac_centers,
        "critical_infras": critical_infras,
    }

    return {
        "summary": summary,
        "buildings_geojson": sub_wgs84.__geo_interface__,
        "critical_buildings": critical_buildings,
    }


_ROAD_SHP_GRAPH: Optional[nx.Graph] = None
_ROAD_NODE_LIST: List[Tuple[float, float]] = []
_ROAD_NODE_ARRAY: Optional[np.ndarray] = None
_ROAD_SHP_GDF_UTM: Optional[gpd.GeoDataFrame] = None


def _get_road_shapefile_gdf_utm() -> Optional[gpd.GeoDataFrame]:
    """Loads and caches the road shapefile in EPSG:32651 for street-clearance filtering."""
    global _ROAD_SHP_GDF_UTM
    if _ROAD_SHP_GDF_UTM is not None:
        return _ROAD_SHP_GDF_UTM

    candidate_paths: List[Path] = []
    roads_dir = ROOT_DIR / "roads"
    if roads_dir.exists():
        candidate_paths.extend(sorted(roads_dir.glob("*.shp")))
    candidate_paths.extend([DATA_DIR / "roads.shp", DATA_DIR / "rodriguez_roads.shp"])
    shp_path = next((p for p in candidate_paths if p.exists()), None)
    if shp_path is None:
        return None
    try:
        _ROAD_SHP_GDF_UTM = gpd.read_file(shp_path).to_crs("EPSG:32651")
        return _ROAD_SHP_GDF_UTM
    except Exception:
        return None


def _get_road_shapefile_graph() -> Tuple[Optional[nx.Graph], List[Tuple[float, float]], Optional[np.ndarray]]:
    """
    Loads a roads ESRI Shapefile (.shp) from:
      1) ./roads/*.shp (if user provides a custom road shapefile)
      2) ./backend/data/roads.shp
      3) ./backend/data/rodriguez_roads.shp (38,764-vertex real street network of Montalban)
    Builds a cached vertex-level networkx.Graph so routes follow actual street geometry
    curve-for-curve and never cut across buildings or blocks.
    """
    global _ROAD_SHP_GRAPH, _ROAD_NODE_LIST, _ROAD_NODE_ARRAY
    if _ROAD_SHP_GRAPH is not None and _ROAD_NODE_ARRAY is not None:
        return _ROAD_SHP_GRAPH, _ROAD_NODE_LIST, _ROAD_NODE_ARRAY

    candidate_paths: List[Path] = []
    roads_dir = ROOT_DIR / "roads"
    if roads_dir.exists():
        candidate_paths.extend(sorted(roads_dir.glob("*.shp")))
    candidate_paths.extend(
        [
            DATA_DIR / "roads.shp",
            DATA_DIR / "rodriguez_roads.shp",
        ]
    )

    shp_path = next((p for p in candidate_paths if p.exists()), None)
    if shp_path is None:
        return None, [], None

    try:
        gdf = gpd.read_file(shp_path).to_crs("EPSG:4326")
        G = nx.Graph()
        for _, row in gdf.iterrows():
            geom = row.geometry
            if geom is None or geom.is_empty:
                continue
            lines = geom.geoms if geom.geom_type == "MultiLineString" else [geom]
            raw_name = row.get("name") or row.get("ROAD_NAME") or row.get("highway") or "Montalban Road"
            road_name = str(raw_name) if raw_name and str(raw_name) != "nan" else "Montalban Road"
            for line in lines:
                pts = list(line.coords)
                for i in range(len(pts) - 1):
                    u = (round(float(pts[i][0]), 5), round(float(pts[i][1]), 5))
                    v = (round(float(pts[i + 1][0]), 5), round(float(pts[i + 1][1]), 5))
                    if u == v:
                        continue
                    dx_m = (u[0] - v[0]) * 107600.0
                    dy_m = (u[1] - v[1]) * 110600.0
                    seg_len = max(1.0, round(math.hypot(dx_m, dy_m), 2))
                    G.add_edge(u, v, length=seg_len, weight=seg_len, name=road_name)

        if G.number_of_nodes() > 0:
            largest_cc = max(nx.connected_components(G), key=len)
            G = G.subgraph(largest_cc).copy()
            _ROAD_SHP_GRAPH = G
            _ROAD_NODE_LIST = list(G.nodes())
            _ROAD_NODE_ARRAY = np.array(_ROAD_NODE_LIST, dtype=np.float64)
            return _ROAD_SHP_GRAPH, _ROAD_NODE_LIST, _ROAD_NODE_ARRAY
    except Exception:
        pass

    return None, [], None


def _snap_to_road_node(
    lon: float,
    lat: float,
    node_list: List[Tuple[float, float]],
    node_arr: np.ndarray,
) -> Tuple[float, float]:
    """Fast vectorized nearest-vertex lookup on the road shapefile graph."""
    dx = (node_arr[:, 0] - lon) * 107600.0
    dy = (node_arr[:, 1] - lat) * 110600.0
    dist_sq = dx * dx + dy * dy
    idx = int(np.argmin(dist_sq))
    return node_list[idx]


def compute_safe_rescue_route(
    origin_lat: float,
    origin_lon: float,
    dest_lat: float,
    dest_lon: float,
    max_passable_depth_m: float = 0.5,
    wse_m: Optional[float] = None,
) -> Dict[str, Any]:
    """
    Computes the shortest safe rescue route between the nearest evacuation center
    (from backend/data/evacuationcenters.csv) and the flooded target along the
    exact road shapefile geometry (backend/data/rodriguez_roads.shp or ./roads/*.shp).
    """
    ensure_spatial_assets()
    ox_utm, oy_utm = to_utm.transform(origin_lon, origin_lat)
    dx_utm, dy_utm = to_utm.transform(dest_lon, dest_lat)

    with rasterio.open(ensure_dem_exists()) as src:
        dest_ground_m = _sample_dem_elevation(src, dx_utm, dy_utm)
    if wse_m is None:
        wse_m = dest_ground_m + 1.2
    target_water_depth_m = max(0.0, float(wse_m) - dest_ground_m)

    G_shp, node_list, node_arr = _get_road_shapefile_graph()
    if G_shp is not None and node_arr is not None and len(node_list) > 0:
        orig_node = _snap_to_road_node(origin_lon, origin_lat, node_list, node_arr)
        dest_node = _snap_to_road_node(dest_lon, dest_lat, node_list, node_arr)

        # Extract local spatial road subgraph for fast routing (<10ms)
        mid_lon = (orig_node[0] + dest_node[0]) / 2.0
        mid_lat = (orig_node[1] + dest_node[1]) / 2.0
        span_m = max(1100.0, math.hypot((orig_node[0] - dest_node[0]) * 107600.0, (orig_node[1] - dest_node[1]) * 110600.0) * 1.45)

        dx_mid = (node_arr[:, 0] - mid_lon) * 107600.0
        dy_mid = (node_arr[:, 1] - mid_lat) * 110600.0
        mask_local = (dx_mid * dx_mid + dy_mid * dy_mid) <= (span_m * span_m)
        local_nodes = [node_list[i] for i in np.nonzero(mask_local)[0]]
        G_local = G_shp.subgraph(local_nodes).copy()

        if orig_node not in G_local or dest_node not in G_local or not nx.has_path(G_local, orig_node, dest_node):
            G_local = G_shp

        # Identify flooded road segments near the target (within 130m of target)
        severed_features = []
        G_detour = G_local.copy()

        for u, v, data in G_local.edges(data=True):
            mx = (u[0] + v[0]) / 2.0
            my = (u[1] + v[1]) / 2.0
            dist_to_target = math.hypot((mx - dest_lon) * 107600.0, (my - dest_lat) * 110600.0)
            if dist_to_target <= 125.0 and target_water_depth_m > 0.50:
                edge_depth = round(target_water_depth_m * max(0.45, 1.0 - dist_to_target / 160.0), 2)
                if edge_depth > 0.50:
                    severed_features.append(
                        {
                            "type": "Feature",
                            "properties": {
                                "road_name": data.get("name", "Montalban Road"),
                                "flood_depth_m": edge_depth,
                                "max_passable_m": round(max_passable_depth_m, 2),
                                "status": "SEVERED",
                            },
                            "geometry": {
                                "type": "LineString",
                                "coordinates": [[u[0], u[1]], [v[0], v[1]]],
                            },
                        }
                    )
                    # Remove flooded segments for low-clearance wheeled trucks (<=0.6m); amphibious boats traverse shortest street path
                    if dist_to_target > 35.0 and u != dest_node and v != dest_node and max_passable_depth_m <= 0.6:
                        G_detour.remove_edge(u, v)

        # If wheeled truck (max_passable_depth_m <= 0.6) faces deep floodwater (>0.85m), mark primary route severed
        if max_passable_depth_m <= 0.6 and target_water_depth_m > 0.85 and len(severed_features) > 0:
            return {
                "route_found": False,
                "severed_segments_count": len(severed_features),
                "route_distance_m": 0.0,
                "eta_minutes": 0.0,
                "route_geojson": {"type": "FeatureCollection", "features": []},
                "severed_roads_geojson": {"type": "FeatureCollection", "features": severed_features[:40]},
            }

        path_nodes: List[Tuple[float, float]] = []
        try:
            if nx.has_path(G_detour, orig_node, dest_node):
                path_nodes = nx.shortest_path(G_detour, orig_node, dest_node, weight="weight")
            else:
                path_nodes = nx.shortest_path(G_local, orig_node, dest_node, weight="length")
        except (nx.NetworkXNoPath, nx.NodeNotFound):
            path_nodes = []

        if len(path_nodes) >= 2:
            coords = [[n[0], n[1]] for n in path_nodes]
            if coords[0] != [round(origin_lon, 6), round(origin_lat, 6)]:
                coords.insert(0, [round(origin_lon, 6), round(origin_lat, 6)])
            if coords[-1] != [round(dest_lon, 6), round(dest_lat, 6)]:
                coords.append([round(dest_lon, 6), round(dest_lat, 6)])
            total_dist = 0.0
            for i in range(1, len(coords)):
                u_pt = coords[i - 1]
                v_pt = coords[i]
                total_dist += math.hypot((v_pt[0] - u_pt[0]) * 107600.0, (v_pt[1] - u_pt[1]) * 110600.0)

            total_dist = max(35.0, round(total_dist, 1))
            speed_mps = 5.5 if max_passable_depth_m <= 0.6 else 3.4
            eta_min = round(total_dist / (speed_mps * 60.0) + 0.8, 1)

            route_geojson = {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {
                            "distance_m": total_dist,
                            "eta_minutes": eta_min,
                            "max_passable_depth_m": max_passable_depth_m,
                            "status": "SAFE_CORRIDOR",
                        },
                        "geometry": {
                            "type": "LineString",
                            "coordinates": coords,
                        },
                    }
                ],
            }

            return {
                "route_found": True,
                "severed_segments_count": len(severed_features),
                "route_distance_m": total_dist,
                "eta_minutes": eta_min,
                "route_geojson": route_geojson,
                "severed_roads_geojson": {"type": "FeatureCollection", "features": severed_features[:40]},
            }

    # Fallback if shapefile is missing
    coords_fallback = [[round(origin_lon, 6), round(origin_lat, 6)], [round(dest_lon, 6), round(dest_lat, 6)]]
    dist_fallback = max(45.0, round(math.hypot(dx_utm - ox_utm, dy_utm - oy_utm), 1))
    eta_fallback = round(dist_fallback / (3.4 * 60.0) + 0.8, 1)
    return {
        "route_found": True,
        "severed_segments_count": 0,
        "route_distance_m": dist_fallback,
        "eta_minutes": eta_fallback,
        "route_geojson": {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {"distance_m": dist_fallback, "eta_minutes": eta_fallback, "status": "SAFE_CORRIDOR"},
                    "geometry": {"type": "LineString", "coordinates": coords_fallback},
                }
            ],
        },
        "severed_roads_geojson": {"type": "FeatureCollection", "features": []},
    }


def get_barangay_boundaries_geojson() -> Dict[str, Any]:
    """Load Rodriguez political boundary shapefile in EPSG:4326 if available."""
    if BOUNDARY_SHP_PATH.exists():
        gdf = gpd.read_file(BOUNDARY_SHP_PATH).to_crs("EPSG:4326")
        keep_cols = [c for c in ["Barangay", "BRGYNAME", "Population", "CLASS", "geometry"] if c in gdf.columns]
        gdf = gdf[keep_cols].copy()
        if "Population" in gdf.columns:
            gdf["Population"] = gdf["Population"].fillna(0).astype(int)
        # Add representative point coordinates for click/jump navigation
        reps = gdf.geometry.representative_point()
        gdf["center_lon"] = reps.x.round(5)
        gdf["center_lat"] = reps.y.round(5)
        return gdf.__geo_interface__
    return {"type": "FeatureCollection", "features": []}
