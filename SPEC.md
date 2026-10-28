# MVP Technical Specification: HydroSight AI
**Crowdsourced Street-Level Vision to 3D Hydro-Spatial Flood Triage**

- **Hackathon:** Meta Global AI Developer Hackathon (Oct 26 – Nov 4, 2026)
- **Theme:** Push the Frontier (Physical Systems & Geospatial Intelligence)
- **Pilot Study Area:** Municipality of Rodriguez (Montalban), Rizal, Philippines (`EPSG:32651` / UTM Zone 51N)

---

## 1. System Overview & Core Objective
**HydroSight AI** is a full-stack geospatial web application that converts sideways, street-level flood photos into topologically valid **3D Flood Extent Shapefiles (`.shp` / `.geojson`)**, building-level inundation depth grids, and autonomous emergency rescue routes.

### Core Workflow:
1. **Input:** An operator uploads a street flood photo, places a Camera Pin (`lat, lon`) on the interactive map, and rotates a Field-of-View (FOV) camera frustum (`azimuth_deg`, `fov_deg`) down the street.
2. **Visual Perception (`sam-3.1`):** Performs zero-shot promptable concept segmentation on the street photo to extract binary masks and bounding boxes for `"floodwater"` and submerged vertical scale reference objects (`"vehicle wheel"`, `"car"`, `"tricycle"`, `"person"`, `"gate"`, `"first-floor door"`).
3. **Visual Hydrological Gauging (`muse-spark-1.3`):** Analyzes the annotated image and SAM 3.1 masks to estimate water depth in meters (`water_depth_m`) and forward distance from the camera (`distance_from_camera_m`) in strict JSON.
4. **Raycast-to-DEM Physics Engine (`Python / Rasterio / GeoPandas`):** Projects the camera coordinate along the target ray bearing onto a local Digital Elevation Model (`rodriguez_srtmgl1_10m_utm51n.tif` in `EPSG:32651`), samples ground elevation ($Z_{DEM}$), computes Water Surface Elevation ($WSE = Z_{DEM} + h_w$), flood-fills the connected lowland catchment where $DEM \le WSE$, and vectorizes the result into downloadable `.shp` and `.geojson` files.
5. **Autonomous Triage & Routing (`muse-spark-1.3` + `muse-glimmer`):** Uses tool-calling over an `OSMnx`/`NetworkX` road graph to clip flooded road segments (`depth > 0.5m`), compute safe rescue routes, and generate one general barangay flood advisory (what residents and responders should do; never a per-house rescue dispatch).

---

## 2. Target Repository Structure

```text
rodriguez-flood-triage/
├── SPEC.md                            # This specification file for agent context
├── backend/
│   ├── data/
│   │   ├── rodriguez_dem.tif          # Local DEM raster (EPSG:32651 UTM Zone 51N)
│   │   ├── rodriguez_roads.graphml    # Pre-downloaded OSMnx road network
│   │   ├── rodriguez_buildings.parquet# Pre-downloaded OSM building footprints
│   │   └── sample_photos/             # Pre-loaded Rodriguez street flood photos
│   ├── outputs/                       # Generated .shp, .shx, .dbf, .prj, .zip, .geojson
│   ├── cache/                         # SHA256-keyed local JSON cache for Meta API calls
│   ├── main.py                        # FastAPI server & route handlers
│   ├── geo_engine.py                  # Camera raycast, DEM flood-fill, Shapefile export, OSMnx routing
│   ├── meta_agents.py                 # SAM 3.1 segmentation, Muse Spark tool-calling, Muse Glimmer
│   ├── schemas.py                     # Pydantic request/response & strict JSON schemas
│   └── requirements.txt               # Python dependencies
└── frontend/
    ├── src/
    │   ├── components/
    │   │   ├── HeaderBar.jsx          # Scenario selector + 1-click Export .SHP button
    │   │   ├── PhotoInspector.jsx     # Left Panel: Street photo, SAM 3.1 mask overlay, click target
    │   │   ├── MapViewcone.jsx        # Right Panel: MapLibre GL 3D terrain, camera pin, Turf.js FOV cone
    │   │   └── TriageCopilot.jsx      # Bottom Panel: Muse Spark route logs & general area advisory
    │   ├── App.jsx
    │   └── main.jsx
    ├── package.json
    └── vite.config.js
```

---

## 3. Tech Stack & Dependencies

### Backend (`backend/requirements.txt`)
```text
fastapi>=0.115.0
uvicorn[standard]>=0.30.0
python-multipart>=0.0.9
pydantic>=2.9.0
openai>=1.50.0
 httpx>=0.27.0
numpy>=1.26.0
rasterio>=1.3.10
geopandas>=1.0.1
shapely>=2.0.6
pyproj>=3.7.0
osmnx>=1.9.4
networkx>=3.3
pillow>=10.4.0
```

### Frontend (`frontend/package.json` key packages)
- `react`, `react-dom`
- `maplibre-gl` (3D terrain & extruded building rendering)
- `@turf/turf` (specifically `@turf/sector`, `@turf/destination`, `@turf/line-String` for live camera FOV cone geometry)
- `lucide-react` (UI icons)
- `tailwindcss`

---

## 4. Mathematical & Geospatial Engine Specifications (`backend/geo_engine.py`)

### 4.1 Coordinate Reference Systems (CRS)
- **Frontend UI / MapLibre GL:** `EPSG:4326` (WGS84 `lon, lat` in degrees)
- **Backend Raster & Vector Math:** `EPSG:32651` (WGS84 / UTM Zone 51N in meters)

### 4.2 Governing Equations
1. **Horizontal Ray Angle Offset ($\Delta \theta$):**
   Given normalized horizontal click position $u \in [0.0, 1.0]$ (where $0.5$ is image center), camera azimuth $\alpha \in [0^\circ, 360^\circ]$, and horizontal FOV $FOV_h$:
   $$\Delta \theta = (u - 0.5) \times FOV_h$$
   $$\theta_{target} = \alpha + \Delta \theta$$

2. **Target UTM Projection ($X_t, Y_t$):**
   Given camera coordinates $(X_c, Y_c)$ in `EPSG:32651` and estimated forward distance $D$ (in meters):
   $$X_t = X_c + D \cdot \sin(\text{radians}(\theta_{target}))$$
   $$Y_t = Y_c + D \cdot \cos(\text{radians}(\theta_{target}))$$

3. **Water Surface Elevation ($WSE$) & Depth Grid:**
   Sample `rodriguez_dem.tif` at $(X_t, Y_t)$ to obtain $Z_{DEM}$. Given AI-estimated water depth $h_w$:
   $$WSE = Z_{DEM}(X_t, Y_t) + h_w$$
   $$\text{Depth}(x, y) = \max(0, WSE - Z_{DEM}(x, y)) \quad \text{for all connected cells where } Z_{DEM}(x, y) \le WSE$$

### 4.3 Reference Implementation for `geo_engine.py`
```python
import math
import zipfile
from pathlib import Path
import numpy as np
import rasterio
from rasterio.features import shapes
from rasterio.windows import from_bounds
import geopandas as gpd
from shapely.geometry import shape, Point
from pyproj import Transformer

to_utm = Transformer.from_crs("EPSG:4326", "EPSG:32651", always_xy=True)
to_wgs84 = Transformer.from_crs("EPSG:32651", "EPSG:4326", always_xy=True)

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
    run_id: str = "latest"
) -> dict:
    cam_x, cam_y = to_utm.transform(cam_lon, cam_lat)
    angle_offset_deg = (click_u - 0.5) * fov_deg
    target_bearing_rad = math.radians(azimuth_deg + angle_offset_deg)

    target_x = cam_x + est_distance_m * math.sin(target_bearing_rad)
    target_y = cam_y + est_distance_m * math.cos(target_bearing_rad)

    with rasterio.open(dem_path) as src:
        ground_elev = float(list(src.sample([(target_x, target_y)]))[0][0])
        wse = ground_elev + water_depth_m

        win = from_bounds(
            target_x - search_radius_m, target_y - search_radius_m,
            target_x + search_radius_m, target_y + search_radius_m,
            src.transform
        )
        dem_sub = src.read(1, window=win)
        win_transform = src.window_transform(win)

        valid_mask = (dem_sub != src.nodata) & (dem_sub <= wse)

        polys = [
            {
                "geometry": shape(geom),
                "wse_m": round(wse, 2),
                "depth_m": round(float(water_depth_m), 2)
            }
            for geom, val in shapes(valid_mask.astype(np.uint8), mask=valid_mask, transform=win_transform)
            if val == 1
        ]

    gdf_utm = gpd.GeoDataFrame(polys, crs="EPSG:32651")
    target_pt = Point(target_x, target_y).buffer(30.0)
    gdf_connected = gdf_utm[gdf_utm.intersects(target_pt)].copy()
    if gdf_connected.empty:
        gdf_connected = gdf_utm

    out_path = Path(output_dir)
    out_path.mkdir(parents=True, exist_ok=True)
    shp_base = out_path / f"flood_extent_{run_id}"
    shp_file = shp_base.with_suffix(".shp")
    gdf_connected.to_file(shp_file)

    zip_path = out_path / f"flood_extent_{run_id}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for ext in [".shp", ".shx", ".dbf", ".prj", ".cpg"]:
            f = shp_base.with_suffix(ext)
            if f.exists():
                zf.write(f, arcname=f.name)

    gdf_wgs84 = gdf_connected.to_crs("EPSG:4326")
    target_lon, target_lat = to_wgs84.transform(target_x, target_y)

    return {
        "run_id": run_id,
        "target_lat": round(target_lat, 6),
        "target_lon": round(target_lon, 6),
        "ground_dem_m": round(ground_elev, 2),
        "measured_depth_m": round(water_depth_m, 2),
        "water_surface_elev_m": round(wse, 2),
        "flood_geojson": gdf_wgs84.__geo_interface__,
        "zip_shapefile_path": str(zip_path)
    }
```

---

## 5. Meta AI Integration & Schemas (`backend/meta_agents.py`)

### 5.1 Caching Requirement
- Response caching is **disabled by default** (`HYDROSIGHT_CACHE_ENABLED=0`): all calls to `sam-3.1`, `muse-spark-1.3`, and the dispatch models run fresh against the live API so demo inputs are never answered from `backend/cache/{sha256_hash}.json`. Set `HYDROSIGHT_CACHE_ENABLED=1` only for offline development, where the SHA256 disk cache can be checked before hitting the network to avoid depleting the $150 hackathon credit budget.

### 5.2 Stage 1: Visual Depth Gauge (`sam-3.1` + `muse-spark-1.3`)
0. **EXIF geotag scan (before any re-save):** `extract_exif_geotag()` in `backend/meta_agents.py` reads GPS (`GPSLatitude/Longitude`, plus `GPSImgDirection`/`GPSAltitude` when present) from the RAW upload bytes and returns it as `photo_geotag` (`PhotoGeotag` in `backend/schemas.py`). The stored copy is re-saved as a plain RGB JPEG with EXIF stripped, so location data is never kept in `backend/data/sample_photos/`. If the geotag lies inside the Rodriguez pilot coverage (14.69-14.89 N, 121.10-121.35 E), the frontend pre-places the camera pin at those coordinates (and sets azimuth from `GPSImgDirection` when recorded); the operator must still confirm or drag the pin in Step 2, because phone GPS is typically only accurate to 5-30 m and a forwarded photo can carry someone else's location. Geotags outside the pilot area are reported but never auto-placed, and photos with no GPS EXIF (common after WhatsApp/Facebook sharing or screenshots) fall back to manual pin placement with an explicit notice. A geotag is a placement hint, never a verified camera position.
1. Send uploaded street photo to `sam-3.1` with concept prompts:
   `["floodwater", "vehicle wheel", "car", "tricycle", "person", "gate", "building entrance"]`
2. Pass the original image + SAM 3.1 bounding/mask metadata to `muse-spark-1.3` with `response_format={"type": "json_object"}` enforcing this Pydantic schema:

```python
from pydantic import BaseModel, Field

class VisualGaugeResult(BaseModel):
    reference_object_detected: str = Field(..., description="Name of submerged object used as scale reference")
    reference_standard_height_m: float = Field(..., description="Typical physical height of reference object in meters")
    submerged_ratio: float = Field(..., description="Fraction of object submerged between 0.0 and 1.0")
    estimated_water_depth_m: float = Field(..., description="Calculated floodwater depth at the object in meters")
    estimated_distance_from_camera_m: float = Field(..., description="Estimated forward distance from camera in meters")
    recommended_click_u: float = Field(..., description="Normalized horizontal X position [0.0-1.0] of reference object")
    recommended_click_v: float = Field(..., description="Normalized vertical Y position [0.0-1.0] of waterline at object")
    confidence_score: float = Field(..., description="Confidence from 0.0 to 1.0")
    hydrological_reasoning: str = Field(..., description="Concise explanation of depth calculation")
```

### 5.3 Stage 2: Spatial Commander Tool Definitions (`muse-spark-1.3`)
Provide `muse-spark-1.3` with the following tools:
1. `get_inundated_structures(wse_m: float, barangay: str)`: Spatial join between flood polygon and `rodriguez_buildings.parquet`, returning counts of buildings with `low (<0.5m)`, `medium (0.5-1.5m)`, and `critical (>1.5m)` flood depth.
2. `compute_safe_rescue_route(origin_lat: float, origin_lon: float, dest_lat: float, dest_lon: float, max_passable_depth_m: float = 0.5)`: Removes edges from `rodriguez_roads.graphml` intersecting flood polygons deeper than `max_passable_depth_m` and computes shortest path via `networkx.shortest_path`.
3. `generate_area_advisory(barangay: str, summary: InundatedStructureSummary, evacuation_center: str, vehicle_type: str)`: Rule-based (no LLM) general advisory in `backend/meta_agents.py` from aggregate depth-band counts only. It returns `AreaAdvisory` (`backend/schemas.py`): level/headline, resident actions, responder actions (stage at the safe evacuation centre, close flooded roads, sweep street-by-street), avoid list, compromised-centre warnings, and a copyable public advisory text. It must never target a specific house, `building_id`, address, or occupant count.

---

## 6. FastAPI Endpoints (`backend/main.py`)

| Method | Endpoint | Purpose |
| :--- | :--- | :--- |
| `GET` | `/api/v1/scenarios` | Returns 3 pre-configured Rodriguez flood scenarios (Kasiglahan Village, Brgy. San Jose, Montalban Town Center) with preset camera coordinates, azimuths, and sample photo URLs. |
| `POST` | `/api/v1/analyze-photo` | Accepts image upload or scenario ID; scans raw EXIF for a GPS geotag (`photo_geotag`, pin pre-placement only, EXIF stripped from the stored copy); runs `sam-3.1` + `muse-spark-1.3` visual gauge; returns masks and `VisualGaugeResult`. |
| `POST` | `/api/v1/project-flood` | Accepts `{ cam_lat, cam_lon, azimuth_deg, fov_deg, click_u, est_distance_m, water_depth_m }`; runs `project_photo_to_flood_shapefile()`; returns GeoJSON layers + Shapefile download link. |
| `POST` | `/api/v1/triage-route` | Runs `muse-spark-1.3` tool-calling to compute safe evacuation routes and issue one general barangay `AreaAdvisory` (no per-building dispatch tickets). |
| `GET` | `/api/v1/download-shp/{run_id}` | Streams the zipped `.shp` bundle (`flood_extent_{run_id}.zip`). |

---

## 7. Frontend Implementation Requirements (`frontend/`)

1. **Split-Screen Layout:**
   - **Left Panel (`PhotoInspector.jsx`):** Renders the street flood photo with interactive SVG/Canvas overlays for `sam-3.1` segmentation masks. Clicking anywhere on the waterline or on a detected reference object updates `click_u`, recalculates the ray angle, and triggers `/api/v1/project-flood`. Includes sliders for `Azimuth (0-360°)`, `FOV (40-90°)`, and `Water Depth Override`.
   - **Right Panel (`MapViewcone.jsx`):** MapLibre GL JS map centered on Rodriguez, Rizal (`[121.142, 14.738]`, zoom `15.5`, pitch `50°`). Renders:
     - Draggable Camera Pin marker.
     - Live FOV viewcone polygon generated via `@turf/sector(cameraPt, radiusKm, bearing1, bearing2)`.
     - Projected target ray line from Camera Pin to `(target_lon, target_lat)`.
     - Flood Extent GeoJSON polygon layer (semi-transparent cyan/blue fill).
     - 3D Extruded OSM Building footprints (`fill-extrusion-color` dynamically styled by flood depth: Green `0m`, Amber `0.5m`, Red `>1.5m`).
     - Safe Rescue Route GeoJSON line layer (animated dashed neon green).
   - **Bottom Drawer (`TriageCopilot.jsx`):** Displays `muse-spark-1.3` spatial reasoning logs and `muse-glimmer` priority rescue dispatch cards.

---

## 8. Agent Step-by-Step Build Instructions

When initializing this repository, execute in this exact order:
1. **Step 1 (Backend Core):** Create `backend/requirements.txt`, `backend/schemas.py`, and `backend/geo_engine.py`. Include a synthetic DEM generator fallback in `geo_engine.py` if `backend/data/rodriguez_dem.tif` is not yet placed in the directory so tests pass immediately.
2. **Step 2 (Meta AI Wrapper):** Create `backend/meta_agents.py` with SHA256 disk caching, `sam-3.1` segmentation handler, `muse-spark-1.3` visual gauge, and `OSMnx` tool-calling functions.
3. **Step 3 (FastAPI Server):** Create `backend/main.py` with CORS enabled and mount all 5 endpoints.
4. **Step 4 (Frontend UI):** Scaffold Vite + React + Tailwind + MapLibre GL + Turf.js in `frontend/` and implement the split-screen Viewcone + Photo Inspector interface pre-loaded with the 3 Rodriguez scenarios.

---

## 9. Bonus Prize Qualification Requirements ($50K Bonus Pool)

To qualify for the Meta Hackathon Bonus Categories (9.1 open-weight is dropped and not claimed; see below), implement the following architectural additions:

### 9.1 Best Build on Meta Open Weight Models (,000) - DROPPED, NOT CLAIMED
- **Status (2026-10-27):** This category is intentionally NOT pursued and must not be claimed in the UI, API, logs, or submission materials. No open-weight model is served (no Fireworks/Baseten/Modal/vLLM/Ollama endpoint); the area advisory is rule-based (no ticket formatting model), and telemetry is recorded in backend/outputs/dispatch_telemetry.log as plain advisory telemetry.
- Do not reintroduce open-weight branding, badges, verification logs, or provider claims unless a real open-weight deployment exists and is exercised end-to-end.

### 9.2 Best Agentic Use-Case ($5,000)
- **Requirement:** Demonstrate true multi-step autonomous decision-making and tool coordination rather than a single prompt-response call.
- **Implementation (`run_autonomous_triage_agent` in `backend/meta_agents.py`):**
  Implement a deterministic 4-turn state machine orchestrated by `muse-spark-1.3` / `muse-spark-open` that streams real-time step updates to the frontend `TriageCopilot.jsx` drawer:
  1. **Step 1 (Perception & Self-Check):** Agent calls `analyze_water_level_with_sam3()`. If `confidence_score < 0.70`, agent automatically re-prompts `sam-3.1` with secondary fallback references (`"fence"`, `"utility pole"`, `"sidewalk curb"`).
  2. **Step 2 (Hydro-Spatial Projection):** Agent calls `project_photo_to_flood_shapefile()` to generate the 3D WSE surface and queries `get_inundated_structures()`.
  3. **Step 3 (Dynamic Graph Rerouting):** Agent inspects affected clusters where `depth_m > 1.0`, selects the nearest MDRRMO evacuation center, and calls `compute_safe_rescue_route(max_passable_depth_m=0.5)`. If the primary route fails or is completely severed by deep water (`>0.5m`), the agent autonomously retries with `vehicle_type="amphibious_rubber_boat"` (`max_passable_depth_m=2.5`).
  4. **Step 4 (General Area Advisory):** Agent calls `generate_area_advisory()` to issue ONE barangay-level advisory from aggregate counts: residents are told what to do and where to go, responders are staged generally at the safe evacuation centre with road-closure and street-sweep actions. No building cluster, house, or address is dispatched to, and no occupant count is invented.

### 9.3 Muse Image / Muse Wonder Integration - REMOVED, NOT CLAIMED
- **Status (2026-10-28):** The "Simulate +1.5m Typhoon Surge" feature is removed from the API, UI, and this spec, and no Muse Image / Muse Wonder bonus is claimed for it. Do not reintroduce it.
- **What was removed:** `POST /api/v1/simulate-surge` (`simulate_typhoon_surge_with_muse_image` in `backend/meta_agents.py`, `SurgeSimulationRequest`/`SurgeSimulationResponse` in `backend/schemas.py`), the "Simulate +1.5m flood surge" button, generated/composited forecast photo, side-by-side compare slider, and surge SMS alert in `frontend/src/components/PhotoInspector.jsx` / `frontend/src/App.jsx`.
- **Why:** It added a fixed, invented `+1.5 m` to a measured depth and rendered a generated or PIL-composited photo as if it were a forecast of that exact street. That manufactures a scenario with no observed or forecast input behind it and invites wrong assumptions (depth, extent, and urgency) from a picture that never happened.
- **Replacement: DEM uncertainty band for the measured depth only.** Every `POST /api/v1/project-flood` response already returns `dem_uncertainty_m`, `wse_low_m`, `wse_high_m`, `flood_area_low_sqm`, and `flood_area_high_sqm`, computed in `backend/geo_engine.py` (`_dem_uncertainty_m`, connected extent recomputed at `wse_low`/`wse_high`). `PhotoInspector.jsx` now displays that band via `uncertaintyBand()` in `frontend/src/utils/format.js`: WSE (measured) +/- DEM uncertainty and the low-high connected flood area in hectares. It adds no hypothetical rise, generates no imagery, and is labelled "not a forecast."
- **If a future-scenario view is ever wanted again:** drive it only from a real, sourced input (for example a PAGASA / river-gauge forecast level for Rodriguez with its timestamp and provenance displayed), run it through the same DEM projection as an explicitly labelled scenario, and show its uncertainty. Never use a hard-coded delta or a photorealistic generated image as evidence.
