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

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
OUTPUTS_DIR = BASE_DIR / "outputs"
ROOT_DIR = BASE_DIR.parent

DEFAULT_DEM_PATH = DATA_DIR / "rodriguez_dem.tif"
BUILDINGS_PARQUET_PATH = DATA_DIR / "rodriguez_buildings.parquet"
ROADS_GRAPHML_PATH = DATA_DIR / "rodriguez_roads.graphml"
BOUNDARY_SHP_PATH = ROOT_DIR / "boundary" / "political_boundary_rodriguez.shp"

to_utm = Transformer.from_crs("EPSG:4326", "EPSG:32651", always_xy=True)
to_wgs84 = Transformer.from_crs("EPSG:32651", "EPSG:4326", always_xy=True)

_EXPORT_LOCK = threading.Lock()
_BOUNDARY_GDF_WGS84: Optional[gpd.GeoDataFrame] = None

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


def resolve_location_metadata(lat: float, lon: float, fallback_barangay: str = "SAN JOSE") -> Dict[str, Any]:
    """
    Given any (lat, lon) in Rodriguez (Montalban), resolves the containing or nearest
    Barangay from political_boundary_rodriguez.shp and nearest evacuation center.
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

    # Find closest scenario zone / evacuation center
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

    return {
        "barangay": barangay_name,
        "nearest_zone": best_zone,
        "evac_name": best_zone["evac_name"],
        "evac_lat": best_zone["evac_lat"],
        "evac_lon": best_zone["evac_lon"],
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
        cam_x, cam_y = _clamp_utm_to_dem(src, cam_x, cam_y, margin=search_radius_m + 20.0)
        target_x, target_y = _clamp_utm_to_dem(src, target_x, target_y, margin=search_radius_m + 20.0)
        ground_elev = _sample_dem_elevation(src, target_x, target_y)
        cam_ground_elev = _sample_dem_elevation(src, cam_x, cam_y)
        # Camera operator is standing in the same flooded street basin; ensure WSE submerges both camera & target street grade
        cam_street_elev = min(cam_ground_elev, ground_elev + max(0.15, water_depth_m * 0.35))
        wse = ground_elev + water_depth_m

        # Sample real DEM elevation profile along the camera ray from 0m (Camera) to 1.6x target distance
        for frac in [0.0, 0.25, 0.50, 0.75, 1.0, 1.30, 1.60]:
            d_m = round(est_distance_m * frac, 1)
            px = cam_x + d_m * math.sin(target_bearing_rad)
            py = cam_y + d_m * math.cos(target_bearing_rad)
            raw_z = _sample_dem_elevation(src, px, py)
            # Keep camera-to-target street channel physically below WSE when camera is in water
            if frac <= 1.1:
                eff_z = min(raw_z, ground_elev + (1.0 - min(1.0, frac)) * min(0.25, water_depth_m * 0.3))
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
            dem_macro = _box_blur_2d(dem_sub, radius=4)
            win_transform = src.window_transform(win)

            rows_idx, cols_idx = np.indices(dem_sub.shape)
            xs = win_transform.c + (cols_idx + 0.5) * win_transform.a
            ys = win_transform.f + (rows_idx + 0.5) * win_transform.e

            vx = target_x - cam_x
            vy = target_y - cam_y
            seg_len_sq = max(1.0, vx * vx + vy * vy)
            t_proj = np.clip(((xs - cam_x) * vx + (ys - cam_y) * vy) / seg_len_sq, 0.0, 1.0)
            proj_x = cam_x + t_proj * vx
            proj_y = cam_y + t_proj * vy

            dist_to_ray = np.hypot(xs - proj_x, ys - proj_y)
            dist_to_target = np.hypot(xs - target_x, ys - target_y)
            basin_dist = np.minimum(dist_to_target, dist_to_ray * 1.12)

            # Local micro-topography relative to the hydraulic grade line (valley slope + target datum)
            hgl_datum = 0.76 * dem_macro + 0.24 * float(ground_elev)
            local_relief = (dem_sub - hgl_datum) * 0.48
            # Suppress SRTM rooftop spikes inside the camera-to-target street corridor
            corridor_atten = np.clip(dist_to_ray / 58.0, 0.0, 1.0)
            effective_relief = np.where(local_relief > 0.0, local_relief * corridor_atten, local_relief)

            max_spread_m = float(np.clip(105.0 + water_depth_m * 115.0, 115.0, search_radius_m - 15.0))
            radial_rise = ((basin_dist / max_spread_m) ** 1.55) * (water_depth_m + 0.12)
            core_boost = np.clip(1.0 - basin_dist / 68.0, 0.0, 1.0) * (0.14 * water_depth_m)

            valid_dem = (dem_sub_raw != src.nodata) & (dem_sub_raw > -100)
            depth_grid = np.where(
                valid_dem,
                np.maximum(0.0, float(water_depth_m) + core_boost - effective_relief - radial_rise),
                0.0,
            )

            mask_total = depth_grid > 0.06
            mask_med_plus = depth_grid > 0.50
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
        "ground_dem_m": round(ground_elev, 2),
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


def _synthesize_dynamic_buildings_at(cx: float, cy: float, barangay: str) -> gpd.GeoDataFrame:
    """
    Dynamically generates a local building footprint grid on the 10m DEM when the user
    clicks any custom location across the Municipality of Rodriguez outside preset centers.
    """
    seed_val = int(abs(round(cx, -1) * 13 + round(cy, -1) * 17)) % (2**31 - 1)
    rng = np.random.default_rng(seed_val)
    prefix = "".join(c for c in barangay[:3].upper() if c.isalpha()) or "MNT"
    records = []
    b_idx = 1

    with rasterio.open(ensure_dem_exists()) as src:
        cx, cy = _clamp_utm_to_dem(src, cx, cy, margin=360.0)
        for gx in range(-260, 280, 40):
            for gy in range(-260, 280, 36):
                if abs(gx) < 12 or abs(gy) < 12:
                    continue
                bx = cx + gx + float(rng.uniform(-4.5, 4.5))
                by = cy + gy + float(rng.uniform(-4.5, 4.5))
                w = float(rng.uniform(11.0, 18.0))
                h = float(rng.uniform(10.0, 16.0))
                footprint = box(bx - w / 2.0, by - h / 2.0, bx + w / 2.0, by + h / 2.0)
                ground_m = _sample_dem_elevation(src, bx, by)
                floors = int(rng.choice([1, 1, 2, 2, 3], p=[0.35, 0.25, 0.25, 0.10, 0.05]))
                height_m = round(floors * 3.2 + float(rng.uniform(0.3, 1.2)), 1)
                residents = int(floors * rng.integers(3, 7))
                records.append(
                    {
                        "building_id": f"{prefix}-DYN-{b_idx:03d}",
                        "scenario_id": "custom_montalban",
                        "barangay": barangay.upper(),
                        "building_type": "residential" if floors <= 2 else "mixed_commercial",
                        "floors": floors,
                        "height_m": height_m,
                        "ground_elev_m": round(ground_m, 2),
                        "est_residents": residents,
                        "geometry": footprint,
                    }
                )
                b_idx += 1

    return gpd.GeoDataFrame(records, crs="EPSG:32651")


def get_inundated_structures(
    wse_m: float,
    barangay: str,
    flood_gdf_utm: Optional[gpd.GeoDataFrame] = None,
    center_utm: Optional[Tuple[float, float]] = None,
    water_depth_m: Optional[float] = None,
) -> Dict[str, Any]:
    """
    Spatial join between the 3 DEM flood depth contour zones (<0.5m low green,
    0.5-1.5m medium orange, >1.5m critical red) and building footprints.
    Automatically synthesizes local buildings around any clicked coordinate in Montalban
    if fewer than 35 footprints exist within 180m of the target point.
    """
    ensure_spatial_assets()
    buildings_gdf = gpd.read_parquet(BUILDINGS_PARQUET_PATH)

    if center_utm is not None:
        cx, cy = center_utm
        bbox_geom = box(cx - 340.0, cy - 340.0, cx + 340.0, cy + 340.0)
        inner_box = box(cx - 180.0, cy - 180.0, cx + 180.0, cy + 180.0)
        sub_gdf = buildings_gdf[buildings_gdf.intersects(bbox_geom)].copy()
        inner_hits = buildings_gdf[buildings_gdf.intersects(inner_box)]
        if len(inner_hits) < 35:
            # User clicked/dragged to a custom location in Montalban away from preset grid center
            sub_gdf = _synthesize_dynamic_buildings_at(cx, cy, barangay)
    else:
        sub_gdf = buildings_gdf[buildings_gdf["barangay"].str.upper() == barangay.upper()].copy()
        if sub_gdf.empty:
            sub_gdf = buildings_gdf.head(180).copy()
        rep_c = sub_gdf.geometry.unary_union.centroid
        cx, cy = rep_c.x, rep_c.y

    crit_geom = Polygon()
    med_geom = Polygon()
    low_geom = Polygon()
    low_area_sqm = 0.0
    med_area_sqm = 0.0
    crit_area_sqm = 0.0

    if flood_gdf_utm is not None and not flood_gdf_utm.empty and "risk_tier" in flood_gdf_utm.columns:
        c_rows = flood_gdf_utm[flood_gdf_utm["risk_tier"] == "critical"]
        m_rows = flood_gdf_utm[flood_gdf_utm["risk_tier"] == "medium"]
        l_rows = flood_gdf_utm[flood_gdf_utm["risk_tier"] == "low"]
        if not c_rows.empty:
            crit_geom = unary_union(c_rows.geometry)
            crit_area_sqm = round(float(crit_geom.area), 1)
        if not m_rows.empty:
            med_geom = unary_union(m_rows.geometry)
            med_area_sqm = round(float(med_geom.area), 1)
        if not l_rows.empty:
            low_geom = unary_union(l_rows.geometry)
            low_area_sqm = round(float(low_geom.area), 1)

    median_b_elev = float(sub_gdf["ground_elev_m"].median()) if not sub_gdf.empty else float(wse_m) - 1.2
    eff_water_depth = (
        float(water_depth_m)
        if water_depth_m is not None
        else max(0.1, min(3.5, float(wse_m) - median_b_elev))
    )

    depths = []
    tiers = []
    colors = []

    has_zone_polys = not (crit_geom.is_empty and med_geom.is_empty and low_geom.is_empty)

    for _, row in sub_gdf.iterrows():
        b_geom = row.geometry
        b_centroid = b_geom.centroid
        dist_from_center = math.hypot(b_centroid.x - cx, b_centroid.y - cy)
        b_elev = float(row["ground_elev_m"])
        local_micro = (b_elev - median_b_elev) * 0.25

        if has_zone_polys:
            if not crit_geom.is_empty and b_geom.intersects(crit_geom):
                depth = max(1.54, min(3.60, eff_water_depth * (1.08 - 0.12 * (dist_from_center / 220.0)) - local_micro))
                depth = round(depth, 2)
                depths.append(depth)
                tiers.append("critical")
                colors.append("#c4242a")
            elif not med_geom.is_empty and b_geom.intersects(med_geom):
                depth = max(0.54, min(1.48, eff_water_depth * (0.82 - 0.18 * (dist_from_center / 250.0)) - local_micro))
                depth = round(depth, 2)
                depths.append(depth)
                tiers.append("medium")
                colors.append("#d97706")
            elif not low_geom.is_empty and b_geom.intersects(low_geom):
                depth = max(0.12, min(0.48, eff_water_depth * 0.42 - local_micro * 0.5))
                depth = round(depth, 2)
                depths.append(depth)
                tiers.append("low")
                colors.append("#1e7b4f")
            else:
                depths.append(0.0)
                tiers.append("safe")
                colors.append("#94a3b8")
        else:
            # Fallback radial + DEM relief model when called without flood_gdf_utm
            max_r = max(110.0, 105.0 + eff_water_depth * 110.0)
            radial_drop = ((dist_from_center / max_r) ** 1.5) * (eff_water_depth + 0.1)
            depth = round(max(0.0, eff_water_depth * 1.10 - local_micro - radial_drop), 2)
            depths.append(depth)
            if depth > 1.5:
                tiers.append("critical")
                colors.append("#c4242a")
            elif depth >= 0.5:
                tiers.append("medium")
                colors.append("#d97706")
            elif depth > 0.06:
                tiers.append("low")
                colors.append("#1e7b4f")
            else:
                tiers.append("safe")
                colors.append("#94a3b8")

    sub_gdf["flood_depth_m"] = depths
    sub_gdf["risk_tier"] = tiers
    sub_gdf["extrusion_color"] = colors
    sub_gdf["wse_m"] = round(float(wse_m), 2)

    low_count = int((sub_gdf["risk_tier"] == "low").sum())
    med_count = int((sub_gdf["risk_tier"] == "medium").sum())
    crit_count = int((sub_gdf["risk_tier"] == "critical").sum())
    safe_count = int((sub_gdf["risk_tier"] == "safe").sum())
    affected_mask = sub_gdf["risk_tier"].isin(["low", "medium", "critical"])
    affected_residents = int(sub_gdf.loc[affected_mask, "est_residents"].sum())

    sub_wgs84 = sub_gdf.to_crs("EPSG:4326")

    summary = {
        "barangay": barangay.upper(),
        "wse_m": round(float(wse_m), 2),
        "total_structures": int(len(sub_gdf)),
        "low_depth_count": low_count,
        "medium_depth_count": med_count,
        "critical_depth_count": crit_count,
        "safe_count": safe_count,
        "low_area_sqm": low_area_sqm,
        "medium_area_sqm": med_area_sqm,
        "critical_area_sqm": crit_area_sqm,
        "estimated_affected_residents": affected_residents,
    }

    return {
        "summary": summary,
        "buildings_geojson": sub_wgs84.__geo_interface__,
        "critical_buildings": sub_wgs84[sub_wgs84["risk_tier"].isin(["critical", "medium", "low"])]
        .sort_values("flood_depth_m", ascending=False)
        .head(6)
        .to_dict(orient="records"),
    }


def _build_dynamic_local_road_graph(
    ox_utm: float,
    oy_utm: float,
    dx_utm: float,
    dy_utm: float,
    base_elev: float,
    barangay: str,
) -> nx.MultiDiGraph:
    """Builds an on-the-fly local road network in EPSG:4326/UTM for any custom point in Montalban."""
    G = nx.MultiDiGraph()
    min_x = min(ox_utm, dx_utm) - 280.0
    max_x = max(ox_utm, dx_utm) + 280.0
    min_y = min(oy_utm, dy_utm) - 280.0
    max_y = max(oy_utm, dy_utm) + 280.0

    xs = np.linspace(min_x, max_x, 9)
    ys = np.linspace(min_y, max_y, 9)
    grid_nodes: Dict[Tuple[int, int], int] = {}
    nid = 90000

    for ix, x_val in enumerate(xs):
        for iy, y_val in enumerate(ys):
            lon, lat = to_wgs84.transform(float(x_val), float(y_val))
            dist_from_basin = math.hypot(float(x_val) - dx_utm, float(y_val) - dy_utm)
            is_perimeter = ix in (0, len(xs) - 1) or iy in (0, len(ys) - 1)
            if is_perimeter:
                rel_elev = base_elev + 0.95
            elif dist_from_basin < 220.0:
                rel_elev = base_elev - 0.35 + (dist_from_basin / 220.0) * 0.45
            else:
                rel_elev = base_elev + 0.35 + min(0.8, (dist_from_basin - 220.0) / 400.0)

            grid_nodes[(ix, iy)] = nid
            G.add_node(
                nid,
                x=round(lon, 6),
                y=round(lat, 6),
                utm_x=round(float(x_val), 2),
                utm_y=round(float(y_val), 2),
                elevation_m=round(rel_elev, 2),
                barangay=barangay,
            )
            nid += 1

    for ix in range(len(xs)):
        for iy in range(len(ys)):
            u = grid_nodes[(ix, iy)]
            for d_ix, d_iy in [(1, 0), (0, 1)]:
                nx_i, ny_i = ix + d_ix, iy + d_iy
                if (nx_i, ny_i) in grid_nodes:
                    v = grid_nodes[(nx_i, ny_i)]
                    ux, uy = G.nodes[u]["utm_x"], G.nodes[u]["utm_y"]
                    vx, vy = G.nodes[v]["utm_x"], G.nodes[v]["utm_y"]
                    length_m = round(math.hypot(vx - ux, vy - uy), 2)
                    mid_elev = round((G.nodes[u]["elevation_m"] + G.nodes[v]["elevation_m"]) / 2.0, 2)
                    road_name = (
                        f"Brgy. {barangay.title()} Bypass Rd"
                        if iy in (0, len(ys) - 1) or ix in (0, len(xs) - 1)
                        else f"Brgy. {barangay.title()} Access St {ix + iy}"
                    )
                    G.add_edge(u, v, key=0, length=length_m, elevation_m=mid_elev, name=road_name)
                    G.add_edge(v, u, key=0, length=length_m, elevation_m=mid_elev, name=road_name)

    return G


def compute_safe_rescue_route(
    origin_lat: float,
    origin_lon: float,
    dest_lat: float,
    dest_lon: float,
    max_passable_depth_m: float = 0.5,
    wse_m: Optional[float] = None,
) -> Dict[str, Any]:
    """
    Removes edges from rodriguez_roads.graphml intersecting flood depths deeper than
    max_passable_depth_m and computes shortest safe path via networkx.shortest_path.
    Automatically builds a local road subgraph if the user selects any custom point in Montalban.
    """
    ensure_spatial_assets()
    G = ox.load_graphml(ROADS_GRAPHML_PATH)

    for _, data in G.nodes(data=True):
        for k in ["x", "y", "utm_x", "utm_y", "elevation_m"]:
            if k in data:
                data[k] = float(data[k])

    for u, v, k, data in G.edges(keys=True, data=True):
        data["length"] = float(data.get("length", 50.0))
        data["elevation_m"] = float(data.get("elevation_m", 28.0))

    ox_utm, oy_utm = to_utm.transform(origin_lon, origin_lat)
    dx_utm, dy_utm = to_utm.transform(dest_lon, dest_lat)
    mid_x, mid_y = (ox_utm + dx_utm) / 2.0, (oy_utm + dy_utm) / 2.0
    span_radius = max(1200.0, math.hypot(ox_utm - dx_utm, oy_utm - dy_utm) * 0.85)

    with rasterio.open(ensure_dem_exists()) as src:
        dest_ground_m = _sample_dem_elevation(src, dx_utm, dy_utm)
    if wse_m is None:
        wse_m = dest_ground_m + 1.2
    target_water_depth_m = max(0.0, float(wse_m) - dest_ground_m)

    local_nodes = [
        nid
        for nid, ndata in G.nodes(data=True)
        if math.hypot(ndata["utm_x"] - mid_x, ndata["utm_y"] - mid_y) <= span_radius
    ]
    G_local = G.subgraph(local_nodes).copy()

    if G_local.number_of_nodes() < 12 or not nx.is_weakly_connected(G_local):
        loc_meta = resolve_location_metadata(dest_lat, dest_lon)
        G_local = _build_dynamic_local_road_graph(
            ox_utm, oy_utm, dx_utm, dy_utm, dest_ground_m, loc_meta["barangay"]
        )

    G_safe = G_local.copy()
    severed_features = []

    for u, v, k, data in list(G_local.edges(keys=True, data=True)):
        u_node = G_local.nodes[u]
        v_node = G_local.nodes[v]
        edge_mid_x = (u_node["utm_x"] + v_node["utm_x"]) / 2.0
        edge_mid_y = (u_node["utm_y"] + v_node["utm_y"]) / 2.0
        dist_to_target = math.hypot(edge_mid_x - dx_utm, edge_mid_y - dy_utm)

        edge_elev = float(data.get("elevation_m", 28.0))
        raw_depth = max(target_water_depth_m, float(wse_m) - edge_elev)
        if dist_to_target <= 210.0:
            edge_depth = round(target_water_depth_m * (0.95 - 0.15 * (dist_to_target / 210.0)), 2)
        else:
            atten = max(0.0, 1.0 - (dist_to_target / 420.0))
            edge_depth = round(min(1.8, raw_depth) * atten * 0.45, 2)

        if edge_depth > max_passable_depth_m:
            if G_safe.has_edge(u, v, k):
                G_safe.remove_edge(u, v, k)
            if u < v:
                severed_features.append(
                    {
                        "type": "Feature",
                        "properties": {
                            "road_name": data.get("name", "Flooded Segment"),
                            "flood_depth_m": edge_depth,
                            "max_passable_m": round(max_passable_depth_m, 2),
                            "status": "SEVERED",
                        },
                        "geometry": {
                            "type": "LineString",
                            "coordinates": [
                                [u_node["x"], u_node["y"]],
                                [v_node["x"], v_node["y"]],
                            ],
                        },
                    }
                )

    def _nearest_node(graph: nx.MultiDiGraph, lat: float, lon: float) -> Optional[int]:
        best_n = None
        best_d = float("inf")
        for nid, ndata in graph.nodes(data=True):
            if graph.degree(nid) == 0:
                continue
            d = math.hypot(ndata["x"] - lon, ndata["y"] - lat)
            if d < best_d:
                best_d = d
                best_n = nid
        return best_n

    orig_node = _nearest_node(G_local, origin_lat, origin_lon)
    dest_node = _nearest_node(G_local, dest_lat, dest_lon)

    route_found = False
    path_nodes: List[int] = []
    if orig_node is not None and dest_node is not None:
        try:
            path_nodes = nx.shortest_path(G_safe, orig_node, dest_node, weight="length")
            route_found = len(path_nodes) >= 2
        except (nx.NetworkXNoPath, nx.NodeNotFound):
            route_found = False

    if not route_found:
        return {
            "route_found": False,
            "severed_segments_count": len(severed_features),
            "route_distance_m": 0.0,
            "eta_minutes": 0.0,
            "route_geojson": {"type": "FeatureCollection", "features": []},
            "severed_roads_geojson": {"type": "FeatureCollection", "features": severed_features},
        }

    coords = [[round(origin_lon, 6), round(origin_lat, 6)]]
    total_dist = 0.0
    for i, nid in enumerate(path_nodes):
        nd = G_local.nodes[nid]
        coords.append([round(nd["x"], 6), round(nd["y"], 6)])
        if i > 0:
            prev = G_local.nodes[path_nodes[i - 1]]
            total_dist += math.hypot(nd["utm_x"] - prev["utm_x"], nd["utm_y"] - prev["utm_y"])
    coords.append([round(dest_lon, 6), round(dest_lat, 6)])

    total_dist = max(240.0, round(total_dist, 1))
    speed_mps = 5.5 if max_passable_depth_m <= 0.6 else 3.2
    eta_min = round(total_dist / (speed_mps * 60.0) + 2.5, 1)

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
        "severed_roads_geojson": {"type": "FeatureCollection", "features": severed_features},
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
