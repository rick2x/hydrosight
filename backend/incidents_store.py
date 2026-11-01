import datetime
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
import rasterio
from rasterio.windows import Window, from_bounds
from scipy.ndimage import label as nd_label
from shapely.geometry import LineString, MultiPolygon, Point, Polygon, mapping, shape
from shapely.ops import unary_union

from backend.geo_engine import (
    DEFAULT_DEM_PATH,
    OUTPUTS_DIR,
    _EXPORT_LOCK,
    _clamp_utm_to_dem,
    _mask_to_zone_geom,
    _sample_dem_elevation,
    compute_safe_rescue_route,
    ensure_dem_exists,
    ensure_spatial_assets,
    find_nearest_safe_evacuation_center,
    get_inundated_structures,
    project_photo_to_flood_shapefile,
    resolve_location_metadata,
    to_utm,
    to_wgs84,
)
from backend.meta_agents import (
    SCENARIO_PRESETS,
    _make_masks_for_water_y,
    ensure_sample_photos,
    generate_area_advisory,
)
from backend.schemas import (
    AreaAdvisory,
    ConsolidateFloodRequest,
    ConsolidateFloodResponse,
    InundatedStructureSummary,
    OverlapClusterSummary,
    OverlapPairMetric,
    SAMMaskObject,
    SaveIncidentRequest,
    SavedFloodIncident,
    VisualGaugeResult,
)

INCIDENTS_DB_PATH = OUTPUTS_DIR / "incidents_db.json"
_STORE_LOCK = threading.Lock()


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _read_db_unlocked() -> List[Dict[str, Any]]:
    if not INCIDENTS_DB_PATH.exists():
        return []
    try:
        raw = json.loads(INCIDENTS_DB_PATH.read_text(encoding="utf-8"))
        if isinstance(raw, list):
            return raw
    except Exception:
        pass
    return []


def _write_db_unlocked(records: List[Dict[str, Any]]) -> None:
    OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
    INCIDENTS_DB_PATH.write_text(json.dumps(records, indent=2), encoding="utf-8")


def list_incidents() -> List[SavedFloodIncident]:
    with _STORE_LOCK:
        rows = _read_db_unlocked()
    out: List[SavedFloodIncident] = []
    for r in rows:
        try:
            out.append(SavedFloodIncident(**r))
        except Exception:
            continue
    out.sort(key=lambda x: x.updated_at or x.created_at, reverse=True)
    return out


def get_incident(incident_id: str) -> Optional[SavedFloodIncident]:
    for inc in list_incidents():
        if inc.incident_id == incident_id:
            return inc
    return None


def save_or_update_incident(req: SaveIncidentRequest) -> SavedFloodIncident:
    ensure_dem_exists()
    ensure_spatial_assets()
    ensure_sample_photos()

    inc_id = (req.incident_id or "").strip()
    if not inc_id:
        inc_id = f"inc_{uuid.uuid4().hex[:8]}"
    safe_id = "".join(c for c in inc_id if c.isalnum() or c in ("_", "-")) or f"inc_{uuid.uuid4().hex[:8]}"

    loc_meta = resolve_location_metadata(req.cam_lat, req.cam_lon, fallback_barangay=req.barangay or "SAN JOSE")
    resolved_brgy = (req.barangay or loc_meta["barangay"] or "SAN JOSE").upper()

    need_proj = (
        req.flood_geojson is None
        or req.target_lat is None
        or req.target_lon is None
        or req.water_surface_elev_m is None
        or req.inundated_structures is None
    )

    if need_proj:
        proj = project_photo_to_flood_shapefile(
            dem_path=str(DEFAULT_DEM_PATH),
            cam_lon=req.cam_lon,
            cam_lat=req.cam_lat,
            azimuth_deg=req.azimuth_deg,
            fov_deg=req.fov_deg,
            click_u=req.click_u,
            est_distance_m=req.est_distance_m,
            water_depth_m=req.water_depth_m,
            search_radius_m=450.0,
            output_dir=str(OUTPUTS_DIR),
            run_id=safe_id,
            barangay=resolved_brgy,
        )
        target_lat = float(proj["target_lat"])
        target_lon = float(proj["target_lon"])
        ground_dem_m = float(proj["ground_dem_m"])
        wse_m = float(proj["water_surface_elev_m"])
        dem_unc_m = float(proj.get("dem_uncertainty_m") or 0.5)
        flood_area_sqm = float(proj["flood_area_sqm"])
        flood_geojson = proj["flood_geojson"]
        inundated = InundatedStructureSummary(**proj["inundated_structures"])
        download_url = proj["download_shp_url"]
        resolved_brgy = inundated.barangay or resolved_brgy
    else:
        target_lat = float(req.target_lat)
        target_lon = float(req.target_lon)
        ground_dem_m = float(req.ground_dem_m or 0.0)
        wse_m = float(req.water_surface_elev_m)
        dem_unc_m = float(req.dem_uncertainty_m or 0.5)
        flood_area_sqm = float(req.flood_area_sqm or 0.0)
        flood_geojson = req.flood_geojson
        inundated = req.inundated_structures
        download_url = f"/api/v1/download-shp/{safe_id}"

    ref_name = (
        req.visual_gauge.reference_object_detected
        if req.visual_gauge and req.visual_gauge.reference_object_detected
        else "Visual Waterline"
    )
    label = (req.label or "").strip()
    if not label:
        label = f"Brgy. {resolved_brgy.title()} · {req.water_depth_m:.2f} m ({ref_name})"

    now = _now_iso()
    with _STORE_LOCK:
        rows = _read_db_unlocked()
        existing_idx = next((i for i, r in enumerate(rows) if r.get("incident_id") == safe_id), None)
        created_at = rows[existing_idx].get("created_at", now) if existing_idx is not None else now

        record = SavedFloodIncident(
            incident_id=safe_id,
            created_at=created_at,
            updated_at=now,
            label=label,
            barangay=resolved_brgy,
            status=req.status if req.status in ("active", "verified", "excluded") else "active",
            photo_url=req.photo_url,
            is_custom_upload=bool(req.is_custom_upload),
            execution_mode=req.execution_mode or "live_inference",
            masks=req.masks or [],
            visual_gauge=req.visual_gauge,
            cam_lat=round(float(req.cam_lat), 6),
            cam_lon=round(float(req.cam_lon), 6),
            azimuth_deg=round(float(req.azimuth_deg), 1),
            fov_deg=round(float(req.fov_deg), 1),
            click_u=round(float(req.click_u), 3),
            click_v=round(float(req.click_v), 3),
            est_distance_m=round(float(req.est_distance_m), 1),
            water_depth_m=round(float(req.water_depth_m), 2),
            target_lat=round(target_lat, 6),
            target_lon=round(target_lon, 6),
            ground_dem_m=round(ground_dem_m, 2),
            water_surface_elev_m=round(wse_m, 2),
            dem_uncertainty_m=round(dem_unc_m, 2),
            flood_area_sqm=round(flood_area_sqm, 1),
            flood_geojson=flood_geojson,
            inundated_structures=inundated,
            download_shp_url=download_url,
        )
        dumped = record.model_dump()
        if existing_idx is not None:
            rows[existing_idx] = dumped
        else:
            rows.append(dumped)
        _write_db_unlocked(rows)

    return record


def update_incident_status(incident_id: str, status: str, label: Optional[str] = None) -> Optional[SavedFloodIncident]:
    if status not in ("active", "verified", "excluded"):
        raise ValueError("status must be one of: active, verified, excluded")
    with _STORE_LOCK:
        rows = _read_db_unlocked()
        idx = next((i for i, r in enumerate(rows) if r.get("incident_id") == incident_id), None)
        if idx is None:
            return None
        rows[idx]["status"] = status
        if label is not None and label.strip():
            rows[idx]["label"] = label.strip()
        rows[idx]["updated_at"] = _now_iso()
        _write_db_unlocked(rows)
        return SavedFloodIncident(**rows[idx])


def delete_incident(incident_id: str) -> bool:
    with _STORE_LOCK:
        rows = _read_db_unlocked()
        new_rows = [r for r in rows if r.get("incident_id") != incident_id]
        if len(new_rows) == len(rows):
            return False
        _write_db_unlocked(new_rows)
        return True


def clear_all_incidents() -> int:
    with _STORE_LOCK:
        rows = _read_db_unlocked()
        count = len(rows)
        _write_db_unlocked([])
        return count


def seed_overlapping_demo_incidents() -> List[SavedFloodIncident]:
    """
    Seeds 5 realistic field flood reports across Rodriguez (Montalban) designed to
    demonstrate multi-photo overlapping flood prediction consolidation:
      - Cluster 1 (Brgy. San Jose / Kasiglahan Village Basin): 3 overlapping reports
        from different street angles around the same lowland catchment (including 1
        lower-confidence outlier gauge to showcase discrepancy detection & WSE fusion).
      - Cluster 2 (Brgy. Burgos / M.H. Del Pilar Floodplain): 2 overlapping reports
        viewing the same floodplain from West and East approaches.
    """
    ensure_sample_photos()
    seeds = [
        SaveIncidentRequest(
            incident_id="inc_kv_north_gate",
            label="Kasiglahan Ph1K North Gate · 1.35 m (Tricycle)",
            barangay="SAN JOSE",
            status="verified",
            photo_url="/static/photos/kasiglahan_village.jpg",
            is_custom_upload=False,
            execution_mode="calibrated_field_report",
            masks=_make_masks_for_water_y("kvn", 0.56, "tricycle", 1.65, 0.82),
            visual_gauge=VisualGaugeResult(
                reference_object_detected="Submerged Utility Tricycle & Residential Gate",
                reference_standard_height_m=1.65,
                submerged_ratio=0.82,
                estimated_water_depth_m=1.35,
                estimated_distance_from_camera_m=38.0,
                recommended_click_u=0.52,
                recommended_click_v=0.56,
                confidence_score=0.92,
                hydrological_reasoning="SAM 3.1 mask overlap shows 82% submergence on 1.65m tricycle cabin (depth = 1.35m).",
                submerged_ratio_source="sam_mask_geometry",
                sam_mask_pixel_count=14820,
            ),
            cam_lat=14.7498,
            cam_lon=121.1372,
            azimuth_deg=118.0,
            fov_deg=65.0,
            click_u=0.52,
            click_v=0.56,
            est_distance_m=38.0,
            water_depth_m=1.35,
        ),
        SaveIncidentRequest(
            incident_id="inc_kv_creek_east",
            label="Kasiglahan Ph1K East Creek · 1.28 m (Sedan)",
            barangay="SAN JOSE",
            status="verified",
            photo_url="/static/photos/san_jose_riverfront.jpg",
            is_custom_upload=False,
            execution_mode="calibrated_field_report",
            masks=_make_masks_for_water_y("kve", 0.54, "car", 1.48, 0.86),
            visual_gauge=VisualGaugeResult(
                reference_object_detected="Submerged Passenger Sedan & Compound Entrance",
                reference_standard_height_m=1.48,
                submerged_ratio=0.86,
                estimated_water_depth_m=1.27,
                estimated_distance_from_camera_m=42.0,
                recommended_click_u=0.49,
                recommended_click_v=0.54,
                confidence_score=0.89,
                hydrological_reasoning="Cross-street angle looking West into the same Kasiglahan lowland basin; 86% of 1.48m sedan submerged (1.27m).",
                submerged_ratio_source="sam_mask_geometry",
                sam_mask_pixel_count=16240,
            ),
            cam_lat=14.7494,
            cam_lon=121.1379,
            azimuth_deg=292.0,
            fov_deg=65.0,
            click_u=0.49,
            click_v=0.54,
            est_distance_m=42.0,
            water_depth_m=1.27,
        ),
        SaveIncidentRequest(
            incident_id="inc_kv_south_alley",
            label="Kasiglahan South Alleyway · 1.88 m (Distant Gate - Outlier)",
            barangay="SAN JOSE",
            status="active",
            photo_url="/static/photos/san_isidro_southville.jpg",
            is_custom_upload=False,
            execution_mode="calibrated_field_report",
            masks=_make_masks_for_water_y("kvs", 0.48, "gate", 2.10, 0.90),
            visual_gauge=VisualGaugeResult(
                reference_object_detected="Distant Perimeter Gate (Partial Occlusion)",
                reference_standard_height_m=2.10,
                submerged_ratio=0.90,
                estimated_water_depth_m=1.89,
                estimated_distance_from_camera_m=45.0,
                recommended_click_u=0.55,
                recommended_click_v=0.48,
                confidence_score=0.64,
                hydrological_reasoning="Low-angle crowdsourced photo from south alley; distant gate reference gives higher WSE reading with lower visual confidence (0.64).",
                submerged_ratio_source="model_estimate",
            ),
            cam_lat=14.7491,
            cam_lon=121.1370,
            azimuth_deg=35.0,
            fov_deg=68.0,
            click_u=0.55,
            click_v=0.48,
            est_distance_m=45.0,
            water_depth_m=1.89,
        ),
        SaveIncidentRequest(
            incident_id="inc_burgos_delpilar_w",
            label="M.H. Del Pilar West (Brgy. Burgos) · 1.44 m (Sedan)",
            barangay="BURGOS",
            status="verified",
            photo_url="/static/photos/burgos_lowland.jpg",
            is_custom_upload=False,
            execution_mode="calibrated_field_report",
            masks=_make_masks_for_water_y("brgw", 0.54, "car", 1.50, 0.96),
            visual_gauge=VisualGaugeResult(
                reference_object_detected="Submerged Sedan Roof & Compound Gate",
                reference_standard_height_m=1.50,
                submerged_ratio=0.96,
                estimated_water_depth_m=1.44,
                estimated_distance_from_camera_m=40.0,
                recommended_click_u=0.53,
                recommended_click_v=0.54,
                confidence_score=0.91,
                hydrological_reasoning="River backflow along M.H. Del Pilar St reaches 96% of 1.50m passenger vehicle (depth = 1.44m).",
                submerged_ratio_source="sam_mask_geometry",
                sam_mask_pixel_count=15310,
            ),
            cam_lat=14.7218,
            cam_lon=121.1362,
            azimuth_deg=135.0,
            fov_deg=65.0,
            click_u=0.53,
            click_v=0.54,
            est_distance_m=40.0,
            water_depth_m=1.44,
        ),
        SaveIncidentRequest(
            incident_id="inc_burgos_delpilar_e",
            label="M.H. Del Pilar East Corner (Brgy. Burgos) · 1.38 m (Tricycle)",
            barangay="BURGOS",
            status="active",
            photo_url="/static/photos/montalban_town_center.jpg",
            is_custom_upload=False,
            execution_mode="calibrated_field_report",
            masks=_make_masks_for_water_y("brge", 0.56, "tricycle", 1.65, 0.84),
            visual_gauge=VisualGaugeResult(
                reference_object_detected="Submerged Tricycle Sidecar & Storefront",
                reference_standard_height_m=1.65,
                submerged_ratio=0.84,
                estimated_water_depth_m=1.39,
                estimated_distance_from_camera_m=36.0,
                recommended_click_u=0.48,
                recommended_click_v=0.56,
                confidence_score=0.88,
                hydrological_reasoning="Opposite-corner street photo facing Northwest into M.H. Del Pilar floodplain; 84% of 1.65m tricycle submerged (1.39m).",
                submerged_ratio_source="sam_mask_geometry",
                sam_mask_pixel_count=13900,
            ),
            cam_lat=14.7213,
            cam_lon=121.1369,
            azimuth_deg=312.0,
            fov_deg=65.0,
            click_u=0.48,
            click_v=0.56,
            est_distance_m=36.0,
            water_depth_m=1.39,
        ),
    ]
    saved = []
    for s in seeds:
        saved.append(save_or_update_incident(s))
    return list_incidents()


def _incident_utm_geom(inc: SavedFloodIncident) -> Any:
    feats = (inc.flood_geojson or {}).get("features") or []
    if not feats:
        tx, ty = to_utm.transform(inc.target_lon, inc.target_lat)
        return Point(tx, ty).buffer(15.0)
    try:
        gdf = gpd.GeoDataFrame.from_features(feats, crs="EPSG:4326").to_crs("EPSG:32651")
        geom = unary_union(gdf.geometry).buffer(0)
        return geom if not geom.is_empty else Point(*to_utm.transform(inc.target_lon, inc.target_lat)).buffer(15.0)
    except Exception:
        tx, ty = to_utm.transform(inc.target_lon, inc.target_lat)
        return Point(tx, ty).buffer(15.0)


def consolidate_flood_incidents(req: ConsolidateFloodRequest) -> ConsolidateFloodResponse:
    """
    Consolidates multiple saved street-level flood predictions across Rodriguez (Montalban):
      1. Detects spatial polygon overlaps (IoU & intersection area in EPSG:32651) and groups
         intersecting/adjacent reports into hydro-spatial Consolidation Clusters.
      2. Reconciles overlapping Water Surface Elevations (WSE) on the 10 m DEM using the
         chosen mode (confidence_weighted | max_envelope | highest_confidence) and flags
         discrepancy outliers where WSE spread exceeds vertical DEM uncertainty.
      3. Re-projects a unified, non-overlapping 3-tier DEM flood surface so buildings and
         flood areas are strictly de-duplicated (never double-counted).
      4. Computes safe rescue corridors and a unified area advisory.
    """
    ensure_dem_exists()
    ensure_spatial_assets()

    all_incidents = list_incidents()
    if req.incident_ids is not None:
        wanted = set(req.incident_ids)
        active_list = [inc for inc in all_incidents if inc.incident_id in wanted]
    else:
        active_list = [inc for inc in all_incidents if inc.status in ("active", "verified")]

    mode = req.reconciliation_mode if req.reconciliation_mode in ("confidence_weighted", "max_envelope", "highest_confidence") else "confidence_weighted"

    if not active_list:
        empty_fc = {"type": "FeatureCollection", "features": []}
        empty_summary = InundatedStructureSummary(
            barangay="SAN JOSE",
            wse_m=0.0,
            total_structures=0,
            low_depth_count=0,
            medium_depth_count=0,
            critical_depth_count=0,
            safe_count=0,
            affected_structures=0,
        )
        advisory, _ = generate_area_advisory(
            barangay="RODRIGUEZ (ALL BARANGAYS)",
            summary=empty_summary,
            evacuation_center="Rodriguez Municipal Gymnasium (Montalban Command Center)",
            vehicle_type="6x6 High-Water Rescue Truck",
            eta_minutes=0.0,
            route_distance_m=0.0,
            severed_segments_count=0,
            primary_route_severed=False,
        )
        return ConsolidateFloodResponse(
            run_id="consolidated_empty",
            reconciliation_mode=mode,
            total_saved_incidents=len(all_incidents),
            active_consolidated_incidents=0,
            overlapping_clusters_count=0,
            overlap_pairs=[],
            clusters=[],
            raw_sum_flood_area_sqm=0.0,
            consolidated_flood_area_sqm=0.0,
            overlap_area_eliminated_sqm=0.0,
            raw_sum_affected_structures=0,
            consolidated_affected_structures=0,
            duplicate_structures_eliminated=0,
            inundated_structures=empty_summary,
            consolidated_flood_geojson=empty_fc,
            individual_outlines_geojson=empty_fc,
            intersection_zones_geojson=empty_fc,
            camera_stations_geojson=empty_fc,
            buildings_geojson=empty_fc,
            routes_geojson=empty_fc,
            severed_roads_geojson=empty_fc,
            area_advisory=advisory,
            download_shp_url="/api/v1/download-shp/consolidated_latest",
            synthesis_headline="No active flood reports selected for consolidation",
            synthesis_reasoning="Save a photo projection from the Operator Workbench or seed the demo reports to run multi-incident overlap consolidation.",
        )

    # 1. Build UTM geometries and individual outlines / camera stations
    poly_utm: Dict[str, Any] = {}
    target_utm: Dict[str, Tuple[float, float]] = {}
    cam_utm: Dict[str, Tuple[float, float]] = {}
    outline_features: List[Dict[str, Any]] = []
    station_features: List[Dict[str, Any]] = []

    PALETTE = ["#0284c7", "#7c3aed", "#0d9488", "#ea580c", "#db2777", "#4f46e5", "#059669"]

    for idx, inc in enumerate(active_list):
        g_utm = _incident_utm_geom(inc)
        poly_utm[inc.incident_id] = g_utm
        tx, ty = to_utm.transform(inc.target_lon, inc.target_lat)
        cx, cy = to_utm.transform(inc.cam_lon, inc.cam_lat)
        target_utm[inc.incident_id] = (tx, ty)
        cam_utm[inc.incident_id] = (cx, cy)
        color = PALETTE[idx % len(PALETTE)]
        conf = float(inc.visual_gauge.confidence_score) if inc.visual_gauge else 0.85

        try:
            g_wgs84 = gpd.GeoSeries([g_utm], crs="EPSG:32651").to_crs("EPSG:4326").iloc[0]
            outline_features.append({
                "type": "Feature",
                "properties": {
                    "incident_id": inc.incident_id,
                    "label": inc.label,
                    "barangay": inc.barangay,
                    "wse_m": inc.water_surface_elev_m,
                    "water_depth_m": inc.water_depth_m,
                    "confidence_score": round(conf, 2),
                    "outline_color": color,
                    "status": inc.status,
                },
                "geometry": mapping(g_wgs84),
            })
        except Exception:
            pass

        station_features.append({
            "type": "Feature",
            "properties": {
                "kind": "camera",
                "incident_id": inc.incident_id,
                "label": inc.label,
                "barangay": inc.barangay,
                "water_depth_m": inc.water_depth_m,
                "wse_m": inc.water_surface_elev_m,
                "confidence_score": round(conf, 2),
                "azimuth_deg": inc.azimuth_deg,
                "color": color,
                "photo_url": inc.photo_url,
            },
            "geometry": {"type": "Point", "coordinates": [inc.cam_lon, inc.cam_lat]},
        })
        station_features.append({
            "type": "Feature",
            "properties": {
                "kind": "ray",
                "incident_id": inc.incident_id,
                "label": inc.label,
                "color": color,
            },
            "geometry": {
                "type": "LineString",
                "coordinates": [[inc.cam_lon, inc.cam_lat], [inc.target_lon, inc.target_lat]],
            },
        })

    # 2. Pairwise overlap detection & graph construction
    G_overlap = nx.Graph()
    for inc in active_list:
        G_overlap.add_node(inc.incident_id)

    overlap_pairs: List[OverlapPairMetric] = []
    intersection_features: List[Dict[str, Any]] = []

    for i in range(len(active_list)):
        for j in range(i + 1, len(active_list)):
            inc_a = active_list[i]
            inc_b = active_list[j]
            ga = poly_utm[inc_a.incident_id]
            gb = poly_utm[inc_b.incident_id]
            tx_a, ty_a = target_utm[inc_a.incident_id]
            tx_b, ty_b = target_utm[inc_b.incident_id]
            sep_m = round(math.hypot(tx_a - tx_b, ty_a - ty_b), 1)

            inter_geom = Polygon()
            overlap_sqm = 0.0
            iou = 0.0
            try:
                if ga.intersects(gb):
                    inter_geom = ga.intersection(gb).buffer(0)
                    overlap_sqm = round(float(inter_geom.area), 1)
                    union_sqm = float(ga.union(gb).area)
                    iou = round(overlap_sqm / union_sqm, 3) if union_sqm > 0 else 0.0
            except Exception:
                overlap_sqm = 0.0

            # Consider two predictions part of the same overlapping basin if their
            # flood polygons overlap (>=15 sqm) or their targets are within 200m in the same barangay
            same_basin_near = (inc_a.barangay == inc_b.barangay and sep_m <= 180.0 and ga.distance(gb) <= 30.0)
            if overlap_sqm >= 15.0 or same_basin_near:
                G_overlap.add_edge(inc_a.incident_id, inc_b.incident_id)
                wse_delta = round(abs(inc_a.water_surface_elev_m - inc_b.water_surface_elev_m), 2)
                combined_unc = math.hypot(inc_a.dem_uncertainty_m or 0.5, inc_b.dem_uncertainty_m or 0.5)
                discrepancy = wse_delta > max(0.45, round(combined_unc * 0.85, 2))

                if discrepancy:
                    note = (
                        f"WSE discrepancy of {wse_delta:.2f} m exceeds DEM vertical band ({combined_unc:.2f} m). "
                        f"Reconciled via {mode.replace('_', ' ')}."
                    )
                else:
                    note = (
                        f"Hydrologically consistent overlap (ΔWSE {wse_delta:.2f} m within ±{combined_unc:.2f} m DEM band); "
                        f"merged {overlap_sqm:,.0f} m² shared flood zone."
                    )

                overlap_pairs.append(
                    OverlapPairMetric(
                        incident_a_id=inc_a.incident_id,
                        incident_b_id=inc_b.incident_id,
                        incident_a_label=inc_a.label,
                        incident_b_label=inc_b.label,
                        barangay=inc_a.barangay,
                        overlap_area_sqm=overlap_sqm,
                        iou_ratio=iou,
                        target_separation_m=sep_m,
                        wse_a_m=inc_a.water_surface_elev_m,
                        wse_b_m=inc_b.water_surface_elev_m,
                        wse_delta_m=wse_delta,
                        discrepancy_flagged=discrepancy,
                        resolution_note=note,
                    )
                )

                if not inter_geom.is_empty and overlap_sqm >= 15.0:
                    try:
                        inter_wgs84 = gpd.GeoSeries([inter_geom], crs="EPSG:32651").to_crs("EPSG:4326").iloc[0]
                        intersection_features.append({
                            "type": "Feature",
                            "properties": {
                                "pair": f"{inc_a.incident_id} + {inc_b.incident_id}",
                                "incident_a_label": inc_a.label,
                                "incident_b_label": inc_b.label,
                                "overlap_area_sqm": overlap_sqm,
                                "iou_ratio": iou,
                                "wse_delta_m": wse_delta,
                                "discrepancy_flagged": discrepancy,
                            },
                            "geometry": mapping(inter_wgs84),
                        })
                    except Exception:
                        pass

    # 3. Cluster-by-Cluster DEM WSE Reconciliation & De-Duplicated Re-Projection
    inc_by_id = {inc.incident_id: inc for inc in active_list}
    components = list(nx.connected_components(G_overlap))
    components.sort(key=lambda comp: (-len(comp), sorted(comp)[0]))

    cluster_summaries: List[OverlapClusterSummary] = []
    global_tier_polys: Dict[str, List[Any]] = {"low": [], "medium": [], "critical": []}
    route_features: List[Dict[str, Any]] = []
    severed_features: List[Dict[str, Any]] = []

    with rasterio.open(ensure_dem_exists()) as src:
        full_win = Window(0, 0, src.width, src.height)

        for c_idx, comp_ids in enumerate(components):
            c_incs = [inc_by_id[iid] for iid in sorted(comp_ids)]
            cluster_id = f"cluster_{c_idx + 1}"
            is_overlapping = len(c_incs) >= 2
            brgy = c_incs[0].barangay

            wses = [inc.water_surface_elev_m for inc in c_incs]
            wse_min = round(min(wses), 2)
            wse_max = round(max(wses), 2)
            wse_spread = round(wse_max - wse_min, 2)

            # Compute weights per incident from visual gauge confidence and DEM uncertainty
            weights = []
            for inc in c_incs:
                conf = float(inc.visual_gauge.confidence_score) if inc.visual_gauge else 0.85
                unc = max(0.25, float(inc.dem_uncertainty_m or 0.5))
                weights.append(max(0.1, conf) / (unc * unc))
            w_sum = sum(weights) or 1.0

            if mode == "max_envelope":
                reconciled_wse = wse_max
            elif mode == "highest_confidence":
                best_i = int(np.argmax(weights))
                reconciled_wse = round(c_incs[best_i].water_surface_elev_m, 2)
            else:
                reconciled_wse = round(sum(w * inc.water_surface_elev_m for w, inc in zip(weights, c_incs)) / w_sum, 2)

            # Identify outlier report if spread is large
            discrepancy_flagged = bool(is_overlapping and wse_spread > 0.45)
            outlier_id: Optional[str] = None
            if discrepancy_flagged:
                deviations = [
                    (abs(inc.water_surface_elev_m - reconciled_wse) / max(0.1, (inc.visual_gauge.confidence_score if inc.visual_gauge else 0.8)), inc.incident_id)
                    for inc in c_incs
                ]
                deviations.sort(reverse=True)
                outlier_id = deviations[0][1]

            # Recompute connected DEM depth grid across the cluster's target basin
            txs = [target_utm[inc.incident_id][0] for inc in c_incs]
            tys = [target_utm[inc.incident_id][1] for inc in c_incs]
            search_r = 450.0
            raw_win = from_bounds(
                min(txs) - search_r,
                min(tys) - search_r,
                max(txs) + search_r,
                max(tys) + search_r,
                src.transform,
            )
            win = raw_win.intersection(full_win).round_offsets().round_lengths()

            c_tier_geoms = {"low": Polygon(), "medium": Polygon(), "critical": Polygon()}
            mean_depth = round(float(np.mean([inc.water_depth_m for inc in c_incs])), 2)
            max_depth = round(float(np.max([inc.water_depth_m for inc in c_incs])), 2)

            if win.width >= 3 and win.height >= 3:
                dem_sub_raw = src.read(1, window=win)
                dem_sub = dem_sub_raw.astype(np.float64)
                win_transform = src.window_transform(win)
                valid_dem = (dem_sub_raw != src.nodata) & (dem_sub_raw > -100)
                inv = ~win_transform

                # Build WSE surface (2D field for confidence_weighted multi-point, scalar for max/single)
                if is_overlapping and mode == "confidence_weighted":
                    rows_idx, cols_idx = np.indices(dem_sub.shape, dtype=np.float64)
                    # Convert pixel indices to UTM coordinates
                    xs_grid = win_transform.c + (cols_idx + 0.5) * win_transform.a
                    ys_grid = win_transform.f + (rows_idx + 0.5) * win_transform.e
                    num_grid = np.zeros_like(dem_sub, dtype=np.float64)
                    den_grid = np.zeros_like(dem_sub, dtype=np.float64)
                    d0_sq = 65.0 * 65.0
                    for w_i, inc in zip(weights, c_incs):
                        tx_i, ty_i = target_utm[inc.incident_id]
                        dist_sq = (xs_grid - tx_i) ** 2 + (ys_grid - ty_i) ** 2
                        idw_w = w_i / (dist_sq + d0_sq)
                        num_grid += idw_w * float(inc.water_surface_elev_m)
                        den_grid += idw_w
                    wse_surface = num_grid / np.maximum(1e-9, den_grid)
                else:
                    wse_surface = np.full_like(dem_sub, float(reconciled_wse), dtype=np.float64)

                raw_depth_grid = np.where(valid_dem, np.maximum(0.0, wse_surface - dem_sub), 0.0)
                flooded = valid_dem & (dem_sub <= wse_surface) & (raw_depth_grid >= 0.05)
                lbl_arr, _ = nd_label(flooded)

                connected_mask = np.zeros_like(flooded, dtype=bool)
                for inc in c_incs:
                    tx_i, ty_i = target_utm[inc.incident_id]
                    tc_f, tr_f = inv * (tx_i, ty_i)
                    tc = int(np.clip(np.round(tc_f), 0, dem_sub.shape[1] - 1))
                    tr = int(np.clip(np.round(tr_f), 0, dem_sub.shape[0] - 1))
                    lbl_val = int(lbl_arr[tr, tc])
                    if lbl_val == 0:
                        sub = lbl_arr[max(0, tr - 3): tr + 4, max(0, tc - 3): tc + 4]
                        nz = sub[sub > 0]
                        if len(nz) > 0:
                            lbl_val = int(np.bincount(nz).argmax())
                    if lbl_val > 0:
                        connected_mask |= (lbl_arr == lbl_val)

                depth_grid = np.where(connected_mask, raw_depth_grid, 0.0)
                active_depths = depth_grid[connected_mask]
                if active_depths.size > 0:
                    mean_depth = round(float(np.mean(active_depths)), 2)
                    max_depth = round(float(np.max(active_depths)), 2)

                tier_masks = {
                    "low": connected_mask & (depth_grid >= 0.05) & (depth_grid < 0.50),
                    "medium": connected_mask & (depth_grid >= 0.50) & (depth_grid <= 1.50),
                    "critical": connected_mask & (depth_grid > 1.50),
                }
                for t_name, t_mask in tier_masks.items():
                    geom = _mask_to_zone_geom(t_mask, win_transform)
                    if geom is not None and not geom.is_empty:
                        c_tier_geoms[t_name] = geom
                        global_tier_polys[t_name].append(geom)

            raw_sum_area = round(sum(float(poly_utm[inc.incident_id].area) for inc in c_incs), 1)
            cluster_union = unary_union([g for g in c_tier_geoms.values() if not g.is_empty])
            cons_area = round(float(cluster_union.area), 1) if not cluster_union.is_empty else raw_sum_area
            overlap_elim = round(max(0.0, raw_sum_area - cons_area), 1)

            # Compute safe rescue route for this consolidated cluster
            mean_lat = float(np.mean([inc.target_lat for inc in c_incs]))
            mean_lon = float(np.mean([inc.target_lon for inc in c_incs]))
            cluster_gdf_utm = (
                gpd.GeoDataFrame([{"geometry": cluster_union}], crs="EPSG:32651")
                if not cluster_union.is_empty
                else None
            )
            safe_ec = find_nearest_safe_evacuation_center(
                mean_lat, mean_lon, wse_m=reconciled_wse, flood_gdf_utm=cluster_gdf_utm
            )
            ec_name = safe_ec["name"]
            ec_lat = float(safe_ec["lat"])
            ec_lon = float(safe_ec["lon"])

            primary_rt = compute_safe_rescue_route(
                origin_lat=ec_lat,
                origin_lon=ec_lon,
                dest_lat=mean_lat,
                dest_lon=mean_lon,
                max_passable_depth_m=0.5,
                wse_m=reconciled_wse,
            )
            vehicle = "6x6 High-Water Rescue Truck"
            final_rt = primary_rt
            if not primary_rt["route_found"]:
                vehicle = "amphibious_rubber_boat"
                final_rt = compute_safe_rescue_route(
                    origin_lat=ec_lat,
                    origin_lon=ec_lon,
                    dest_lat=mean_lat,
                    dest_lon=mean_lon,
                    max_passable_depth_m=10.0,
                    wse_m=reconciled_wse,
                )

            for rf in (final_rt.get("route_geojson") or {}).get("features", []):
                rf_copy = dict(rf)
                rf_copy["properties"] = {
                    **(rf.get("properties") or {}),
                    "cluster_id": cluster_id,
                    "barangay": brgy,
                    "evacuation_center_name": ec_name,
                    "vehicle_selected": vehicle,
                }
                route_features.append(rf_copy)

            for sf in (primary_rt.get("severed_roads_geojson") or {}).get("features", []):
                severed_features.append(sf)

            if is_overlapping:
                if mode == "confidence_weighted":
                    explanation = (
                        f"Fused {len(c_incs)} overlapping reports in Brgy. {brgy.title()} using SAM 3.1 confidence & DEM inverse-variance weighting "
                        f"(WSE range {wse_min:.2f}–{wse_max:.2f} m → reconciled {reconciled_wse:.2f} m MSL), eliminating {overlap_elim:,.0f} m² of duplicate flood polygon overlap."
                    )
                elif mode == "max_envelope":
                    explanation = (
                        f"Applied conservative life-safety envelope across {len(c_incs)} overlapping reports in Brgy. {brgy.title()} "
                        f"(adopted max WSE {reconciled_wse:.2f} m MSL), merging {overlap_elim:,.0f} m² of overlapping area."
                    )
                else:
                    explanation = (
                        f"Selected highest-confidence gauge among {len(c_incs)} overlapping reports in Brgy. {brgy.title()} "
                        f"(authoritative WSE {reconciled_wse:.2f} m MSL), removing {overlap_elim:,.0f} m² of redundant overlap."
                    )
                if outlier_id:
                    explanation += f" Flagged {outlier_id} as a high-variance WSE outlier (ΔWSE {wse_spread:.2f} m)."
            else:
                explanation = (
                    f"Standalone flood basin in Brgy. {brgy.title()} (no overlapping reports; WSE {reconciled_wse:.2f} m MSL retained)."
                )

            cluster_summaries.append(
                OverlapClusterSummary(
                    cluster_id=cluster_id,
                    barangay=brgy,
                    incident_ids=[inc.incident_id for inc in c_incs],
                    incident_labels=[inc.label for inc in c_incs],
                    incident_count=len(c_incs),
                    is_overlapping=is_overlapping,
                    reconciliation_mode=mode,
                    wse_min_m=wse_min,
                    wse_max_m=wse_max,
                    wse_spread_m=wse_spread,
                    reconciled_wse_m=reconciled_wse,
                    reconciled_depth_mean_m=mean_depth,
                    reconciled_depth_max_m=max_depth,
                    raw_sum_area_sqm=raw_sum_area,
                    consolidated_area_sqm=cons_area,
                    overlap_eliminated_sqm=overlap_elim,
                    discrepancy_flagged=discrepancy_flagged,
                    outlier_incident_id=outlier_id,
                    resolution_explanation=explanation,
                    evacuation_center_name=ec_name,
                    evacuation_center_lat=ec_lat,
                    evacuation_center_lon=ec_lon,
                    vehicle_selected=vehicle,
                    route_distance_m=round(float(final_rt.get("route_distance_m") or 0.0), 1),
                    eta_minutes=round(float(final_rt.get("eta_minutes") or 0.0), 1),
                )
            )

    # 4. Build globally de-duplicated tier geometries (critical > medium > low)
    crit_union = unary_union(global_tier_polys["critical"]).buffer(0) if global_tier_polys["critical"] else Polygon()
    med_union = unary_union(global_tier_polys["medium"]).buffer(0) if global_tier_polys["medium"] else Polygon()
    low_union = unary_union(global_tier_polys["low"]).buffer(0) if global_tier_polys["low"] else Polygon()

    if not crit_union.is_empty and not med_union.is_empty:
        med_union = med_union.difference(crit_union).buffer(0)
    if not low_union.is_empty:
        higher = unary_union([g for g in (crit_union, med_union) if not g.is_empty])
        if not higher.is_empty:
            low_union = low_union.difference(higher).buffer(0)

    tier_style = {
        "low": ("< 0.5 m (Low)", "#1e7b4f", "#155e3b", 0.30),
        "medium": ("0.5-1.5 m (Medium)", "#d97706", "#b45309", 0.95),
        "critical": ("> 1.5 m (Critical)", "#c4242a", "#991b1b", 1.85),
    }
    mean_global_wse = round(float(np.mean([c.reconciled_wse_m for c in cluster_summaries])), 2)
    primary_brgy = cluster_summaries[0].barangay if len( {c.barangay for c in cluster_summaries} ) == 1 else "MULTI-BARANGAY"

    tier_records = []
    for r_tier, z_geom in (("low", low_union), ("medium", med_union), ("critical", crit_union)):
        if z_geom is not None and not z_geom.is_empty and z_geom.area >= 15.0:
            z_label, f_col, o_col, rep_depth = tier_style[r_tier]
            tier_records.append({
                "geometry": z_geom,
                "risk_tier": r_tier,
                "zone_label": z_label,
                "fill_color": f_col,
                "line_color": o_col,
                "wse_m": mean_global_wse,
                "depth_m": rep_depth,
                "area_sqm": round(float(z_geom.area), 1),
                "barangay": primary_brgy,
            })

    if not tier_records:
        # Fallback if DEM window produced empty union: union the individual incident polygons
        fallback_union = unary_union(list(poly_utm.values())).buffer(0)
        tier_records.append({
            "geometry": fallback_union,
            "risk_tier": "medium",
            "zone_label": "0.5-1.5 m (Consolidated)",
            "fill_color": "#d97706",
            "line_color": "#b45309",
            "wse_m": mean_global_wse,
            "depth_m": 1.1,
            "area_sqm": round(float(fallback_union.area), 1),
            "barangay": primary_brgy,
        })

    gdf_consolidated = gpd.GeoDataFrame(tier_records, crs="EPSG:32651")
    consolidated_area_sqm = round(float(gdf_consolidated.geometry.area.sum()), 1)
    raw_sum_area_sqm = round(sum(float(inc.flood_area_sqm) for inc in active_list), 1)
    overlap_eliminated_sqm = round(max(0.0, raw_sum_area_sqm - consolidated_area_sqm), 1)

    # Export consolidated shapefile
    run_id = "consolidated_latest"
    zip_path = OUTPUTS_DIR / f"flood_extent_{run_id}.zip"
    geojson_path = OUTPUTS_DIR / f"flood_extent_{run_id}.geojson"
    gdf_wgs84 = gdf_consolidated.to_crs("EPSG:4326")
    consolidated_geojson = gdf_wgs84.__geo_interface__

    tmp_dir = OUTPUTS_DIR / f"_tmp_{run_id}_{uuid.uuid4().hex[:8]}"
    try:
        tmp_dir.mkdir(parents=True, exist_ok=True)
        tmp_shp_base = tmp_dir / f"flood_extent_{run_id}"
        gdf_consolidated.to_file(tmp_shp_base.with_suffix(".shp"))
        tmp_zip = tmp_dir / f"flood_extent_{run_id}.zip"
        with zipfile.ZipFile(tmp_zip, "w", zipfile.ZIP_DEFLATED) as zf:
            for ext in [".shp", ".shx", ".dbf", ".prj", ".cpg"]:
                f = tmp_shp_base.with_suffix(ext)
                if f.exists():
                    zf.write(f, arcname=f.name)
        with _EXPORT_LOCK:
            try:
                shutil.copyfile(tmp_zip, zip_path)
                geojson_path.write_text(json.dumps(consolidated_geojson), encoding="utf-8")
            except PermissionError:
                pass
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    # 5. Evaluate de-duplicated OSM structures across the entire consolidated flood surface
    all_tx = [target_utm[inc.incident_id][0] for inc in active_list]
    all_ty = [target_utm[inc.incident_id][1] for inc in active_list]
    center_utm = (float(np.mean(all_tx)), float(np.mean(all_ty)))

    inundation_res = get_inundated_structures(
        wse_m=mean_global_wse,
        barangay=primary_brgy if primary_brgy != "MULTI-BARANGAY" else active_list[0].barangay,
        flood_gdf_utm=gdf_consolidated,
        center_utm=center_utm,
        radius_m=520.0,
    )
    inundated_summary = InundatedStructureSummary(**inundation_res["summary"])
    inundated_summary.barangay = primary_brgy

    raw_sum_structures = sum(int(inc.inundated_structures.affected_structures) for inc in active_list)
    consolidated_structures = int(inundated_summary.affected_structures)
    duplicate_structures_elim = max(0, raw_sum_structures - consolidated_structures)

    primary_cluster = cluster_summaries[0]
    advisory, _ = generate_area_advisory(
        barangay=primary_brgy,
        summary=inundated_summary,
        evacuation_center=primary_cluster.evacuation_center_name or "Rodriguez Municipal Gymnasium",
        vehicle_type=primary_cluster.vehicle_selected,
        eta_minutes=primary_cluster.eta_minutes,
        route_distance_m=primary_cluster.route_distance_m,
        severed_segments_count=len(severed_features),
        primary_route_severed=(primary_cluster.vehicle_selected == "amphibious_rubber_boat"),
    )

    overlapping_clusters_count = sum(1 for c in cluster_summaries if c.is_overlapping)
    if overlapping_clusters_count > 0:
        synthesis_headline = (
            f"Consolidated {len(active_list)} street flood reports into {len(cluster_summaries)} basin cluster(s) "
            f"({overlapping_clusters_count} overlapping) — {overlap_eliminated_sqm / 10000.0:.2f} ha duplicate flood area & "
            f"{duplicate_structures_elim} duplicate building counts de-conflicted"
        )
        synthesis_reasoning = (
            f"Spatial intersection analysis in EPSG:32651 detected {len(overlap_pairs)} overlapping report pair(s) across "
            f"{overlapping_clusters_count} catchment cluster(s). Using '{mode.replace('_', ' ')}' reconciliation on the 10 m DEM, "
            f"conflicting Water Surface Elevations were fused into a single continuous water surface, reducing raw summed flood extent "
            f"from {raw_sum_area_sqm / 10000.0:.2f} ha to {consolidated_area_sqm / 10000.0:.2f} ha and de-duplicating "
            f"affected OSM building footprints from {raw_sum_structures} raw hits to {consolidated_structures} unique structures."
        )
    else:
        synthesis_headline = (
            f"Consolidated {len(active_list)} non-overlapping flood report(s) ({consolidated_area_sqm / 10000.0:.2f} ha total extent)"
        )
        synthesis_reasoning = (
            f"All {len(active_list)} active flood report(s) cover distinct lowland basins with zero polygon intersection. "
            f"Combined extent covers {consolidated_area_sqm / 10000.0:.2f} ha and {consolidated_structures} unique OSM structures."
        )

    return ConsolidateFloodResponse(
        run_id=run_id,
        reconciliation_mode=mode,
        total_saved_incidents=len(all_incidents),
        active_consolidated_incidents=len(active_list),
        overlapping_clusters_count=overlapping_clusters_count,
        overlap_pairs=overlap_pairs,
        clusters=cluster_summaries,
        raw_sum_flood_area_sqm=raw_sum_area_sqm,
        consolidated_flood_area_sqm=consolidated_area_sqm,
        overlap_area_eliminated_sqm=overlap_eliminated_sqm,
        raw_sum_affected_structures=raw_sum_structures,
        consolidated_affected_structures=consolidated_structures,
        duplicate_structures_eliminated=duplicate_structures_elim,
        inundated_structures=inundated_summary,
        consolidated_flood_geojson=consolidated_geojson,
        individual_outlines_geojson={"type": "FeatureCollection", "features": outline_features},
        intersection_zones_geojson={"type": "FeatureCollection", "features": intersection_features},
        camera_stations_geojson={"type": "FeatureCollection", "features": station_features},
        buildings_geojson=inundation_res["buildings_geojson"],
        routes_geojson={"type": "FeatureCollection", "features": route_features},
        severed_roads_geojson={"type": "FeatureCollection", "features": severed_features[:120]},
        area_advisory=advisory,
        download_shp_url=f"/api/v1/download-shp/{run_id}",
        synthesis_headline=synthesis_headline,
        synthesis_reasoning=synthesis_reasoning,
    )
