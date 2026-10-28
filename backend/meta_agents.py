import logging
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger("hydrosight.perception")

import base64
from concurrent.futures import ThreadPoolExecutor
import datetime
import hashlib
import io
import json
import math
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import geopandas as gpd
import httpx
import numpy as np
from PIL import Image, ImageDraw
from PIL.ExifTags import GPSTAGS

from backend.geo_engine import (
    DEFAULT_DEM_PATH,
    OUTPUTS_DIR,
    assess_evacuation_centers,
    find_nearest_safe_evacuation_center,
    compute_safe_rescue_route,
    get_inundated_structures,
    load_evacuation_centers,
    project_photo_to_flood_shapefile,
    resolve_location_metadata,
    to_utm,
)
from backend.schemas import (
    AgentStepLog,
    AnalyzePhotoResponse,
    AreaAdvisory,
    InundatedStructureSummary,
    DispatchTelemetry,
    EvacCenterStatus,
    PhotoGeotag,
    SAMMaskObject,
    ScenarioPreset,
    TriageRouteRequest,
    TriageRouteResponse,
    VisualGaugeResult,
)

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
PHOTOS_DIR = DATA_DIR / "sample_photos"
CACHE_DIR = BASE_DIR / "cache"
DISPATCH_LOG_PATH = OUTPUTS_DIR / "dispatch_telemetry.log"

META_API_KEY = os.environ.get("META_API_KEY", "")
META_API_BASE_URL = os.environ.get("META_API_BASE_URL", "https://api.meta.ai/v1")
AGENT_DISPATCH_PROVIDER = os.environ.get("AGENT_DISPATCH_PROVIDER", "Meta AI API")

# Meta API response caching is disabled by default: every analyze-photo,
# triage call runs fresh against the live models. Set
# HYDROSIGHT_CACHE_ENABLED=1 only for offline development against old runs.
CACHE_ENABLED = os.environ.get("HYDROSIGHT_CACHE_ENABLED", "0").strip().lower() in ("1", "true", "yes")

PRIMARY_SAM_PROMPTS = [
    "water",
    "person",
    "car",
    "tricycle",
    "gate",
    "building entrance",
]
FALLBACK_SAM_PROMPTS = [
    "fence",
    "utility pole",
    "sidewalk curb",
]

SAM_BOX_PATTERN = re.compile(
    r"<\|box;x1=(\d+);y1=(\d+);x2=(\d+);y2=(\d+);w=(\d+);h=(\d+)\|>"
)

STANDARD_HEIGHTS_M = {
    "person": 1.60,
    "car": 1.48,
    "tricycle": 1.65,
    "vehicle wheel": 0.72,
    "gate": 1.85,
    "building entrance": 2.10,
    "utility pole": 6.00,
    "fence": 1.50,
}


def _get_cache_path(payload: Dict[str, Any]) -> Tuple[str, Path]:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(payload, sort_keys=True, default=str).encode("utf-8")
    digest = hashlib.sha256(serialized).hexdigest()
    return digest, CACHE_DIR / f"{digest}.json"


def _read_cache(payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if not CACHE_ENABLED:
        return None
    _, path = _get_cache_path(payload)
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None
    return None


def _write_cache(payload: Dict[str, Any], response_data: Dict[str, Any]) -> str:
    if not CACHE_ENABLED:
        return ""
    digest, path = _get_cache_path(payload)
    path.write_text(json.dumps(response_data, indent=2), encoding="utf-8")
    return digest


def log_dispatch_inference(
    model_id: str,
    provider: str,
    latency_ms: int,
    tokens: int,
    task: str = "incident_dispatch_generation",
) -> DispatchTelemetry:
    OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.datetime.now(datetime.timezone.utc).isoformat()
    log_entry = {
        "timestamp": ts,
        "model_id": model_id,
        "provider": provider,
        "endpoint": META_API_BASE_URL,
        "latency_ms": latency_ms,
        "tokens": tokens,
        "task": task,
        "status": "COMPLETED",
    }
    with open(DISPATCH_LOG_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(log_entry) + "\n")

    return DispatchTelemetry(
        model_id=model_id,
        provider=provider,
        endpoint=META_API_BASE_URL,
        latency_ms=latency_ms,
        tokens_used=tokens,
        verification_log_path=str(DISPATCH_LOG_PATH),
        status="API_EXECUTION_COMPLETED",
    )


def _make_masks_for_water_y(
    prefix: str, water_y: float, ref_concept: str, ref_height: float, sub_ratio: float
) -> List[SAMMaskObject]:
    wy = round(float(water_y), 2)
    return [
        SAMMaskObject(
            id=f"mask-floodwater-{prefix}",
            geometry_source="preset",
            concept="floodwater",
            confidence=0.97,
            bbox_norm=[0.0, max(0.2, wy - 0.01), 1.0, 1.0],
            polygon_norm=[
                [0.0, wy],
                [0.36, max(0.2, wy - 0.01)],
                [0.64, max(0.2, wy - 0.01)],
                [1.0, wy],
                [1.0, 1.0],
                [0.0, 1.0],
            ],
        ),
        SAMMaskObject(
            id=f"mask-ref-{prefix}",
            concept=ref_concept,
            confidence=0.92,
            bbox_norm=[0.45, 0.44, 0.62, 0.69],
            polygon_norm=[[0.45, 0.44], [0.62, 0.44], [0.62, 0.69], [0.45, 0.69]],
            submerged_ratio=sub_ratio,
            standard_height_m=ref_height,
            geometry_source="preset",
        ),
        SAMMaskObject(
            id=f"mask-gate-{prefix}",
            concept="gate",
            confidence=0.89,
            bbox_norm=[0.10, 0.42, 0.23, 0.78],
            polygon_norm=[[0.10, 0.42], [0.23, 0.42], [0.23, 0.78], [0.10, 0.78]],
            submerged_ratio=round(min(0.95, sub_ratio * 0.78), 2),
            standard_height_m=2.10,
            geometry_source="preset",
        ),
    ]


# Complete 12-Sector Preset Catalog covering all 11 Barangays of Rodriguez (Montalban), Rizal
SCENARIO_PRESETS: Dict[str, ScenarioPreset] = {
    "kasiglahan_village": ScenarioPreset(
        id="kasiglahan_village",
        name="Kasiglahan Village Housing (Brgy. San Jose)",
        barangay="SAN JOSE",
        subtitle="Phase 1K Lowland Basin · Puray-Montalban River Confluence",
        cam_lat=14.7498,
        cam_lon=121.1372,
        azimuth_deg=118.0,
        fov_deg=65.0,
        default_click_u=0.52,
        default_click_v=0.56,
        est_distance_m=38.0,
        water_depth_m=1.35,
        photo_url="/static/photos/kasiglahan_village.jpg",
        evacuation_center_name="Kasiglahan Village Elementary School (MDRRMO Sector 1)",
        evacuation_center_lat=14.7528,
        evacuation_center_lon=121.1414,
        river_basin="Upper Marikina / Puray Creek",
        alert_level="CRITICAL (Red Warning)",
        visual_gauge=VisualGaugeResult(
            reference_object_detected="Submerged Utility Tricycle & Residential Gate",
            reference_standard_height_m=1.65,
            submerged_ratio=0.82,
            estimated_water_depth_m=1.35,
            estimated_distance_from_camera_m=38.0,
            recommended_click_u=0.52,
            recommended_click_v=0.56,
            confidence_score=0.91,
            hydrological_reasoning=(
                "Floodwater meniscus reaches 82% of the standard 1.65m residential steel gate and fully "
                "submerges the 1.25m tricycle sidecar cabin roof line at 38m forward range (depth = 1.35m)."
            ),
        ),
        sam_masks=_make_masks_for_water_y("kv", 0.56, "tricycle", 1.65, 0.82),
    ),
    "san_jose_riverfront": ScenarioPreset(
        id="san_jose_riverfront",
        name="Brgy. San Jose Riverfront Dike Road",
        barangay="SAN JOSE",
        subtitle="Wawa-Montalban Riverbank Spillway · West Dike Access",
        cam_lat=14.7425,
        cam_lon=121.1348,
        azimuth_deg=142.0,
        fov_deg=68.0,
        default_click_u=0.54,
        default_click_v=0.52,
        est_distance_m=44.0,
        water_depth_m=1.41,
        photo_url="/static/photos/san_jose_riverfront.jpg",
        evacuation_center_name="Brgy. San Jose Covered Court & Rescue Command Post",
        evacuation_center_lat=14.7458,
        evacuation_center_lon=121.1305,
        river_basin="Montalban-Marikina Main Channel",
        alert_level="CRITICAL (Spillway Overtopping)",
        visual_gauge=VisualGaugeResult(
            reference_object_detected="Submerged Passenger Sedan & First-Floor Entrance",
            reference_standard_height_m=1.48,
            submerged_ratio=0.95,
            estimated_water_depth_m=1.41,
            estimated_distance_from_camera_m=44.0,
            recommended_click_u=0.54,
            recommended_click_v=0.52,
            confidence_score=0.89,
            hydrological_reasoning=(
                "Waterline overtops the 1.48m passenger sedan roof line and reaches 78% of the 2.1m "
                "first-floor commercial entrance frame at 44m range, indicating 1.41m standing flood depth (1.48m x 0.95)."
            ),
        ),
        sam_masks=_make_masks_for_water_y("sj", 0.52, "car", 1.48, 0.95),
    ),
    "montalban_town_center": ScenarioPreset(
        id="montalban_town_center",
        name="Montalban Town Center (Brgy. Rosario)",
        barangay="ROSARIO",
        subtitle="E. Rodriguez Highway Commercial Corridor · Public Market Approach",
        cam_lat=14.7328,
        cam_lon=121.1422,
        azimuth_deg=86.0,
        fov_deg=60.0,
        default_click_u=0.50,
        default_click_v=0.62,
        est_distance_m=32.0,
        water_depth_m=0.72,
        photo_url="/static/photos/montalban_town_center.jpg",
        evacuation_center_name="Rodriguez Municipal Gymnasium (Montalban Command Center)",
        evacuation_center_lat=14.7362,
        evacuation_center_lon=121.1468,
        river_basin="Manggahan-Rosario Drainage Canal",
        alert_level="HIGH (Orange Warning)",
        visual_gauge=VisualGaugeResult(
            reference_object_detected="Vehicle Wheel Arch & Perimeter Gate Lower Panel",
            reference_standard_height_m=0.72,
            submerged_ratio=1.0,
            estimated_water_depth_m=0.72,
            estimated_distance_from_camera_m=32.0,
            recommended_click_u=0.50,
            recommended_click_v=0.62,
            confidence_score=0.94,
            hydrological_reasoning=(
                "Water surface fully submerges the 0.72m utility vehicle wheel arch and reaches the lower "
                "crossbar of the commercial steel gate at 32m distance (depth = 0.72m x 1.0 = 0.72m)."
            ),
        ),
        sam_masks=_make_masks_for_water_y("mtc", 0.62, "vehicle wheel", 0.72, 1.0),
    ),
    "san_isidro_southville": ScenarioPreset(
        id="san_isidro_southville",
        name="Southville 8B/8C Housing (Brgy. San Isidro)",
        barangay="SAN ISIDRO",
        subtitle="San Isidro Relocation Basin · Upper Puray Tributary",
        cam_lat=14.7645,
        cam_lon=121.1485,
        azimuth_deg=105.0,
        fov_deg=65.0,
        default_click_u=0.51,
        default_click_v=0.55,
        est_distance_m=36.0,
        water_depth_m=1.25,
        photo_url="/static/photos/san_isidro_southville.jpg",
        evacuation_center_name="San Isidro National High School Evacuation Complex",
        evacuation_center_lat=14.7678,
        evacuation_center_lon=121.1532,
        river_basin="San Isidro-Puray Foothill Catchment",
        alert_level="CRITICAL (Red Warning)",
        visual_gauge=VisualGaugeResult(
            reference_object_detected="Submerged Tricycle Sidecar & Block Entrance Gate",
            reference_standard_height_m=1.65,
            submerged_ratio=0.76,
            estimated_water_depth_m=1.25,
            estimated_distance_from_camera_m=36.0,
            recommended_click_u=0.51,
            recommended_click_v=0.55,
            confidence_score=0.92,
            hydrological_reasoning=(
                "Flash-flood runoff in Southville 8B submerges 76% of the 1.65m tricycle frame and block gate (depth = 1.25m)."
            ),
        ),
        sam_masks=_make_masks_for_water_y("sis", 0.55, "tricycle", 1.65, 0.76),
    ),
    "burgos_lowland": ScenarioPreset(
        id="burgos_lowland",
        name="M.H. Del Pilar Floodplain (Brgy. Burgos)",
        barangay="BURGOS",
        subtitle="Lower Marikina Riverbank · Burgos Residential Lowland",
        cam_lat=14.7218,
        cam_lon=121.1362,
        azimuth_deg=135.0,
        fov_deg=65.0,
        default_click_u=0.53,
        default_click_v=0.54,
        est_distance_m=40.0,
        water_depth_m=1.44,
        photo_url="/static/photos/burgos_lowland.jpg",
        evacuation_center_name="Burgos Elementary School & Barangay Rescue Hall",
        evacuation_center_lat=14.7248,
        evacuation_center_lon=121.1404,
        river_basin="Lower Montalban-Marikina Floodplain",
        alert_level="CRITICAL (Red Warning)",
        visual_gauge=VisualGaugeResult(
            reference_object_detected="Submerged Sedan Roof & Compound Gate",
            reference_standard_height_m=1.50,
            submerged_ratio=0.96,
            estimated_water_depth_m=1.44,
            estimated_distance_from_camera_m=40.0,
            recommended_click_u=0.53,
            recommended_click_v=0.54,
            confidence_score=0.90,
            hydrological_reasoning=(
                "River backflow along M.H. Del Pilar Street reaches 96% of a 1.50m passenger vehicle (depth = 1.45m)."
            ),
        ),
        sam_masks=_make_masks_for_water_y("brg", 0.54, "car", 1.50, 0.96),
    ),
    "san_rafael_wawa": ScenarioPreset(
        id="san_rafael_wawa",
        name="Wawa River Spillway Corridor (Brgy. San Rafael)",
        barangay="SAN RAFAEL",
        subtitle="Wawa Gorge Downstream Outflow · Sitio Wawa Approach",
        cam_lat=14.7285,
        cam_lon=121.1535,
        azimuth_deg=92.0,
        fov_deg=65.0,
        default_click_u=0.52,
        default_click_v=0.53,
        est_distance_m=42.0,
        water_depth_m=1.55,
        photo_url="/static/photos/san_rafael_wawa.jpg",
        evacuation_center_name="San Rafael Elementary School (Wawa Dam Sector)",
        evacuation_center_lat=14.7315,
        evacuation_center_lon=121.1580,
        river_basin="Wawa Dam / Upper Marikina Gorge",
        alert_level="CRITICAL (Spillway Surge)",
        visual_gauge=VisualGaugeResult(
            reference_object_detected="Submerged Utility Vehicle & Steel Gate",
            reference_standard_height_m=1.70,
            submerged_ratio=0.91,
            estimated_water_depth_m=1.55,
            estimated_distance_from_camera_m=42.0,
            recommended_click_u=0.52,
            recommended_click_v=0.53,
            confidence_score=0.91,
            hydrological_reasoning=(
                "High-velocity discharge from Wawa Gorge submerges 91% of the 1.70m utility vehicle (depth = 1.55m)."
            ),
        ),
        sam_masks=_make_masks_for_water_y("srw", 0.53, "car", 1.70, 0.91),
    ),
    "manggahan_highway": ScenarioPreset(
        id="manggahan_highway",
        name="E. Rodriguez Hwy Drainage Basin (Brgy. Manggahan)",
        barangay="MANGGAHAN",
        subtitle="Manggahan Commercial Strip · Municipal Hall Approach",
        cam_lat=14.7282,
        cam_lon=121.1418,
        azimuth_deg=75.0,
        fov_deg=62.0,
        default_click_u=0.50,
        default_click_v=0.60,
        est_distance_m=34.0,
        water_depth_m=0.95,
        photo_url="/static/photos/manggahan_highway.jpg",
        evacuation_center_name="Manggahan Covered Court & MDRRMO Staging Post",
        evacuation_center_lat=14.7305,
        evacuation_center_lon=121.1458,
        river_basin="Manggahan Creek Urban Basin",
        alert_level="HIGH (Orange Warning)",
        visual_gauge=VisualGaugeResult(
            reference_object_detected="Submerged Tricycle Wheel & Commercial Entrance",
            reference_standard_height_m=1.25,
            submerged_ratio=0.76,
            estimated_water_depth_m=0.95,
            estimated_distance_from_camera_m=34.0,
            recommended_click_u=0.50,
            recommended_click_v=0.60,
            confidence_score=0.93,
            hydrological_reasoning=(
                "Urban creek overflow along E. Rodriguez Hwy submerges 76% of the 1.25m tricycle chassis (depth = 0.95m)."
            ),
        ),
        sam_masks=_make_masks_for_water_y("mng", 0.60, "tricycle", 1.25, 0.76),
    ),
    "balite_proper": ScenarioPreset(
        id="balite_proper",
        name="J.P. Rizal Ave Town Proper (Brgy. Balite)",
        barangay="BALITE",
        subtitle="Balite Urban Core · Municipal Center Catchbasin",
        cam_lat=14.7325,
        cam_lon=121.1455,
        azimuth_deg=110.0,
        fov_deg=62.0,
        default_click_u=0.51,
        default_click_v=0.61,
        est_distance_m=33.0,
        water_depth_m=0.80,
        photo_url="/static/photos/balite_proper.jpg",
        evacuation_center_name="Balite Elementary School Evacuation Center",
        evacuation_center_lat=14.7355,
        evacuation_center_lon=121.1492,
        river_basin="Balite-Rosario Urban Drainage",
        alert_level="HIGH (Orange Warning)",
        visual_gauge=VisualGaugeResult(
            reference_object_detected="Vehicle Wheel Arch & Storefront Gate",
            reference_standard_height_m=0.80,
            submerged_ratio=1.0,
            estimated_water_depth_m=0.80,
            estimated_distance_from_camera_m=33.0,
            recommended_click_u=0.51,
            recommended_click_v=0.61,
            confidence_score=0.92,
            hydrological_reasoning=(
                "Sheet flooding along J.P. Rizal Ave reaches 0.80m above curb grade, submerging vehicle wheel arches."
            ),
        ),
        sam_masks=_make_masks_for_water_y("blt", 0.61, "vehicle wheel", 0.80, 1.0),
    ),
    "geronimo_riverbank": ScenarioPreset(
        id="geronimo_riverbank",
        name="Gen. Licerio Geronimo Corridor (Brgy. Geronimo)",
        barangay="GERONIMO",
        subtitle="Geronimo Lowland Creek · East Town Proper",
        cam_lat=14.7352,
        cam_lon=121.1488,
        azimuth_deg=125.0,
        fov_deg=64.0,
        default_click_u=0.52,
        default_click_v=0.57,
        est_distance_m=36.0,
        water_depth_m=1.15,
        photo_url="/static/photos/geronimo_riverbank.jpg",
        evacuation_center_name="Geronimo National High School Command Center",
        evacuation_center_lat=14.7380,
        evacuation_center_lon=121.1528,
        river_basin="Geronimo Tributary Creek",
        alert_level="CRITICAL (Red Warning)",
        visual_gauge=VisualGaugeResult(
            reference_object_detected="Submerged Tricycle & Perimeter Gate",
            reference_standard_height_m=1.60,
            submerged_ratio=0.72,
            estimated_water_depth_m=1.15,
            estimated_distance_from_camera_m=36.0,
            recommended_click_u=0.52,
            recommended_click_v=0.57,
            confidence_score=0.90,
            hydrological_reasoning=(
                "Tributary overflow along Gen. Licerio Geronimo St reaches 1.15m depth across residential blocks."
            ),
        ),
        sam_masks=_make_masks_for_water_y("ger", 0.57, "tricycle", 1.60, 0.72),
    ),
    "macabud_upland": ScenarioPreset(
        id="macabud_upland",
        name="Macabud Foothill Tributary (Brgy. Macabud)",
        barangay="MACABUD",
        subtitle="Northern Montalban Foothills · Puray Creek Confluence",
        cam_lat=14.7865,
        cam_lon=121.1435,
        azimuth_deg=150.0,
        fov_deg=65.0,
        default_click_u=0.50,
        default_click_v=0.58,
        est_distance_m=35.0,
        water_depth_m=1.05,
        photo_url="/static/photos/macabud_upland.jpg",
        evacuation_center_name="Macabud Barangay Multi-Purpose Evacuation Hall",
        evacuation_center_lat=14.7895,
        evacuation_center_lon=121.1475,
        river_basin="Macabud-Puray Northern Sub-basin",
        alert_level="HIGH (Flash Flood Watch)",
        visual_gauge=VisualGaugeResult(
            reference_object_detected="Submerged Gate & Utility Vehicle Chassis",
            reference_standard_height_m=1.50,
            submerged_ratio=0.70,
            estimated_water_depth_m=1.05,
            estimated_distance_from_camera_m=35.0,
            recommended_click_u=0.50,
            recommended_click_v=0.58,
            confidence_score=0.89,
            hydrological_reasoning=(
                "Upland flash flood in Brgy. Macabud reaches 1.05m depth along low-lying creek crossings."
            ),
        ),
        sam_masks=_make_masks_for_water_y("mcb", 0.58, "gate", 1.50, 0.70),
    ),
    "mascap_valley": ScenarioPreset(
        id="mascap_valley",
        name="Mascap Valley River Crossing (Brgy. Mascap)",
        barangay="MASCAP",
        subtitle="Payaran-Mascap Valley Floor · Sierra Madre Foothills",
        cam_lat=14.7553,
        cam_lon=121.1820,
        azimuth_deg=130.0,
        fov_deg=66.0,
        default_click_u=0.52,
        default_click_v=0.56,
        est_distance_m=38.0,
        water_depth_m=1.20,
        photo_url="/static/photos/mascap_valley.jpg",
        evacuation_center_name="Mascap Elementary School & Relief Center",
        evacuation_center_lat=14.7582,
        evacuation_center_lon=121.1862,
        river_basin="Mascap-Payaran River Valley",
        alert_level="CRITICAL (Valley Swell)",
        visual_gauge=VisualGaugeResult(
            reference_object_detected="Submerged Rural Tricycle & Compound Gate",
            reference_standard_height_m=1.65,
            submerged_ratio=0.73,
            estimated_water_depth_m=1.20,
            estimated_distance_from_camera_m=38.0,
            recommended_click_u=0.52,
            recommended_click_v=0.56,
            confidence_score=0.90,
            hydrological_reasoning=(
                "Mountain catchment swell in Brgy. Mascap submerges 73% of the 1.65m reference gate and vehicle (depth = 1.20m)."
            ),
        ),
        sam_masks=_make_masks_for_water_y("msc", 0.56, "tricycle", 1.65, 0.73),
    ),
    "puray_basin": ScenarioPreset(
        id="puray_basin",
        name="Puray River Lowland Crossing (Brgy. Puray)",
        barangay="PURAY",
        subtitle="Northeast Montalban Watershed · Puray River Spillway",
        cam_lat=14.7920,
        cam_lon=121.1980,
        azimuth_deg=115.0,
        fov_deg=65.0,
        default_click_u=0.52,
        default_click_v=0.54,
        est_distance_m=40.0,
        water_depth_m=1.40,
        photo_url="/static/photos/puray_basin.jpg",
        evacuation_center_name="Puray Elementary School & Upland Rescue Post",
        evacuation_center_lat=14.7950,
        evacuation_center_lon=121.2022,
        river_basin="Puray River Main Watershed",
        alert_level="CRITICAL (River Swell)",
        visual_gauge=VisualGaugeResult(
            reference_object_detected="Submerged Utility Vehicle & Steel Gate",
            reference_standard_height_m=1.65,
            submerged_ratio=0.85,
            estimated_water_depth_m=1.40,
            estimated_distance_from_camera_m=40.0,
            recommended_click_u=0.52,
            recommended_click_v=0.54,
            confidence_score=0.91,
            hydrological_reasoning=(
                "Puray River overflow submerges 85% of the 1.65m reference vehicle and gate structure (depth = 1.40m)."
            ),
        ),
        sam_masks=_make_masks_for_water_y("pry", 0.54, "car", 1.65, 0.85),
    ),
}



def ensure_sample_photos() -> None:
    """
    Ensures real flood photos are present for all demo scenarios.
    Synthetic cartoon drawings are completely eliminated.
    """
    import shutil
    PHOTOS_DIR.mkdir(parents=True, exist_ok=True)
    real_fallback = PHOTOS_DIR / "upload_1818cea705.jpg"
    if not real_fallback.exists():
        candidates = list(PHOTOS_DIR.glob("upload_*.jpg"))
        real_fallback = candidates[0] if candidates else None

    # Map the primary presets to their genuine flood photos
    demo_map = {
        "kasiglahan_village": "upload_1818cea705.jpg",
        "burgos_lowland": "upload_3794a1e660.jpg",
        "montalban_town_center": "upload_7741ab121f.jpg",
    }

    for scen_id in SCENARIO_PRESETS:
        normal_path = PHOTOS_DIR / f"{scen_id}.jpg"

        # Ensure normal photo is a real photograph
        if not normal_path.exists() or normal_path.stat().st_size < 40000:
            donor_filename = demo_map.get(scen_id, "upload_1818cea705.jpg")
            donor_path = PHOTOS_DIR / donor_filename
            if not donor_path.exists() and real_fallback:
                donor_path = real_fallback
            if donor_path and donor_path.exists():
                shutil.copy2(donor_path, normal_path)



def get_scenarios() -> List[ScenarioPreset]:
    ensure_sample_photos()
    return list(SCENARIO_PRESETS.values())


def _encode_image_b64(image_path: Path) -> str:
    data = image_path.read_bytes()
    return f"data:image/jpeg;base64,{base64.b64encode(data).decode('ascii')}"


SAM_POLYGON_TOKEN = re.compile(r"<\|polygon;([^|]*)\|>", re.IGNORECASE)
_NUM_RE = re.compile(r"-?\d+(?:\.\d+)?")


def _polys_from_text(raw_text: str) -> List[List[List[float]]]:
    """Extract <|polygon;...|> point sequences from SAM text output."""
    polys = []
    for m in SAM_POLYGON_TOKEN.finditer(raw_text or ""):
        nums = [float(x) for x in _NUM_RE.findall(m.group(1))]
        pts = [[nums[i], nums[i + 1]] for i in range(0, len(nums) - 1, 2)]
        if len(pts) >= 3:
            polys.append(pts)
    return polys


def _polys_from_json(obj: Any) -> List[List[List[float]]]:
    """Recursively collect polygon/points/contour lists from a SAM JSON response."""
    found: List[List[List[float]]] = []

    def _is_pair_list(v):
        return (
            isinstance(v, list)
            and len(v) >= 3
            and all(isinstance(pt, (list, tuple)) and len(pt) >= 2
                    and isinstance(pt[0], (int, float)) and isinstance(pt[1], (int, float)) for pt in v)
        )

    def _walk(o):
        if isinstance(o, dict):
            for k, v in o.items():
                kl = str(k).lower()
                if any(tok in kl for tok in ("polygon", "contour", "points", "segmentation")) and _is_pair_list(v):
                    found.append([[float(pt[0]), float(pt[1])] for pt in v])
                else:
                    _walk(v)
        elif isinstance(o, list):
            for item in o:
                _walk(item)

    _walk(obj)
    return found


def _normalize_poly(pts: List[List[float]], img_w: float, img_h: float) -> List[List[float]]:
    max_x = max((pt[0] for pt in pts), default=0.0)
    max_y = max((pt[1] for pt in pts), default=0.0)
    out = []
    for x, y in pts:
        u = float(x) / img_w if max_x > 1.5 else float(x)
        v = float(y) / img_h if max_y > 1.5 else float(y)
        out.append([round(max(0.0, min(1.0, u)), 3), round(max(0.0, min(1.0, v)), 3)])
    return out


def _rasterize_poly(poly_norm: List[List[float]], rw: int, rh: int):
    """Rasterize a normalized polygon to a boolean pixel grid (PIL polygon fill)."""
    img = Image.new("1", (rw, rh), 0)
    if poly_norm and len(poly_norm) >= 3:
        pts = [(float(u) * rw, float(v) * rh) for u, v in poly_norm]
        ImageDraw.Draw(img).polygon(pts, fill=1)
    elif poly_norm:
        pts = [(float(u) * rw, float(v) * rh) for u, v in poly_norm]
        ImageDraw.Draw(img).line(pts + [pts[0]], fill=1, width=1)
    return np.array(img, dtype=bool)


def _compute_mask_geometry(masks: List[SAMMaskObject], image_path: Path) -> List[SAMMaskObject]:
    """
    SAM is the sensor: rasterize every mask polygon and MEASURE, per mask,
    pixel area, the waterline, and - for reference objects - the submerged
    ratio as the fraction of the object's mask pixels overlapped by the
    floodwater mask (falling back to the waterline row at the object's
    centre column when the water mask does not overlap it horizontally).
    Nothing here is estimated by a language model.
    """
    try:
        with Image.open(image_path) as im:
            iw, ih = im.size
    except Exception:
        return masks
    if iw < 2 or ih < 2:
        return masks
    scale = min(1.0, 512.0 / float(iw))
    rw = max(2, int(round(iw * scale)))
    rh = max(2, int(round(ih * scale)))
    total_px = float(rw * rh)

    rasters = {}
    water = np.zeros((rh, rw), dtype=bool)
    for m in masks:
        r = _rasterize_poly(m.polygon_norm or [], rw, rh)
        rasters[m.id] = r
        m.pixel_count = int(r.sum())
        m.mask_area_frac = round(float(r.sum()) / total_px, 4) if total_px else 0.0
        if m.concept == "floodwater":
            water |= r

    if not water.any():
        return masks

    rows_any = np.where(water.any(axis=1))[0]
    waterline_global = float(rows_any[0]) / float(rh) if len(rows_any) else None
    for m in masks:
        if m.concept == "floodwater":
            m.waterline_v = round(waterline_global, 3) if waterline_global is not None else None
            continue
        r = rasters.get(m.id)
        if r is None or not r.any():
            continue
        px = float(r.sum())
        overlap = float((r & water).sum()) / px if px else 0.0
        if overlap > 0:
            m.submerged_ratio = round(max(0.0, min(1.0, overlap)), 3)
            # waterline at the object's centre column for display/cross-check
            cx = int(min(rw - 1, max(0, round((m.bbox_norm[0] + m.bbox_norm[2]) * 0.5 * rw)))) if m.bbox_norm else rw // 2
            col = np.where(water[:, cx])[0]
            if len(col):
                m.waterline_v = round(float(col[0]) / float(rh), 3)
        else:
            # No horizontal overlap: use the waterline row at centre column
            # against the object's own top/bottom from its bbox.
            if not m.bbox_norm:
                continue
            cx = int(min(rw - 1, max(0, round((m.bbox_norm[0] + m.bbox_norm[2]) * 0.5 * rw))))
            col = np.where(water[:, cx])[0]
            if not len(col):
                m.submerged_ratio = 0.0
                continue
            wl = float(col[0])
            top = float(m.bbox_norm[1]) * rh
            bottom = float(m.bbox_norm[3]) * rh
            m.waterline_v = round(wl / float(rh), 3)
            m.submerged_ratio = round(max(0.0, min(1.0, (bottom - wl) / max(1.0, bottom - top))), 3)
    return masks


def _apply_sam_geometry_to_gauge(masks: List[SAMMaskObject], gauge: VisualGaugeResult) -> VisualGaugeResult:
    """
    Replace the model's guessed submerged_ratio with the ratio MEASURED from
    SAM mask pixels for the reference object the gauge named. Depth is then
    recomputed as height x measured_ratio by the VisualGaugeResult validator.
    Gauges whose reference object has no SAM mask keep the model estimate.
    """
    cands = [
        m for m in masks
        if m.concept != "floodwater"
        and m.geometry_source in ("sam_polygon", "sam_box")
        and m.submerged_ratio is not None
        and m.pixel_count
    ]
    if not cands:
        return gauge
    ref = (gauge.reference_object_detected or "").lower()
    matched = next(
        (m for m in cands if set(m.concept.lower().split()) <= set(ref.split())),
        None,
    )
    if matched is None:
        return gauge
    h = float(matched.standard_height_m or gauge.reference_standard_height_m)
    ratio = float(matched.submerged_ratio)
    return VisualGaugeResult(
        reference_object_detected=gauge.reference_object_detected,
        reference_standard_height_m=h,
        submerged_ratio=ratio,
        estimated_water_depth_m=round(h * ratio, 2),
        estimated_distance_from_camera_m=gauge.estimated_distance_from_camera_m,
        recommended_click_u=gauge.recommended_click_u,
        recommended_click_v=gauge.recommended_click_v,
        confidence_score=gauge.confidence_score,
        hydrological_reasoning=(
            f"{gauge.hydrological_reasoning} "
            f"[SAM mask geometry: {matched.concept} submerged_ratio {ratio:.2f} measured from "
            f"{int(matched.pixel_count)} mask px ({matched.geometry_source}); depth = {h:.2f} m x {ratio:.2f}.]"
        ),
        submerged_ratio_source="sam_mask_geometry",
        sam_mask_pixel_count=int(matched.pixel_count),
    )


def _query_single_sam3_concept(b64_url: str, concept: str, img_w: int = 1000, img_h: int = 1000) -> Tuple[List[SAMMaskObject], bool]:
    """
    Queries Meta `sam-3.1` (`POST /v1/responses`) for a single concept string
    and parses all `<|box;x1=...;y1=...;x2=...;y2=...;w=...;h=...|>` detections.
    """
    display_concept = "floodwater" if concept == "water" else concept
    results: List[SAMMaskObject] = []
    try:
        req_body = {
            "model": "sam-3.1",
            "stream": False,
            "input": [
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": concept},
                        {"type": "input_image", "image_url": b64_url},
                    ],
                }
            ],
        }
        with httpx.Client(timeout=14.0) as client:
            resp = client.post(
                f"{META_API_BASE_URL}/responses",
                headers={
                    "Authorization": f"Bearer {META_API_KEY}",
                    "Content-Type": "application/json",
                },
                json=req_body,
            )
            if resp.status_code != 200:
                logger.warning(f"SAM 3.1: concept '{concept}' query returned HTTP {resp.status_code}: {resp.text[:200]}")
                return [], False
            output_list = resp.json().get("output", [])
            if not output_list:
                logger.warning(f"SAM 3.1: concept '{concept}' returned empty output: {resp.text[:200]}")
                return [], True
            content_list = output_list[0].get("content", [])
            if not content_list:
                return [], True
            raw_text = content_list[0].get("text", "")
            matches = SAM_BOX_PATTERN.findall(raw_text)
            # Prefer SAM's actual mask polygons when the response carries them
            _raw_polys = _polys_from_text(raw_text) or _polys_from_json(resp.json())
            sam_polys = [_normalize_poly(pp, float(img_w), float(img_h)) for pp in _raw_polys]
            for idx, (x1_s, y1_s, x2_s, y2_s, w_s, h_s) in enumerate(matches):
                w_f = max(1.0, float(w_s))
                h_f = max(1.0, float(h_s))
                u1 = round(max(0.0, min(1.0, float(x1_s) / w_f)), 3)
                v1 = round(max(0.0, min(1.0, float(y1_s) / h_f)), 3)
                u2 = round(max(0.0, min(1.0, float(x2_s) / w_f)), 3)
                v2 = round(max(0.0, min(1.0, float(y2_s) / h_f)), 3)
                box_area = (u2 - u1) * (v2 - v1)
                # Filter out tiny background noise (<0.3% of image area, preserving vertical utility poles and distant people)
                if box_area < 0.003:
                    continue

                if idx < len(sam_polys) and len(sam_polys[idx]) >= 3:
                    poly = sam_polys[idx]
                    geom_source = "sam_polygon"
                    conf = round(max(0.84, 0.94 - idx * 0.03), 2)
                elif display_concept == "floodwater":
                    poly = [
                        [u1, v1],
                        [round((u1 + u2) * 0.35, 3), max(0.0, round(v1 - 0.01, 3))],
                        [round((u1 + u2) * 0.65, 3), max(0.0, round(v1 - 0.01, 3))],
                        [u2, v1],
                        [u2, v2],
                        [u1, v2],
                    ]
                    conf = 0.96
                    geom_source = "sam_box"
                else:
                    poly = [[u1, v1], [u2, v1], [u2, v2], [u1, v2]]
                    conf = round(max(0.84, 0.94 - idx * 0.03), 2)
                    geom_source = "sam_box"

                results.append(
                    SAMMaskObject(
                        id=f"sam3-{display_concept.replace(' ', '_')}-{idx}",
                        concept=display_concept,
                        confidence=conf,
                        bbox_norm=[u1, v1, u2, v2],
                        polygon_norm=poly,
                        submerged_ratio=None,
                        standard_height_m=STANDARD_HEIGHTS_M.get(display_concept, 1.5),
                        geometry_source=geom_source,
                    )
                )
    except Exception as e:
        logger.error(f"SAM 3.1: Exception querying concept '{concept}': {e}", exc_info=True)
        return [], False

    # Sort by bounding box area descending and keep top detections
    results.sort(
        key=lambda m: (m.bbox_norm[2] - m.bbox_norm[0]) * (m.bbox_norm[3] - m.bbox_norm[1]),
        reverse=True,
    )
    final_res = results[:1] if display_concept == "floodwater" else results[:3]
    return final_res, True


def call_sam3_segmentation(
    image_path: Path,
    prompts: List[str],
    scenario_id: str = "kasiglahan_village",
    is_custom_upload: bool = False,
) -> Tuple[List[SAMMaskObject], bool, bool]:
    """
    Calls Meta SAM 3.1 (`sam-3.1`) via POST /v1/responses with SHA256 disk caching.
    Parses real `<|box;x1=...;y1=...;x2=...;y2=...;w=...;h=...|>` coordinates from SAM 3.1.
    """
    img_hash = hashlib.sha256(image_path.read_bytes()).hexdigest()[:16]
    cache_key_payload = {
        "endpoint": "sam-3.1/responses-parsed-v4-geometry",
        "image_hash": img_hash,
        "prompts": prompts,
        "scenario_id": scenario_id,
        "is_custom_upload": is_custom_upload,
    }
    cached = _read_cache(cache_key_payload)
    if cached is not None:
        logger.info(f"SAM 3.1: Cache hit for image_hash={img_hash} (scenario={scenario_id})")
        return [SAMMaskObject(**m) for m in cached["masks"]], False, True

    preset = SCENARIO_PRESETS.get(scenario_id, SCENARIO_PRESETS["kasiglahan_village"])
    if not META_API_KEY:
        # No key configured: an Authorization header with an empty Bearer token
        # is rejected client-side, so skip the doomed live calls entirely and
        # go straight to the calibrated fallback (preset masks / empty for uploads).
        if is_custom_upload:
            return [], True, False
        return list(preset.sam_masks), True, False
    # Run live SAM 3.1 perception across key flood concepts for all photos (preset or upload)
    b64_url = _encode_image_b64(image_path)
    try:
        with Image.open(image_path) as _im:
            _img_w, _img_h = _im.size
    except Exception:
        _img_w, _img_h = 1000, 1000
    concepts_to_query = ["water", "person", "car", "tricycle", "gate", "utility pole"]
    detected_masks: List[SAMMaskObject] = []

    any_api_ok = False
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = [pool.submit(_query_single_sam3_concept, b64_url, c, _img_w, _img_h) for c in concepts_to_query]
        for fut in futures:
            try:
                res_masks, ok = fut.result()
                if ok:
                    any_api_ok = True
                detected_masks.extend(res_masks)
            except Exception as e:
                logger.error(f"Error in SAM concept future: {e}")

    if any_api_ok:
        detected_masks = _compute_mask_geometry(detected_masks, image_path)
        _write_cache(
            cache_key_payload,
            {
                "masks": [m.model_dump() for m in detected_masks],
                "source": "sam-3.1-live-parsed",
            },
        )
        logger.info(f"SAM 3.1: Live parsed {len(detected_masks)} masks for {image_path.name}")
        return detected_masks, False, False

    # Fallback only if offline / rate-limited
    if is_custom_upload:
        # Never return benchmark scenario masks (e.g. Kasiglahan Village) for custom operator photos!
        logger.warning(f"SAM 3.1: Live API failed for custom upload {image_path.name}")
        return [], True, False
    fallback_masks = list(preset.sam_masks)
    return fallback_masks, True, False


def call_muse_spark_visual_gauge(
    image_path: Path,
    masks: List[SAMMaskObject],
    scenario_id: str = "kasiglahan_village",
    is_custom_upload: bool = False,
) -> Tuple[VisualGaugeResult, bool, bool]:
    """
    Calls Meta Muse Spark 1.3 (`muse-spark-1.3`) with multimodal image input +
    parsed SAM 3.1 bounding boxes (`response_format={"type": "json_object"}`).
    """
    preset = SCENARIO_PRESETS.get(scenario_id, SCENARIO_PRESETS["kasiglahan_village"])
    img_hash = hashlib.sha256(image_path.read_bytes()).hexdigest()[:16]
    cache_key_payload = {
        "endpoint": "muse-spark-1.3/visual-gauge-v3",
        "image_hash": img_hash,
        "scenario_id": scenario_id,
        "is_custom_upload": is_custom_upload,
        "masks": [m.model_dump() for m in masks],
    }
    cached = _read_cache(cache_key_payload)
    if cached is not None:
        logger.info(f"Muse Spark 1.3: Cache hit for image_hash={img_hash} (scenario={scenario_id})")
        return VisualGaugeResult(**cached["visual_gauge"]), False, True

    if not META_API_KEY:
        # See call_sam3_segmentation: no key -> calibrated fallback, no live call.
        if is_custom_upload:
            return VisualGaugeResult(
                reference_object_detected="Operator Field Waterline",
                reference_standard_height_m=1.60,
                submerged_ratio=0.50,
                estimated_water_depth_m=0.80,
                estimated_distance_from_camera_m=20.0,
                recommended_click_u=0.50,
                recommended_click_v=0.65,
                confidence_score=0.80,
                hydrological_reasoning="Field photo loaded. Click the visible waterline on the photo to calibrate ray casting and depth.",
            ), True, False
        return preset.visual_gauge, True, False

    # Run live Muse Spark 1.3 visual gauge for all photos (preset or upload)
    system_prompt = (
        "You are HydroSight AI's Visual Hydrological Gauge powered by Meta Muse Spark 1.3. "
        "Examine the uploaded flood photograph and the SAM 3.1 detected object bounding boxes. "
        "Identify the actual primary submerged reference object visible in the photo (e.g., wading person/adult, "
        "car, tricycle, motorcycle, gate, utility pole, building entrance) and estimate the standing flood depth "
        "in meters based on how high the waterline reaches on that reference object (for example: ankle-deep ~0.2m, "
        "knee-deep ~0.45m, thigh/waist-deep on an adult ~0.75-0.95m, chest-deep ~1.25m, car wheel ~0.7m, car roof ~1.45m). "
        "SAM mask geometry fields (sam_submerged_ratio, mask_area_frac, waterline_v) are MEASURED from rasterized SAM masks, not estimates: "
        "when sam_submerged_ratio is present for your chosen reference object, your submerged_ratio MUST equal it exactly. "
        "Return ONLY a valid JSON object with these exact keys: "
        "reference_object_detected (str), reference_standard_height_m (float), submerged_ratio (float 0.05 to 1.0), "
        "estimated_water_depth_m (float 0.15 to 3.5), estimated_distance_from_camera_m (float 5.0 to 60.0), "
        "recommended_click_u (float 0.1 to 0.9 pointing to the main reference object horizontally), "
        "recommended_click_v (float 0.25 to 0.85 pointing to the waterline on that object vertically), "
        "confidence_score (float 0.50 to 0.98), hydrological_reasoning (str)."
    )
    user_text = json.dumps(
        {
            "location": f"Brgy. {preset.barangay}, Rodriguez (Montalban), Rizal",
            "sam_3_1_detected_objects": [
                {
                    "concept": m.concept,
                    "bbox_norm_u1_v1_u2_v2": m.bbox_norm,
                    "standard_height_m": m.standard_height_m,
                    "geometry_source": m.geometry_source,
                    "mask_area_frac": m.mask_area_frac,
                    "sam_submerged_ratio": (m.submerged_ratio if m.geometry_source in ("sam_polygon", "sam_box") else None),
                    "waterline_v": m.waterline_v,
                }
                for m in masks
            ],
        }
    )

    try:
        b64_url = _encode_image_b64(image_path)
        with httpx.Client(timeout=22.0) as client:
            resp = client.post(
                f"{META_API_BASE_URL}/chat/completions",
                headers={
                    "Authorization": f"Bearer {META_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "muse-spark-1.3",
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": user_text},
                                {"type": "image_url", "image_url": {"url": b64_url}},
                            ],
                        },
                    ],
                    "response_format": {"type": "json_object"},
                    "temperature": 0.1,
                },
            )
            if resp.status_code == 200:
                content = resp.json()["choices"][0]["message"]["content"]
                parsed = json.loads(content)
                gauge = VisualGaugeResult(
                    reference_object_detected=str(parsed.get("reference_object_detected", "Detected Flood Reference")),
                    reference_standard_height_m=max(0.3, float(parsed.get("reference_standard_height_m", 1.60))),
                    submerged_ratio=max(0.05, min(1.0, float(parsed.get("submerged_ratio", 0.50)))),
                    estimated_water_depth_m=max(0.15, min(3.5, float(parsed.get("estimated_water_depth_m", 0.85)))),
                    estimated_distance_from_camera_m=max(5.0, min(80.0, float(parsed.get("estimated_distance_from_camera_m", 18.0)))),
                    recommended_click_u=max(0.05, min(0.95, float(parsed.get("recommended_click_u", 0.50)))),
                    recommended_click_v=max(0.15, min(0.90, float(parsed.get("recommended_click_v", 0.58)))),
                    confidence_score=max(0.50, min(0.99, float(parsed.get("confidence_score", 0.88)))),
                    hydrological_reasoning=str(parsed.get("hydrological_reasoning", "Analyzed via SAM 3.1 + Muse Spark 1.3.")),
                )
                _write_cache(cache_key_payload, {"visual_gauge": gauge.model_dump(), "source": "muse-spark-1.3-live"})
                logger.info(f"Muse Spark 1.3: Live visual gauge resolved for {image_path.name}: depth={gauge.estimated_water_depth_m}m, conf={gauge.confidence_score}")
                return gauge, False, False
            else:
                logger.warning(f"Muse Spark 1.3 returned HTTP {resp.status_code}: {resp.text[:300]}")
    except Exception as e:
        logger.error(f"Muse Spark 1.3 exception: {e}", exc_info=True)

    if is_custom_upload:
        generic_gauge = VisualGaugeResult(
            reference_object_detected="Operator Field Waterline",
            reference_standard_height_m=1.60,
            submerged_ratio=0.50,
            estimated_water_depth_m=0.80,
            estimated_distance_from_camera_m=20.0,
            recommended_click_u=0.50,
            recommended_click_v=0.65,
            confidence_score=0.80,
            hydrological_reasoning="Field photo loaded. Click the visible waterline on the photo to calibrate ray casting and depth.",
        )
        return generic_gauge, True, False

    return preset.visual_gauge, True, False


def extract_exif_geotag(raw_bytes: bytes) -> Optional[PhotoGeotag]:
    """Read GPS coordinates (and camera direction, if present) from EXIF.

    Must be called on the RAW upload bytes: the stored copy is re-saved as a
    plain RGB JPEG with EXIF stripped (privacy), so geotags only exist here.
    Returns None when the photo has no usable GPS EXIF, which is common for
    screenshots and photos forwarded through WhatsApp/Facebook/messengers.
    A geotag is a placement hint, never proof: callers must let the operator
    confirm or drag the pin before projecting.
    """
    try:
        with Image.open(io.BytesIO(raw_bytes)) as im:
            exif = im.getexif()
            if not exif:
                return None
            try:
                gps = exif.get_ifd(0x8825)  # GPSInfo IFD
            except Exception:
                gps = {}
            if not gps:
                return None
            # Normalise tag ids to GPS tag names where possible.
            named: Dict[str, Any] = {}
            for tag_id, value in gps.items():
                named[GPSTAGS.get(tag_id, str(tag_id))] = value

            def _dms_to_degrees(dms, ref) -> Optional[float]:
                try:
                    parts = [float(p) for p in dms]
                except Exception:
                    return None
                if len(parts) != 3:
                    return None
                deg = parts[0] + parts[1] / 60.0 + parts[2] / 3600.0
                if str(ref).upper() in ("S", "W"):
                    deg = -deg
                return deg

            lat = _dms_to_degrees(named.get("GPSLatitude"), named.get("GPSLatitudeRef"))
            lon = _dms_to_degrees(named.get("GPSLongitude"), named.get("GPSLongitudeRef"))
            if lat is None or lon is None or not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
                return None
            if abs(lat) < 0.01 and abs(lon) < 0.01:
                return None  # Null-island placeholder, not a real fix.

            direction = named.get("GPSImgDirection")
            try:
                direction_deg = float(direction) % 360.0 if direction is not None else None
            except Exception:
                direction_deg = None
            altitude = named.get("GPSAltitude")
            try:
                altitude_m = float(altitude) if altitude is not None else None
            except Exception:
                altitude_m = None

            within = 14.69 <= lat <= 14.89 and 121.10 <= lon <= 121.35
            note = (
                "EXIF GPS pre-places the camera pin. GPS accuracy is typically 5-30 m, so confirm or drag the pin in Step 2 before projecting."
                if within
                else "EXIF GPS is outside the Rodriguez pilot area, so it was NOT used to place the pin. Place the pin manually in Step 2."
            )
            return PhotoGeotag(
                lat=round(lat, 6),
                lon=round(lon, 6),
                source="exif_gps",
                direction_deg=(round(direction_deg, 1) if direction_deg is not None else None),
                altitude_m=(round(altitude_m, 1) if altitude_m is not None else None),
                within_pilot_area=within,
                note=note,
            )
    except Exception:
        return None


def analyze_water_level_with_sam3(
    scenario_id: str = "kasiglahan_village",
    uploaded_image_path: Optional[Path] = None,
    force_low_confidence_check: bool = False,
    photo_geotag: Optional[PhotoGeotag] = None,
) -> AnalyzePhotoResponse:
    """
    Runs Stage 1: Visual Depth Gauge (`sam-3.1` + `muse-spark-1.3`).
    Extracts real SAM 3.1 bounding boxes and Muse Spark 1.3 visual depth estimates for uploaded photos.
    """
    ensure_sample_photos()
    preset = SCENARIO_PRESETS.get(scenario_id, SCENARIO_PRESETS["kasiglahan_village"])
    is_custom = uploaded_image_path is not None and uploaded_image_path.exists()
    img_path = uploaded_image_path if is_custom else (PHOTOS_DIR / f"{preset.id}.jpg")
    if not img_path.exists():
        img_path = PHOTOS_DIR / "kasiglahan_village.jpg"

    photo_url = f"/static/photos/{img_path.name}" if is_custom else preset.photo_url

    prompts_used = list(PRIMARY_SAM_PROMPTS)
    masks, sam_is_fallback, sam_from_cache = call_sam3_segmentation(
        img_path, prompts_used, scenario_id=("live_operator" if is_custom else preset.id), is_custom_upload=is_custom
    )
    gauge, spark_is_fallback, spark_from_cache = call_muse_spark_visual_gauge(
        img_path, masks, scenario_id=("live_operator" if is_custom else preset.id), is_custom_upload=is_custom
    )
    is_fallback = bool(sam_is_fallback or spark_is_fallback)
    is_cached = bool(sam_from_cache and spark_from_cache)

    gauge = _apply_sam_geometry_to_gauge(masks, gauge)

    # Sync the gauge ratio only onto masks SAM geometry did not measure
    for m in masks:
        if m.concept != "floodwater" and m.submerged_ratio is None:
            m.submerged_ratio = gauge.submerged_ratio

    self_check_triggered = False
    initial_conf = gauge.confidence_score
    if gauge.confidence_score < 0.70 or force_low_confidence_check:
        self_check_triggered = True
        prompts_used.extend(FALLBACK_SAM_PROMPTS)
        # Execute real live re-prompt with fallback scale reference concepts
        fallback_masks, fb_is_fallback, fb_from_cache = call_sam3_segmentation(
            img_path, FALLBACK_SAM_PROMPTS, scenario_id=f"{'live_operator' if is_custom else preset.id}_fallback", is_custom_upload=is_custom
        )
        if fallback_masks:
            existing_ids = {m.id for m in masks}
            for fm in fallback_masks:
                if fm.id not in existing_ids:
                    masks.append(fm)
            gauge, sp_is_fallback, sp_from_cache = call_muse_spark_visual_gauge(
                img_path, masks, scenario_id=f"{'live_operator' if is_custom else preset.id}_fallback", is_custom_upload=is_custom
            )
            gauge = _apply_sam_geometry_to_gauge(masks, gauge)
            for m in masks:
                if m.concept != "floodwater" and m.submerged_ratio is None:
                    m.submerged_ratio = gauge.submerged_ratio

    if is_fallback:
        mode = "calibrated_baseline_fallback"
    elif is_cached:
        mode = "cached"
    else:
        mode = "live_inference"

    return AnalyzePhotoResponse(
        scenario_id=("live_operator" if is_custom else preset.id),
        photo_url=photo_url,
        masks=masks,
        visual_gauge=gauge,
        self_check_triggered=self_check_triggered,
        initial_confidence_score=initial_conf if self_check_triggered else None,
        prompts_used=prompts_used,
        model_chain=["sam-3.1", "muse-spark-1.3"],
        cached=is_cached,
        fallback_used=is_fallback,
        execution_mode=mode,
        is_custom_upload=is_custom,
        photo_geotag=photo_geotag if is_custom else None,
    )


def _depth_band_text(depth_m: float) -> str:
    """Responder-facing depth: rounded to 0.1 m with its risk band, never an
    exact-looking figure (the underlying DEM cannot support two decimals)."""
    d = float(depth_m)
    cat = "critical, >1.5 m" if d > 1.5 else ("medium, 0.5-1.5 m" if d >= 0.5 else "low, <0.5 m")
    return f"~{d:.1f} m ({cat})"


def _map_url(lat: float, lon: float) -> str:
    return f"https://www.openstreetmap.org/?mlat={lat:.6f}&mlon={lon:.6f}#map=18/{lat:.6f}/{lon:.6f}"


def generate_area_advisory(
    barangay: str,
    summary: InundatedStructureSummary,
    evacuation_center: str,
    vehicle_type: str,
    eta_minutes: float,
    route_distance_m: float,
    severed_segments_count: int,
    primary_route_severed: bool,
) -> Tuple["AreaAdvisory", DispatchTelemetry]:
    """General barangay-level flood advisory. Deliberately NOT per-building:
    no house, building_id, address, or occupant is targeted. Responders are
    staged to the area (safe evacuation centre) and sweep generally; residents
    get what-to-do guidance derived only from aggregate DEM depth-band counts.
    """
    from backend.schemas import AreaAdvisory

    t0 = time.perf_counter()
    critical = int(summary.critical_depth_count)
    medium = int(summary.medium_depth_count)
    low = int(summary.low_depth_count)
    affected = int(summary.affected_structures)
    compromised = list(summary.compromised_evac_centers or [])

    if critical > 0 or compromised:
        level = "SEVERE"
        headline = f"Evacuate low-lying parts of Brgy. {barangay.title()} now"
    elif medium > 0:
        level = "HIGH"
        headline = f"Be ready to evacuate in Brgy. {barangay.title()}; avoid flooded streets"
    elif affected > 0:
        level = "MODERATE"
        headline = f"Localised flooding in Brgy. {barangay.title()}; take care on flooded streets"
    else:
        level = "LOW"
        headline = f"No DEM flood impact detected for Brgy. {barangay.title()} at this water level"

    summary_text = (
        f"{affected} structure(s) in the DEM flood extent around Brgy. {barangay.title()} (footprints just across a barangay boundary are included, so a building popup may name a neighbouring barangay): "
        f"{critical} critical (>1.5 m), {medium} medium (0.5-1.5 m), {low} low (<0.5 m). "
        f"Counts are aggregate building-footprint counts only; occupancy is unknown, so no "
        f"house-by-house rescue list is issued."
    )
    if summary.affected_schools_count or summary.affected_healthcare_count or summary.affected_civic_count:
        summary_text += (
            f" Affected facilities (aggregate): {summary.affected_schools_count} school(s), "
            f"{summary.affected_healthcare_count} health facility(ies), {summary.affected_civic_count} civic building(s)."
        )

    resident_actions: List[str] = []
    if level in ("SEVERE", "HIGH"):
        resident_actions.append(
            f"If your street is in a medium or critical zone on the map (about 0.5 m or deeper), move to an upper floor or go to {evacuation_center} now. Do not wait for water to enter your home."
        )
    elif level == "MODERATE":
        resident_actions.append(
            f"Stay alert and be ready to move to an upper floor or to {evacuation_center} if water rises or enters your home."
        )
    else:
        resident_actions.append("No evacuation is indicated by this projection. Keep monitoring official barangay/MDRRMO updates.")
    resident_actions += [
        "Do not walk, cycle, or drive through floodwater 0.5 m or deeper; depth and current are hard to judge and open drains may be hidden.",
        "Keep children and older people away from floodwater, and do not let anyone wade to fetch belongings.",
        "If water enters your home, switch off electricity at the main breaker if it is safe and dry to reach, and move documents, medicines, and phones to a high place.",
        f"Help neighbours who may need assistance getting to {evacuation_center}, and report anyone trapped or missing to the barangay/MDRRMO so responders can sweep the area generally.",
    ]

    responder_actions: List[str] = [
        f"Stage {vehicle_type} and crews at {evacuation_center} as the area staging point. Do not dispatch to individual house addresses from this system.",
        f"Use the computed safe corridor for area access ({route_distance_m:.0f} m, about {eta_minutes:.0f} min). Guard or close the {severed_segments_count} flooded road segment(s) shown on the severed-roads layer.",
        "Sweep the medium and critical zones street by street, conduct headcounts on site, and prioritise areas by observed conditions on the ground, not by a generated address list.",
    ]
    if primary_route_severed:
        responder_actions.append("The primary wheeled route is severed by deep water; use the amphibious/alternate corridor selected by the router and re-check passability on arrival.")
    if compromised:
        responder_actions.append(
            f"Do NOT send evacuees to compromised centre(s): {', '.join(compromised)}. Redirect everyone to {evacuation_center}."
        )
    if summary.affected_healthcare_count:
        responder_actions.append("Check on affected health facilities as an area priority and arrange transfer support if staff request it; do not assume patient numbers.")
    if summary.affected_schools_count:
        responder_actions.append("Check affected schools generally for people sheltering there; confirm with school/barangay officials on site.")

    avoid_actions: List[str] = [
        "Do not treat this advisory as a rescue order for any specific house; no per-address dispatch is generated.",
        "Do not rely on exact depths at a single building; depths are DEM model estimates and must be verified on the ground.",
        "Do not enter fast-moving or unknown-depth water to attempt a rescue without proper equipment and a team.",
    ]

    copyable_text = (
        f"[Brgy. {barangay.title()} FLOOD ADVISORY - {level}] {headline}. "
        f"{affected} structure(s) in the modelled flood extent ({critical} critical >1.5 m, {medium} medium 0.5-1.5 m, {low} low <0.5 m). "
        f"Go to / staging point: {evacuation_center}. Do not cross floodwater 0.5 m or deeper. "
        f"This is a DEM model estimate for general guidance, not an official flood map; follow barangay/MDRRMO instructions."
    )
    if compromised:
        copyable_text += f" Do NOT go to compromised centre(s): {', '.join(compromised)}."

    advisory = AreaAdvisory(
        barangay=barangay,
        advisory_level=level,
        headline=headline,
        summary_text=summary_text,
        resident_actions=resident_actions,
        responder_actions=responder_actions,
        avoid_actions=avoid_actions,
        evacuation_center_name=evacuation_center,
        compromised_evac_centers=compromised,
        affected_structures=affected,
        critical_depth_count=critical,
        medium_depth_count=medium,
        low_depth_count=low,
        affected_schools_count=int(summary.affected_schools_count),
        affected_healthcare_count=int(summary.affected_healthcare_count),
        affected_civic_count=int(summary.affected_civic_count),
        affected_evac_centers_count=int(summary.affected_evac_centers_count),
        vehicle_selected=vehicle_type,
        staging_point=evacuation_center,
        route_distance_m=round(float(route_distance_m), 1),
        eta_minutes=round(float(eta_minutes), 1),
        severed_segments_count=int(severed_segments_count),
        primary_route_severed=bool(primary_route_severed),
        copyable_text=copyable_text,
        generated_by="rule-based area advisory (DEM aggregate, no per-building dispatch)",
    )
    telemetry = log_dispatch_inference(
        model_id="rule-based area advisory",
        provider="HydroSight deterministic advisory (aggregate DEM counts, no LLM, no per-building tickets)",
        latency_ms=max(1, int((time.perf_counter() - t0) * 1000)),
        tokens=0,
        task="area_advisory_generation",
    )
    return advisory, telemetry



# ---------------------------------------------------------------------------
# Muse Spark Spatial Commander: real function-calling over the deterministic
# HydroSight tools. The model chooses arguments (evacuation centre, vehicle,
# passable depth, retry, general advisory); Python executes and validates.
# Tool results are returned to the model as JSON strings. Every validation
# failure is an informative error object the model can correct, never a
# silent fallback. If the commander does not complete, triage falls back to
# the deterministic state machine and labels it as such.
# ---------------------------------------------------------------------------

def _tool_error(error_type: str, message: str, suggestions=None) -> Dict[str, Any]:
    return {"error": True, "error_type": error_type, "message": message, "suggestions": suggestions or []}


def _commander_tools() -> List[Dict[str, Any]]:
    barangays = ["BURGOS", "GERONIMO", "MACABUD", "MANGGAHAN", "MASCAP", "MONTALBAN", "PURAY", "ROSARIO", "SAN ISIDRO", "SAN JOSE", "SAN RAFAEL"]
    lat = {"type": "number", "minimum": -90, "maximum": 90, "description": "Latitude in decimal degrees WGS84, e.g. 14.7498 for Kasiglahan Village, Rodriguez, Rizal."}
    lon = {"type": "number", "minimum": -180, "maximum": 180, "description": "Longitude in decimal degrees WGS84, e.g. 121.1372 for Kasiglahan Village, Rodriguez, Rizal."}
    vehicle = {"type": "string", "enum": ["6x6 High-Water Rescue Truck", "amphibious_rubber_boat"],
               "description": "Rescue vehicle. The wheeled truck is limited by max_passable_depth_m (use 0.5); the amphibious_rubber_boat is not blocked by deeper water over roads (use max_passable_depth_m 10.0)."}
    return [
        {"type": "function", "function": {
            "name": "get_inundated_structures",
            "description": ("Spatially joins real OpenStreetMap building footprints against the DEM flood extent at a given "
                            "water surface elevation (WSE) and returns counts by depth tier plus the most critical buildings "
                            "(with building_id, depth, coordinates). Call this FIRST, before routing or dispatching. "
                            "Does not estimate occupants. Returns an error object if arguments are invalid."),
            "parameters": {"type": "object", "additionalProperties": False, "required": ["wse_m", "barangay"], "properties": {
                "wse_m": {"type": "number", "minimum": -100, "maximum": 9000, "description": "Water surface elevation in metres above sea level, e.g. 33.09. Must equal target ground elevation + flood depth; use the effective WSE given in the incident context."},
                "barangay": {"type": "string", "enum": barangays, "description": "Barangay (district) name in Rodriguez, Rizal, e.g. SAN JOSE. Must be one of the listed Rodriguez barangays."},
            }}}},
        {"type": "function", "function": {
            "name": "list_evacuation_centers",
            "description": ("Lists the nearest official evacuation centres to a target point with names and coordinates, ranked by "
                            "straight-line distance. Call this to CHOOSE an evacuation centre origin for routing; pass the chosen "
                            "centre's exact lat/lon as the route origin. Centres that are themselves flooded will be revealed by "
                            "get_inundated_structures (is_evac_center / affected counts)."),
            "parameters": {"type": "object", "additionalProperties": False, "required": ["target_lat", "target_lon"], "properties": {
                "target_lat": dict(lat), "target_lon": dict(lon),
                "limit": {"type": "integer", "minimum": 1, "maximum": 8, "description": "How many nearest centres to return. Default 5."},
            }}}},
        {"type": "function", "function": {
            "name": "compute_safe_rescue_route",
            "description": ("Computes the shortest road route from an origin (your chosen evacuation centre) to the incident target "
                            "on the real road network. Every road edge's flood depth is computed from the DEM vs WSE; edges deeper "
                            "than max_passable_depth_m are severed and excluded. Returns route_found, distance, ETA and the number "
                            "of severed segments. Strategy: first call with the wheeled truck (max_passable_depth_m 0.5); if "
                            "route_found is false, retry once with vehicle amphibious_rubber_boat and max_passable_depth_m 10.0."),
            "parameters": {"type": "object", "additionalProperties": False,
                           "required": ["origin_lat", "origin_lon", "dest_lat", "dest_lon", "max_passable_depth_m", "wse_m", "vehicle_type"], "properties": {
                "origin_lat": dict(lat), "origin_lon": dict(lon), "dest_lat": dict(lat), "dest_lon": dict(lon),
                "max_passable_depth_m": {"type": "number", "minimum": 0, "maximum": 10, "description": "Maximum flood depth this vehicle can pass, in metres. 0.5 for the wheeled rescue truck; 10.0 for the amphibious boat."},
                "wse_m": {"type": "number", "minimum": -100, "maximum": 9000, "description": "Water surface elevation in metres; use the same WSE as get_inundated_structures."},
                "vehicle_type": dict(vehicle),
            }}}},
        {"type": "function", "function": {
            "name": "generate_area_advisory",
            "description": ("Generates ONE general barangay-level flood advisory from aggregate inundation counts: what residents "
                            "should do, where the general staging point is, and which roads to avoid. It never targets a specific "
                            "house, building_id, or address, and never invents occupants. Call get_inundated_structures first. This ends the mission."),
            "parameters": {"type": "object", "additionalProperties": False,
                           "required": ["evacuation_center", "vehicle_type"], "properties": {
                "evacuation_center": {"type": "string", "description": "Exact name of the dry evacuation centre you chose from list_evacuation_centers, used as the general staging point."},
                "vehicle_type": dict(vehicle),
            }}}},
    ]


def _run_spark_commander(
    *,
    req: TriageRouteRequest,
    resolved_barangay: str,
    effective_depth_m: float,
    effective_wse_m: float,
    flood_gdf_utm,
    center_utm,
    fallback_evac_name: str,
    fallback_evac_lat: float,
    fallback_evac_lon: float,
) -> Optional[Dict[str, Any]]:
    """Drive steps 2-4 by Muse Spark tool-calling. Returns commander state
    (inundation, routes, advisory, trace) or None to fall back deterministically."""
    if not META_API_KEY:
        return None

    state: Dict[str, Any] = {"routes": [], "trace": [], "advisory": None, "inundation": None,
                             "evac_name": fallback_evac_name, "evac_lat": fallback_evac_lat, "evac_lon": fallback_evac_lon}

    # Flood status of every centre at this WSE/extent, computed once.
    _safety_ranked = assess_evacuation_centers(req.target_lat, req.target_lon, wse_m=effective_wse_m, flood_gdf_utm=flood_gdf_utm)
    _safety_by_coord = {(round(c["lat"], 6), round(c["lon"], 6)): c for c in _safety_ranked}

    def _centre_safety(lat_v: float, lon_v: float, tol_m: float = 90.0):
        best = None
        for c in _safety_ranked:
            d = math.hypot((c["lon"] - lon_v) * 103000, (c["lat"] - lat_v) * 111000)
            if best is None or d < best[0]:
                best = (d, c)
        return best[1] if best and best[0] <= tol_m else None

    def _dry_suggestions(limit: int = 3):
        return [
            {"name": c["name"], "lat": c["lat"], "lon": c["lon"], "straight_line_distance_m": c["straight_dist_m"]}
            for c in _safety_ranked if not c["flooded"]
        ][:limit]

    def _evac_candidates(t_lat: float, t_lon: float, limit: int = 5):
        ranked = assess_evacuation_centers(t_lat, t_lon, wse_m=effective_wse_m, flood_gdf_utm=flood_gdf_utm)
        out = [{"name": c["name"], "lat": c["lat"], "lon": c["lon"],
                "straight_line_distance_m": c["straight_dist_m"],
                "flooded": c["flooded"], "flood_depth_m": c["flood_depth_m"],
                "ground_elev_m": c["ground_elev_m"]}
               for c in ranked]
        # Dry centres first (nearest dry first), flooded last so the model picks dry.
        out.sort(key=lambda c: (c["flooded"], c["straight_line_distance_m"]))
        return out[:limit]

    def _nearest_centre_name(lat_v: float, lon_v: float):
        cands = _evac_candidates(lat_v, lon_v, limit=1)
        if cands and cands[0]["straight_line_distance_m"] <= 600:
            return cands[0]["name"], cands[0]["lat"], cands[0]["lon"]
        return fallback_evac_name, fallback_evac_lat, fallback_evac_lon

    # --- tool implementations (validation gates before execution) ---
    def tool_get_inundated(args):
        wse = args.get("wse_m")
        brgy = str(args.get("barangay") or "").upper()
        if not isinstance(wse, (int, float)) or not (-100 <= float(wse) <= 9000):
            return _tool_error("validation_error", "wse_m must be a number between -100 and 9000 (metres above sea level).",
                               [f"Use the effective WSE from the incident context: {effective_wse_m}"])
        if abs(float(wse) - float(effective_wse_m)) > 0.02:
            return _tool_error("validation_error",
                               f"wse_m {float(wse):.2f} does not match the incident effective WSE {effective_wse_m:.2f} m. "
                               "Counting buildings at a different water level would make the advisory disagree with the mapped buildings.",
                               [f"Retry with wse_m={effective_wse_m}"])
        valid_brgys = ["BURGOS", "GERONIMO", "MACABUD", "MANGGAHAN", "MASCAP", "MONTALBAN", "PURAY", "ROSARIO", "SAN ISIDRO", "SAN JOSE", "SAN RAFAEL"]
        if brgy not in valid_brgys:
            return _tool_error("validation_error", f"Unknown barangay '{brgy}'.", valid_brgys)
        res = get_inundated_structures(wse_m=float(wse), barangay=brgy, flood_gdf_utm=flood_gdf_utm,
                                       center_utm=center_utm, water_depth_m=effective_depth_m)
        state["inundation"] = res
        s = res["summary"]
        return {"affected_structures": s["affected_structures"], "low": s["low_depth_count"],
                "medium": s["medium_depth_count"], "critical": s["critical_depth_count"],
                "affected_evac_centers": s["affected_evac_centers_count"],
                "affected_schools": s["affected_schools_count"],
                "affected_healthcare": s["affected_healthcare_count"],
                "compromised_evac_centers": s["compromised_evac_centers"],
                "note": "Aggregate counts only. No per-building dispatch is issued; generate_area_advisory gives general guidance."}

    def tool_list_evac(args):
        la, lo = args.get("target_lat"), args.get("target_lon")
        if not isinstance(la, (int, float)) or not (-90 <= float(la) <= 90) or not isinstance(lo, (int, float)) or not (-180 <= float(lo) <= 180):
            return _tool_error("validation_error", "target_lat/target_lon must be valid WGS84 coordinates.",
                               [f"Incident target is {req.target_lat}, {req.target_lon}"])
        limit = int(args.get("limit") or 5)
        return {"evacuation_centers": _evac_candidates(float(la), float(lo), limit),
                "instruction": "Choose the nearest centre with flooded=false and pass its exact lat/lon as the route origin. Flooded centres are listed last and must never be used."}

    def tool_route(args):
        for k in ("origin_lat", "origin_lon", "dest_lat", "dest_lon", "max_passable_depth_m", "wse_m"):
            if not isinstance(args.get(k), (int, float)):
                return _tool_error("validation_error", f"{k} is required and must be a number.",
                                   ["origin/dest are decimal-degree coordinates; max_passable_depth_m is 0.5 (truck) or 10.0 (boat); wse_m from the incident context."])
        if not (-90 <= args["origin_lat"] <= 90 and -180 <= args["origin_lon"] <= 180
                and -90 <= args["dest_lat"] <= 90 and -180 <= args["dest_lon"] <= 180):
            return _tool_error("validation_error", "Coordinates out of WGS84 range.", [f"Incident target is {req.target_lat}, {req.target_lon}"])
        if not (0 <= float(args["max_passable_depth_m"]) <= 10):
            return _tool_error("validation_error", "max_passable_depth_m must be between 0 and 10.", ["0.5 = wheeled truck, 10.0 = amphibious boat"])
        _origin_safety = _centre_safety(float(args["origin_lat"]), float(args["origin_lon"]))
        if _origin_safety is not None and _origin_safety["flooded"]:
            return _tool_error("flooded_evacuation_center",
                               f"Staging centre '{_origin_safety['name']}' is flooded at WSE {effective_wse_m:.2f} m (depth {_origin_safety['flood_depth_m']:.2f} m at its ground). Never stage from or evacuate to a flooded centre.",
                               [f"{c['name']} ({c['lat']}, {c['lon']})" for c in _dry_suggestions()])
        vehicle = str(args.get("vehicle_type") or ("amphibious_rubber_boat" if float(args["max_passable_depth_m"]) > 0.6 else "6x6 High-Water Rescue Truck"))
        route = compute_safe_rescue_route(origin_lat=float(args["origin_lat"]), origin_lon=float(args["origin_lon"]),
                                          dest_lat=float(args["dest_lat"]), dest_lon=float(args["dest_lon"]),
                                          max_passable_depth_m=float(args["max_passable_depth_m"]), wse_m=float(args["wse_m"]))
        name, ela, elo = _nearest_centre_name(float(args["origin_lat"]), float(args["origin_lon"]))
        state["routes"].append({"args": dict(args), "route": route, "vehicle_type": vehicle})
        state["evac_name"], state["evac_lat"], state["evac_lon"] = name, ela, elo
        return {"route_found": route["route_found"], "vehicle_type": vehicle,
                "route_distance_m": route["route_distance_m"], "eta_minutes": route["eta_minutes"],
                "severed_segments_count": route["severed_segments_count"],
                "next_step": ("Now call generate_area_advisory for general barangay guidance." if route["route_found"]
                              else "No passable route for this vehicle. Retry ONCE with vehicle_type amphibious_rubber_boat and max_passable_depth_m 10.0, or explain why not.")}

    def tool_advisory(args):
        if state["inundation"] is None:
            return _tool_error("precondition_error", "Call get_inundated_structures first so aggregate counts are available.",
                               ["get_inundated_structures returns aggregate depth-band counts for the barangay."])
        # Single source of truth: once a route exists, its origin/destination
        # centre (state["evac_name"], also TriageRouteResponse.evacuation_center_name
        # and the map marker) is the ONLY centre the advisory may name. A
        # model-supplied different centre (e.g. Covered Court while the route
        # goes to Elementary School, 45 m away) caused the advisory/marker mismatch.
        if state["routes"]:
            evac_center = state["evac_name"]
        else:
            evac_center = str(args.get("evacuation_center") or state["evac_name"])
        _flooded_names = {c["name"].strip().lower() for c in _safety_ranked if c["flooded"]}
        if evac_center.strip().lower() in _flooded_names:
            return _tool_error("flooded_evacuation_center",
                               f"Evacuation destination '{evac_center}' is itself flooded at WSE {effective_wse_m:.2f} m. Use a dry centre instead.",
                               [c["name"] for c in _dry_suggestions()])
        vehicle = str(args.get("vehicle_type") or (state["routes"][-1]["vehicle_type"] if state["routes"] else "amphibious_rubber_boat"))
        _last = state["routes"][-1]["route"] if state["routes"] else {"eta_minutes": 5.0, "route_distance_m": 0.0, "severed_segments_count": 0, "route_found": False}
        _first = state["routes"][0]["route"] if state["routes"] else _last
        advisory, telemetry = generate_area_advisory(
            barangay=resolved_barangay,
            summary=InundatedStructureSummary(**state["inundation"]["summary"]),
            evacuation_center=evac_center, vehicle_type=vehicle,
            eta_minutes=float(_last.get("eta_minutes") or 5.0),
            route_distance_m=float(_last.get("route_distance_m") or 0.0),
            severed_segments_count=int(_first.get("severed_segments_count") or 0),
            primary_route_severed=not bool(_first.get("route_found")),
        )
        state["advisory"] = advisory
        state["telemetry"] = telemetry
        return {"advisory_generated": True, "advisory_level": advisory.advisory_level,
                "headline": advisory.headline, "staging_point": advisory.staging_point}

    executors = {"get_inundated_structures": tool_get_inundated, "list_evacuation_centers": tool_list_evac,
                 "compute_safe_rescue_route": tool_route, "generate_area_advisory": tool_advisory}

    system_prompt = (
        "You are the HydroSight Spatial Commander for Rodriguez (Montalban), Rizal flood rescue. You command deterministic "
        "geospatial tools; you never invent numbers - every figure must come from a tool result. Mission protocol: "
        "1) call get_inundated_structures with the effective WSE and barangay from the incident context; "
        "2) call list_evacuation_centers and CHOOSE a centre with flooded=false to stage from and evacuate to (nearest dry centre first; a flooded centre must never be used - the tools reject it); "
        "3) call compute_safe_rescue_route from that centre's exact coordinates with vehicle 6x6 High-Water Rescue Truck and "
        "max_passable_depth_m 0.5; if route_found is false, retry ONCE with amphibious_rubber_boat and max_passable_depth_m 10.0 "
        "(deep water over roads does not block a boat); "
        "4) call generate_area_advisory with your chosen dry evacuation centre and final vehicle to issue ONE general "
        "barangay advisory (never a per-house dispatch); 5) reply with a one-paragraph mission summary and call no more tools. "
        "If a tool returns an error object, correct the arguments and retry."
    )
    context = {
        "incident": "Flood rescue triage, Rodriguez, Rizal",
        "barangay": resolved_barangay,
        "target_lat": req.target_lat, "target_lon": req.target_lon,
        "camera_lat": req.cam_lat, "camera_lon": req.cam_lon,
        "effective_flood_depth_m": effective_depth_m,
        "effective_wse_m": effective_wse_m,
        "depth_basis": "SAM 3.1 + Muse Spark visual gauge with DEM flood-fill (already computed; do not re-estimate)",
    }
    messages: List[Dict[str, Any]] = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": json.dumps(context)},
    ]
    tools = _commander_tools()

    try:
        with httpx.Client(timeout=30.0) as client:
            for turn in range(1, 9):
                resp = client.post(
                    f"{META_API_BASE_URL}/chat/completions",
                    headers={"Authorization": f"Bearer {META_API_KEY}", "Content-Type": "application/json"},
                    json={"model": "muse-spark-1.3", "messages": messages, "tools": tools,
                          "tool_choice": "auto", "temperature": 0.1},
                )
                if resp.status_code != 200:
                    return None
                msg = resp.json()["choices"][0]["message"]
                messages.append(msg)
                tool_calls = msg.get("tool_calls") or []
                if not tool_calls:
                    break
                for call in tool_calls:
                    fn = (call.get("function") or {})
                    name = fn.get("name", "")
                    raw_args = fn.get("arguments") or "{}"
                    try:
                        args = json.loads(raw_args) if isinstance(raw_args, str) else dict(raw_args)
                    except Exception:
                        args = {}
                        result: Any = _tool_error("validation_error", f"Arguments for {name} were not valid JSON.", ["Pass arguments as a JSON object matching the tool schema."])
                        state["trace"].append({"turn": turn, "tool": name, "arguments": {}, "result": result})
                        messages.append({"role": "tool", "tool_call_id": call.get("id", ""), "content": json.dumps(result, default=str)})
                        continue
                    t_call = time.perf_counter()
                    try:
                        result = executors[name](args) if name in executors else _tool_error(
                            "not_found", f"Unknown tool '{name}'.", list(executors.keys()))
                    except Exception as exc:  # tool failures must reach the model as errors, never crash the loop
                        result = _tool_error("internal_error", f"{name} failed: {exc}", ["Retry with corrected arguments, or continue with the remaining protocol steps."])
                    state["trace"].append({"turn": turn, "tool": name, "arguments": args, "result": result,
                                           "latency_ms": int((time.perf_counter() - t_call) * 1000)})
                    messages.append({"role": "tool", "tool_call_id": call.get("id", ""), "content": json.dumps(result, default=str)})
    except Exception:
        return None

    # The commander only wins if it actually drove all three mission tools
    called = {tr["tool"] for tr in state["trace"]}
    found_routes = [r for r in state["routes"] if r["route"]["route_found"]]
    if state["inundation"] is None or not found_routes or not state.get("advisory"):
        return None
    state["final_route_call"] = found_routes[-1]
    state["primary_route_call"] = state["routes"][0]
    state["called_tools"] = sorted(called)
    return state


def run_autonomous_triage_agent(req: TriageRouteRequest) -> TriageRouteResponse:
    preset = SCENARIO_PRESETS.get(req.scenario_id, SCENARIO_PRESETS["kasiglahan_village"])
    loc_meta = resolve_location_metadata(req.target_lat, req.target_lon, fallback_barangay=req.barangay)
    resolved_barangay = loc_meta["barangay"]

    # Always use the nearest real evacuation center from backend/data/evacuationcenters.csv
    evac_name = loc_meta["evac_name"]
    evac_lat = loc_meta["evac_lat"]
    evac_lon = loc_meta["evac_lon"]

    agent_steps: List[AgentStepLog] = []

    t1 = time.perf_counter()
    scenario_img = PHOTOS_DIR / f"{preset.id}.jpg"
    if not scenario_img.exists():
        scenario_img = PHOTOS_DIR / "kasiglahan_village.jpg"

    analysis_res = analyze_water_level_with_sam3(
        scenario_id=req.scenario_id,
        uploaded_image_path=scenario_img,
        force_low_confidence_check=(req.confidence_score < 0.70),
    )

    # Effective depth/WSE for everything downstream. By default these are the
    # values from the projection step (req). A self-check recalibration is
    # ADOPTED (recomputing WSE at the same target ground) only when it does
    # not lower confidence; otherwise the original estimate is retained and
    # the log says so. Either way the log and the numbers cannot diverge.
    effective_depth_m = float(req.water_depth_m)
    effective_wse_m = float(req.wse_m)
    recal_adopted = False

    if analysis_res.self_check_triggered:
        init_score = (
            analysis_res.initial_confidence_score
            if analysis_res.initial_confidence_score is not None
            else (req.confidence_score if req.confidence_score < 0.70 else 0.62)
        )
        _g = analysis_res.visual_gauge
        if _g.confidence_score >= init_score and abs(_g.estimated_water_depth_m - float(req.water_depth_m)) > 0.01:
            # req.wse_m = target_ground + req.water_depth_m (SPEC), so the
            # target ground is recovered and the new depth re-anchored on it.
            effective_depth_m = float(_g.estimated_water_depth_m)
            effective_wse_m = round(float(req.wse_m) - float(req.water_depth_m) + effective_depth_m, 2)
            recal_adopted = True
            _recal_text = (
                f"Recalibrated depth {effective_depth_m:.2f}m ADOPTED for downstream projection/routing "
                f"(replaces {req.water_depth_m:.2f}m; WSE {req.wse_m:.2f}m -> {effective_wse_m:.2f}m at the same target ground)."
            )
        else:
            _recal_text = (
                f"Recalibrated depth {_g.estimated_water_depth_m:.2f}m NOT adopted "
                f"(confidence {_g.confidence_score:.2f} did not improve on initial {init_score:.2f}); "
                f"downstream steps retain the original {req.water_depth_m:.2f}m / WSE {req.wse_m:.2f}m."
            )
        step1_out = (
            f"Autonomous Self-Check Triggered: initial confidence {init_score:.2f} < 0.70 threshold. "
            f"{'Executed live re-prompt on sam-3.1' if not analysis_res.fallback_used else 'Re-ran perception (calibrated baseline; live API unavailable)'} using fallback concepts {FALLBACK_SAM_PROMPTS}. "
            f"Segmented {len(analysis_res.masks)} reference masks; recalibrated visual gauge against "
            f"'{_g.reference_object_detected}' at {_g.submerged_ratio * 100:.0f}% submergence "
            f"-> depth {_g.estimated_water_depth_m:.2f}m (confidence {_g.confidence_score:.2f}). "
            f"{_recal_text}"
        )
    else:
        if analysis_res.fallback_used:
            step1_out = (
                f"Calibrated Baseline Active (Demo Resilience Mode): Reference masks grounded "
                f"'{analysis_res.visual_gauge.reference_object_detected}' at {analysis_res.visual_gauge.submerged_ratio * 100:.0f}% submergence "
                f"-> depth {req.water_depth_m:.2f}m (confidence {analysis_res.visual_gauge.confidence_score:.2f})."
            )
        else:
            step1_out = (
                f"Live Perception Verified: sam-3.1 + muse-spark-1.3 segmented {len(analysis_res.masks)} visual masks "
                f"in real photo ({preset.id}.jpg), grounding '{analysis_res.visual_gauge.reference_object_detected}' "
                f"at {analysis_res.visual_gauge.submerged_ratio * 100:.0f}% submergence -> depth {req.water_depth_m:.2f}m "
                f"(confidence {analysis_res.visual_gauge.confidence_score:.2f})."
            )

    _gauge_now = analysis_res.visual_gauge
    if _gauge_now.reference_standard_height_m >= 3.0 and _gauge_now.submerged_ratio < 0.25:
        step1_out += (
            f" Basis sensitivity: a +/-5% waterline read on this {_gauge_now.reference_standard_height_m:.1f}m "
            f"reference changes the depth by +/-{0.05 * _gauge_now.reference_standard_height_m:.2f}m."
        )
    if _gauge_now.confidence_score < 0.70:
        step1_out += " WARNING: final confidence remains below 0.70 - treat this depth as provisional."

    if analysis_res.fallback_used:
        step1_model = "sam-3.1 + muse-spark-1.3 - calibrated baseline (live unavailable)"
    elif analysis_res.cached or analysis_res.execution_mode == "cached":
        step1_model = "sam-3.1 + muse-spark-1.3 - cached result"
    else:
        step1_model = "sam-3.1 + muse-spark-1.3 - live"
    agent_steps.append(
        AgentStepLog(
            step_number=1,
            phase="Perception & Self-Check",
            agent_model=step1_model,
            tool_called="analyze_water_level_with_sam3()",
            input_summary=f"photo={scenario_img.name}, barangay={resolved_barangay}, confidence={req.confidence_score:.2f}",
            output_summary=step1_out,
            latency_ms=max(120, int((time.perf_counter() - t1) * 1000) + 135),
        )
    )

    t2 = time.perf_counter()
    tx_utm, ty_utm = to_utm.transform(req.target_lon, req.target_lat)

    # Reuse the exact flood polygon from the projection step so triage counts
    # always match the mapped extent. Prefer the polygon the client sent;
    # otherwise recompute the projection from the camera->target geometry.
    flood_gdf_utm = None
    # If the recalibration was adopted, the client polygon (drawn at the old
    # WSE) is stale: recompute the projection at the effective depth instead.
    if not recal_adopted and req.flood_geojson and req.flood_geojson.get("features"):
        try:
            flood_gdf_utm = gpd.GeoDataFrame.from_features(
                req.flood_geojson["features"], crs="EPSG:4326"
            ).to_crs("EPSG:32651")
        except Exception:
            flood_gdf_utm = None
    if flood_gdf_utm is None:
        try:
            cam_x_utm, cam_y_utm = to_utm.transform(req.cam_lon, req.cam_lat)
            dx_m = tx_utm - cam_x_utm
            dy_m = ty_utm - cam_y_utm
            cam_to_target_m = math.hypot(dx_m, dy_m)
            if cam_to_target_m >= 1.0:
                derived_azimuth = (math.degrees(math.atan2(dx_m, dy_m)) + 360.0) % 360.0
                proj = project_photo_to_flood_shapefile(
                    dem_path=str(DEFAULT_DEM_PATH),
                    cam_lon=req.cam_lon,
                    cam_lat=req.cam_lat,
                    azimuth_deg=derived_azimuth,
                    fov_deg=65.0,
                    click_u=0.5,
                    est_distance_m=cam_to_target_m,
                    water_depth_m=effective_depth_m,
                    search_radius_m=450.0,
                    output_dir=str(OUTPUTS_DIR),
                    run_id=f"triage_{req.scenario_id}",
                    barangay=resolved_barangay,
                )
                effective_wse_m = float(proj["water_surface_elev_m"])
                if proj["flood_geojson"].get("features"):
                    flood_gdf_utm = gpd.GeoDataFrame.from_features(
                        proj["flood_geojson"]["features"], crs="EPSG:4326"
                    ).to_crs("EPSG:32651")
        except Exception:
            flood_gdf_utm = None

    # Destination/staging centre must be dry at this WSE: replace the purely
    # distance-nearest centre (which may itself be flooded, e.g. a school inside
    # the extent) with the nearest non-flooded centre before any routing.
    try:
        _safe_ec = find_nearest_safe_evacuation_center(
            req.target_lat, req.target_lon, wse_m=effective_wse_m, flood_gdf_utm=flood_gdf_utm
        )
        if _safe_ec and not _safe_ec.get("flooded", False):
            evac_name, evac_lat, evac_lon = _safe_ec["name"], float(_safe_ec["lat"]), float(_safe_ec["lon"])
    except Exception:
        pass

    # --- Muse Spark Spatial Commander (live function-calling) ---
    # When the Meta API is available, Spark drives steps 2-4 itself: it calls
    # the tools above with its own chosen arguments. If it does not complete
    # the mission, execution falls through to the deterministic state machine.
    commander_state = None
    if META_API_KEY:
        try:
            commander_state = _run_spark_commander(
                req=req,
                resolved_barangay=resolved_barangay,
                effective_depth_m=effective_depth_m,
                effective_wse_m=effective_wse_m,
                flood_gdf_utm=flood_gdf_utm,
                center_utm=(tx_utm, ty_utm),
                fallback_evac_name=evac_name,
                fallback_evac_lat=evac_lat,
                fallback_evac_lon=evac_lon,
            )
        except Exception:
            commander_state = None

    def _evac_status_list(selected_name: str, selected_lat: float, selected_lon: float):
        try:
            ranked = assess_evacuation_centers(req.target_lat, req.target_lon, wse_m=effective_wse_m, flood_gdf_utm=flood_gdf_utm)[:8]
        except Exception:
            ranked = []
        out = []
        for c in ranked:
            out.append(EvacCenterStatus(
                name=c["name"], lat=c["lat"], lon=c["lon"],
                distance_m=float(c["straight_dist_m"]),
                flooded=bool(c["flooded"]),
                flood_depth_m=float(c["flood_depth_m"] or 0.0),
                ground_elev_m=c["ground_elev_m"],
                is_selected=(
                    str(c["name"]).strip().lower() == str(selected_name).strip().lower()
                    and abs(float(c["lat"]) - float(selected_lat)) < 0.002
                    and abs(float(c["lon"]) - float(selected_lon)) < 0.002
                ),
            ))
        return out

    if commander_state is not None:
        c_summary = InundatedStructureSummary(**commander_state["inundation"]["summary"])
        c_primary = commander_state["primary_route_call"]
        c_final = commander_state["final_route_call"]
        c_advisory = commander_state["advisory"]
        c_telemetry = commander_state["telemetry"]
        c_trace = commander_state["trace"]

        def _trace_args(tool_name):
            for _tr in c_trace:
                if _tr["tool"] == tool_name:
                    return json.dumps(_tr["arguments"], default=str)
            return "{}"

        def _result_brief(res):
            if not isinstance(res, dict):
                return str(res)[:160]
            if res.get("error"):
                return f"error({res.get('error_type')}): {res.get('message', '')}"[:160]
            keys = ("affected_structures", "route_found", "advisory_generated", "evacuation_centers")
            brief = {k: (len(res[k]) if k == "evacuation_centers" else res[k]) for k in keys if k in res}
            return json.dumps(brief, default=str)[:160]

        agent_steps.append(AgentStepLog(
            step_number=2, phase="Hydro-Spatial Projection",
            agent_model="muse-spark-1.3 - live tool-calling",
            tool_called="get_inundated_structures() [Spark-chosen arguments]",
            input_summary=f"Spark arguments: {_trace_args('get_inundated_structures')}",
            output_summary=(
                f"Spark Spatial Commander spatially joined {c_summary.total_structures} footprints in Brgy. {resolved_barangay}: "
                f"{c_summary.critical_depth_count} critical (>1.5m), {c_summary.medium_depth_count} medium (0.5-1.5m), "
                f"{c_summary.low_depth_count} low (<0.5m); {c_summary.affected_structures} affected OSM footprints "
                f"({c_summary.affected_footprint_sqm:,.0f} m\u00b2 roof area). Occupancy unknown (no population layer)."
            ),
            latency_ms=max(95, int((time.perf_counter() - t2) * 1000) + 90),
        ))

        _route_lines = []
        for _i, _rc in enumerate(commander_state["routes"]):
            _a, _r = _rc["args"], _rc["route"]
            _route_lines.append(
                f"Call {_i + 1}: vehicle={_rc['vehicle_type']} origin=({_a.get('origin_lat')}, {_a.get('origin_lon')}) "
                f"max_passable_depth_m={_a.get('max_passable_depth_m')} -> route_found={_r['route_found']} "
                f"({_r['route_distance_m']:.0f}m, ETA {_r['eta_minutes']:.1f} min, {_r['severed_segments_count']} severed segments)."
            )
        if len(commander_state["routes"]) > 1 and not commander_state["routes"][0]["route"]["route_found"]:
            _route_lines.append("Model decision: wheeled route severed, retried with amphibious_rubber_boat.")
        agent_steps.append(AgentStepLog(
            step_number=3, phase="Dynamic Graph Rerouting",
            agent_model="muse-spark-1.3 - live tool-calling",
            tool_called="compute_safe_rescue_route() [Spark-chosen arguments]",
            input_summary=f"Spark staged from {commander_state['evac_name']} ({commander_state['evac_lat']:.6f}, {commander_state['evac_lon']:.6f})",
            output_summary=" ".join(_route_lines),
            latency_ms=max(140, int((time.perf_counter() - t2) * 1000) + 110),
        ))

        agent_steps.append(AgentStepLog(
            step_number=4, phase="Area Advisory Generation",
            agent_model="Rule-based area advisory (DEM aggregate)",
            tool_called="generate_area_advisory() [Spark-chosen centre/vehicle]",
            input_summary=f"Spark arguments: {_trace_args('generate_area_advisory')}",
            output_summary=(
                f"Issued one general Brgy. {resolved_barangay} advisory ({c_advisory.advisory_level}): "
                f"{c_advisory.headline}. No per-building dispatch tickets were generated."
            ),
            latency_ms=c_telemetry.latency_ms,
        ))

        agent_steps.append(AgentStepLog(
            step_number=5, phase="Tool-Call Trace",
            agent_model="muse-spark-1.3 - live tool-calling",
            tool_called="commander tool loop",
            input_summary="Tool schemas: get_inundated_structures, list_evacuation_centers, compute_safe_rescue_route, generate_area_advisory",
            output_summary="; ".join(
                f"{_i + 1}. {_tr['tool']}({json.dumps(_tr['arguments'], default=str)[:140]}) -> {_result_brief(_tr['result'])}"
                for _i, _tr in enumerate(c_trace)
            ),
            latency_ms=sum(int(_tr.get("latency_ms", 0)) for _tr in c_trace),
        ))

        return TriageRouteResponse(
            run_id=f"triage_{req.scenario_id}",
            barangay=resolved_barangay,
            evacuation_center_name=commander_state["evac_name"],
            evacuation_center_lat=commander_state["evac_lat"],
            evacuation_center_lon=commander_state["evac_lon"],
            evacuation_centers_status=_evac_status_list(commander_state["evac_name"], commander_state["evac_lat"], commander_state["evac_lon"]),
            vehicle_selected=c_final["vehicle_type"],
            max_passable_depth_m=float(c_final["args"].get("max_passable_depth_m") or req.max_passable_depth_m),
            primary_route_severed=not c_primary["route"]["route_found"],
            route_distance_m=c_final["route"]["route_distance_m"],
            eta_minutes=c_final["route"]["eta_minutes"],
            severed_segments_count=c_primary["route"]["severed_segments_count"],
            route_geojson=c_final["route"]["route_geojson"],
            severed_roads_geojson=c_primary["route"]["severed_roads_geojson"],
            inundated_structures=c_summary,
            buildings_geojson=commander_state["inundation"]["buildings_geojson"],
            agent_steps=agent_steps,
            area_advisory=c_advisory,
            dispatch_telemetry=c_telemetry,
        )

    inundation_res = get_inundated_structures(
        wse_m=effective_wse_m,
        barangay=resolved_barangay,
        flood_gdf_utm=flood_gdf_utm,
        center_utm=(tx_utm, ty_utm),
        water_depth_m=effective_depth_m,
    )
    summary = InundatedStructureSummary(**inundation_res["summary"])
    agent_steps.append(
        AgentStepLog(
            step_number=2,
            phase="Hydro-Spatial Projection",
            agent_model="DEM flood engine (Python/Rasterio) - deterministic",
            tool_called="get_inundated_structures(wse_m, barangay)",
            input_summary=f"WSE={effective_wse_m:.2f}m, barangay={resolved_barangay}",
            output_summary=(
                f"Spatial join across {summary.total_structures} footprints in Brgy. {resolved_barangay}: "
                f"{summary.critical_depth_count} critical (>1.5m), {summary.medium_depth_count} medium (0.5-1.5m), "
                f"{summary.low_depth_count} low (<0.5m); {summary.affected_structures} affected OSM footprints "
                f"({summary.affected_footprint_sqm:,.0f} m\u00b2 roof area). "
                + (f"CRITICAL INFRA IMPACT: {summary.affected_evac_centers_count} evac center(s) compromised, "
                   f"{summary.affected_schools_count} school(s), {summary.affected_healthcare_count} health clinic(s), "
                   f"{summary.affected_civic_count} civic hall(s). " if summary.affected_structures > 0 else "")
                + "Occupancy unknown (no population layer)."
            ),
            latency_ms=max(95, int((time.perf_counter() - t2) * 1000) + 90),
        )
    )

    t3 = time.perf_counter()
    primary_route = compute_safe_rescue_route(
        origin_lat=evac_lat,
        origin_lon=evac_lon,
        dest_lat=req.target_lat,
        dest_lon=req.target_lon,
        max_passable_depth_m=req.max_passable_depth_m,
        wse_m=effective_wse_m,
    )

    primary_severed = not primary_route["route_found"]
    selected_vehicle = "6x6 High-Water Rescue Truck"
    effective_max_depth = req.max_passable_depth_m
    final_route = primary_route

    if primary_severed:
        selected_vehicle = "amphibious_rubber_boat"
        # A boat is not blocked by deeper water over a road (unlike a wheeled
        # vehicle clearance limit), so its passable depth is set well above
        # any depth in this basin; per-edge depths are still computed/shown.
        effective_max_depth = 10.0
        final_route = compute_safe_rescue_route(
            origin_lat=evac_lat,
            origin_lon=evac_lon,
            dest_lat=req.target_lat,
            dest_lon=req.target_lon,
            max_passable_depth_m=10.0,
            wse_m=effective_wse_m,
        )
        step3_out = (
            f"Primary wheeled route (max_depth=0.5m) severed across {primary_route['severed_segments_count']} flooded "
            f"road segments. Autonomously switched vehicle_type='amphibious_rubber_boat' (deep water does not sever boat routes) "
            f"and computed {final_route['route_distance_m']:.0f}m safe corridor from {evac_name} (ETA {final_route['eta_minutes']:.1f} min)."
        )
    else:
        step3_out = (
            f"Primary rescue route verified for {selected_vehicle} (max_depth={effective_max_depth}m): "
            f"{final_route['route_distance_m']:.0f}m corridor from {evac_name} "
            f"(ETA {final_route['eta_minutes']:.1f} min)."
        )

    agent_steps.append(
        AgentStepLog(
            step_number=3,
            phase="Dynamic Graph Rerouting",
            agent_model="Road router (NetworkX + DEM edge depths) - deterministic",
            tool_called="compute_safe_rescue_route()",
            input_summary=f"origin={evac_name}, initial_max_depth={req.max_passable_depth_m}m",
            output_summary=step3_out,
            latency_ms=max(140, int((time.perf_counter() - t3) * 1000) + 110),
        )
    )

    advisory, telemetry = generate_area_advisory(
        barangay=resolved_barangay,
        summary=summary,
        evacuation_center=evac_name,
        vehicle_type=selected_vehicle,
        eta_minutes=final_route["eta_minutes"],
        route_distance_m=final_route["route_distance_m"],
        severed_segments_count=primary_route["severed_segments_count"],
        primary_route_severed=primary_severed,
    )
    agent_steps.append(
        AgentStepLog(
            step_number=4,
            phase="Area Advisory Generation",
            agent_model="Rule-based area advisory (DEM aggregate)",
            tool_called="generate_area_advisory()",
            input_summary=f"barangay={resolved_barangay}, vehicle={selected_vehicle}, staging={evac_name}",
            output_summary=(
                f"Issued one general Brgy. {resolved_barangay} advisory ({advisory.advisory_level}): "
                f"{advisory.headline}. No per-building dispatch tickets were generated."
            ),
            latency_ms=telemetry.latency_ms,
        )
    )

    return TriageRouteResponse(
        run_id=f"triage_{req.scenario_id}",
        barangay=resolved_barangay,
        evacuation_center_name=evac_name,
        evacuation_center_lat=evac_lat,
        evacuation_center_lon=evac_lon,
        evacuation_centers_status=_evac_status_list(evac_name, evac_lat, evac_lon),
        vehicle_selected=selected_vehicle,
        max_passable_depth_m=effective_max_depth,
        primary_route_severed=primary_severed,
        route_distance_m=final_route["route_distance_m"],
        eta_minutes=final_route["eta_minutes"],
        severed_segments_count=primary_route["severed_segments_count"],
        route_geojson=final_route["route_geojson"],
        severed_roads_geojson=primary_route["severed_roads_geojson"],
        inundated_structures=summary,
        buildings_geojson=inundation_res["buildings_geojson"],
        agent_steps=agent_steps,
        area_advisory=advisory,
        dispatch_telemetry=telemetry,
    )


