from dotenv import load_dotenv

load_dotenv()

import base64
import io
import json
import uuid
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image

from backend.geo_engine import (
    DEFAULT_DEM_PATH,
    OUTPUTS_DIR,
    ensure_dem_exists,
    ensure_spatial_assets,
    get_barangay_boundaries_geojson,
    get_evacuation_centers_geojson,
    project_photo_to_flood_shapefile,
    resolve_location_metadata,
)
from backend.meta_agents import (
    PHOTOS_DIR,
    VERIFICATION_LOG_PATH,
    analyze_water_level_with_sam3,
    ensure_sample_photos,
    get_scenarios,
    run_autonomous_triage_agent,
    simulate_typhoon_surge_with_muse_image,
)
from backend.schemas import (
    AnalyzePhotoResponse,
    DeletePhotoRequest,
    ProjectFloodRequest,
    ProjectFloodResponse,
    ScenarioPreset,
    SurgeSimulationRequest,
    SurgeSimulationResponse,
    TriageRouteRequest,
    TriageRouteResponse,
)

app = FastAPI(
    title="HydroSight AI — 3D Hydro-Spatial Flood Triage API",
    description="Crowdsourced Street-Level Vision to 3D DEM Flood Extent Shapefiles & Autonomous Rescue Triage for Rodriguez (Montalban), Rizal",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize DEM, spatial assets, and sample street photos on import
ensure_dem_exists()
ensure_spatial_assets()
ensure_sample_photos()
OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)

app.mount("/static/photos", StaticFiles(directory=str(PHOTOS_DIR)), name="photos")


def _save_normalized_upload(raw_bytes: bytes) -> Path:
    """Convert any uploaded image bytes into a normalized RGB JPEG inside PHOTOS_DIR."""
    PHOTOS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = PHOTOS_DIR / f"upload_{uuid.uuid4().hex[:10]}.jpg"
    try:
        with Image.open(io.BytesIO(raw_bytes)) as im:
            rgb = im.convert("RGB")
            rgb.thumbnail((1280, 1280))
            rgb.save(out_path, "JPEG", quality=90)
    except Exception:
        out_path.write_bytes(raw_bytes)
    return out_path


@app.get("/api/v1/health")
def health_check() -> dict:
    return {
        "status": "ok",
        "service": "HydroSight AI Backend",
        "crs_projected": "EPSG:32651",
        "crs_web": "EPSG:4326",
        "dem_loaded": DEFAULT_DEM_PATH.exists(),
    }


@app.get("/api/v1/scenarios", response_model=List[ScenarioPreset])
def list_scenarios() -> List[ScenarioPreset]:
    return get_scenarios()


@app.get("/api/v1/boundary")
def get_boundary() -> dict:
    return get_barangay_boundaries_geojson()


@app.get("/api/v1/evacuation-centers")
def get_evacuation_centers() -> dict:
    return get_evacuation_centers_geojson()


@app.post("/api/v1/analyze-photo", response_model=AnalyzePhotoResponse)
async def analyze_photo(
    request: Request,
    scenario_id: Optional[str] = Form(None),
    file: Optional[UploadFile] = File(None),
) -> AnalyzePhotoResponse:
    resolved_scenario = scenario_id or "kasiglahan_village"
    uploaded_path: Optional[Path] = None
    force_low_conf = False

    content_type = request.headers.get("content-type", "")
    if "application/json" in content_type:
        body = await request.json()
        resolved_scenario = body.get("scenario_id", resolved_scenario)
        force_low_conf = bool(body.get("force_low_confidence_check", False))
        img_b64 = body.get("image_b64")
        if img_b64:
            if "," in img_b64:
                img_b64 = img_b64.split(",", 1)[1]
            raw_bytes = base64.b64decode(img_b64)
            uploaded_path = _save_normalized_upload(raw_bytes)
    elif file is not None:
        raw_bytes = await file.read()
        if raw_bytes:
            uploaded_path = _save_normalized_upload(raw_bytes)

    return analyze_water_level_with_sam3(
        scenario_id=resolved_scenario,
        uploaded_image_path=uploaded_path,
        force_low_confidence_check=force_low_conf,
    )


@app.post("/api/v1/delete-photo")
def delete_photo(req: DeletePhotoRequest) -> dict:
    deleted = False
    if req.photo_url:
        filename = Path(req.photo_url).name
        if filename.startswith("upload_"):
            target_path = PHOTOS_DIR / filename
            if target_path.exists() and target_path.is_file():
                try:
                    target_path.unlink()
                    deleted = True
                except Exception:
                    pass
    return {"status": "ok", "deleted": deleted, "message": "Custom photo deleted"}


@app.post("/api/v1/project-flood", response_model=ProjectFloodResponse)
def project_flood(req: ProjectFloodRequest) -> ProjectFloodResponse:
    try:
        run_id = req.scenario_id or "latest"
        loc_meta = resolve_location_metadata(req.cam_lat, req.cam_lon, fallback_barangay=req.barangay or "SAN JOSE")
        result = project_photo_to_flood_shapefile(
            dem_path=str(DEFAULT_DEM_PATH),
            cam_lon=req.cam_lon,
            cam_lat=req.cam_lat,
            azimuth_deg=req.azimuth_deg,
            fov_deg=req.fov_deg,
            click_u=req.click_u,
            est_distance_m=req.est_distance_m,
            water_depth_m=req.water_depth_m,
            search_radius_m=req.search_radius_m,
            output_dir=str(OUTPUTS_DIR),
            run_id=run_id,
            barangay=loc_meta["barangay"],
        )
        return ProjectFloodResponse(**result)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/v1/triage-route", response_model=TriageRouteResponse)
def triage_route(req: TriageRouteRequest) -> TriageRouteResponse:
    return run_autonomous_triage_agent(req)


@app.post("/api/v1/simulate-surge", response_model=SurgeSimulationResponse)
def simulate_surge(req: SurgeSimulationRequest) -> SurgeSimulationResponse:
    return simulate_typhoon_surge_with_muse_image(
        scenario_id=req.scenario_id,
        current_depth_m=req.current_depth_m,
        surge_delta_m=req.surge_delta_m,
        barangay=req.barangay,
        cam_lat=req.cam_lat,
        cam_lon=req.cam_lon,
        azimuth_deg=req.azimuth_deg,
        fov_deg=req.fov_deg,
        click_u=req.click_u,
        est_distance_m=req.est_distance_m,
    )


@app.get("/api/v1/download-shp/{run_id}")
def download_shapefile(run_id: str) -> FileResponse:
    safe_id = "".join(c for c in run_id if c.isalnum() or c in ("_", "-")) or "latest"
    zip_path = OUTPUTS_DIR / f"flood_extent_{safe_id}.zip"
    if not zip_path.exists():
        project_photo_to_flood_shapefile(
            dem_path=str(DEFAULT_DEM_PATH),
            cam_lon=121.1372,
            cam_lat=14.7498,
            azimuth_deg=118.0,
            fov_deg=65.0,
            click_u=0.52,
            est_distance_m=38.0,
            water_depth_m=1.35,
            search_radius_m=450.0,
            output_dir=str(OUTPUTS_DIR),
            run_id=safe_id,
            barangay="SAN JOSE",
        )
    if not zip_path.exists():
        raise HTTPException(status_code=404, detail=f"Shapefile bundle for run_id={safe_id} not found")

    return FileResponse(
        path=str(zip_path),
        media_type="application/zip",
        filename=f"rodriguez_flood_extent_{safe_id}.zip",
    )


@app.get("/api/v1/open-weight-logs")
def get_open_weight_logs() -> dict:
    entries = []
    if VERIFICATION_LOG_PATH.exists():
        for line in VERIFICATION_LOG_PATH.read_text(encoding="utf-8").splitlines():
            if line.strip():
                try:
                    entries.append(json.loads(line))
                except Exception:
                    pass
    return {
        "log_file": str(VERIFICATION_LOG_PATH),
        "count": len(entries),
        "recent_calls": entries[-10:],
    }
