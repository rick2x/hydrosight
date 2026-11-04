# HydroSight AI

**HydroSight AI** converts street-level flood photos into 3D Digital Elevation Model (DEM) flood-extent shapefiles, building inundation depth profiles, safe rescue corridors, and multi-report consolidated flood maps for **Rodriguez (Montalban), Rizal, Philippines**.

See [`SPEC.md`](SPEC.md) for the complete technical specification and mathematical pipelines.

[![Watch Demo Video](https://img.shields.io/badge/YouTube-Watch%20Demo%20Video-FF0000?style=for-the-badge&logo=youtube&logoColor=white)](https://www.youtube.com/watch?v=r6bJpTnVikQ)
[![Meta AI Hackathon](https://img.shields.io/badge/Meta%20AI-Developer%20Hackathon%202026-0081FB?style=for-the-badge&logo=meta&logoColor=white)](https://www.youtube.com/watch?v=r6bJpTnVikQ)

> 📺 **Demo Walkthrough Video:** [https://www.youtube.com/watch?v=r6bJpTnVikQ](https://www.youtube.com/watch?v=r6bJpTnVikQ)

---

## Meta AI Developer Hackathon Submission (Oct 26 – Nov 4, 2026)

- **100% Built During the Hackathon (Rule 4 Compliance):**
  - **Visual Perception & Geometric Sensor (`backend/meta_agents.py`):** Live Meta Model API integration with `sam-3.1` (`POST /v1/responses`) and `muse-spark-1.3` (`POST /v1/chat/completions`), configurable API timeouts (`META_API_TIMEOUT`, default 60s) with clean timeout recovery, pixel-rasterized submergence measurement (`_compute_mask_geometry`), explicit visual scene description & formula derivation (`scene_description` + `conclusion_summary`), EXIF GPS & compass bearing extraction (`extract_exif_geotag`), and an interactive `< 0.70` confidence self-check loop that re-prompts `sam-3.1` with fallback scale concepts (`"fence"`, `"utility pole"`, `"sidewalk curb"`).
  - **3D Hydro-Spatial Physics & Routing Engine (`backend/geo_engine.py`):** `EPSG:32651` camera ray-casting, bilinear 5 m high-resolution DEM sampling with automated CRS normalization (`PRS92` / `ESRI:102457` to `EPSG:32651`), local vertical uncertainty quadrature (`_dem_uncertainty_m`), 8-neighbor connected basin extraction, OpenStreetMap building inundation depth profiling synchronized to the 5 m DTM via point-sampled centroid ground elevations (`rodriguez_buildings_enriched_v2.parquet`, 83,115 footprints), `NetworkX` road-edge severance routing, and zipped ESRI Shapefile (`.shp`, `.shx`, `.dbf`, `.prj`) generation.
  - **Admin Multi-Report Overlap Consolidation Engine (`backend/incidents_store.py`):** Spatial IoU & intersection graph clustering in `EPSG:32651`, multi-cluster elevation-aware building inundation (evaluating each catchment at its true reconciled WSE without elevation dilution), 2D Inverse-Distance + SAM 3.1 confidence-weighted Water Surface Elevation (WSE) fusion, outlier discrepancy detection (`ΔWSE`), and de-duplicated municipal building and flood extent mapping.
  - **Interactive 3D Mission Control Frontend (`frontend/src/`):** Guided 3-step Operator Workbench (`PhotoInspector.jsx`, `MapViewcone.jsx`, `TriageMap.jsx`, `TriageCopilot.jsx`) with 4-phase live execution progress, printable MDRRMO Situation Report export (PDF), and `AdminDashboard.jsx` built with React, MapLibre GL 3D terrain/building extrusions, and `@turf/turf` live FOV viewcones.

---

## Judge 60-Second Verification Walkthrough

1. **Step 1 · Street Photo Perception (`sam-3.1` + `muse-spark-1.3`):**
   - Upload any street flood photo or click **"Load Demo Scenario (Kasiglahan Village · 1.35 m)"**.
   - Inspect the 2-column breakdown card: **"1 · What Vision Sees in the Photo"** (segmented masks + visual scene description) and **"2 · How It Concluded X.XX m Flood Depth"** (`Std Height × Submerged % = Depth`).
   - Click **"Simulate `<0.70` Self-Check"** in the Step 1 toolbar to watch the agent autonomously re-prompt `sam-3.1` with fallback scale concepts (`fence`, `utility pole`, `sidewalk curb`) and recalibrate the depth gauge.
2. **Step 2 · 3D Topographic Ray-Casting & Connected DEM Flood-Fill (`EPSG:32651`):**
   - Click **"Proceed to Step 2: 3D Mapping & Viewcone →"**.
   - Drag the camera pin or rotate the 3D FOV frustum cone on the MapLibre 3D terrain map to sample the 5 m DEM, compute Water Surface Elevation ($\text{WSE} = Z_{\text{DEM}} + d_{\text{water}} \pm \sigma_{\text{DEM}}$), and color 3D OpenStreetMap building extrusions by flood depth tier.
3. **Step 3 · Autonomous Spatial Commander & Printable Situation Report (`muse-spark-1.3` Tool-Calling):**
   - Click **"Trigger Autonomous Agent Triage"** (or **"Proceed to Step 3"**).
   - Watch the live 4-phase execution checklist as `muse-spark-1.3` executes `get_inundated_structures`, `list_evacuation_centers`, `compute_safe_rescue_route` (autonomously switching from `6x6 High-Water Rescue Truck` to `amphibious_rubber_boat` when road segments exceed `0.50 m` depth), and `generate_area_advisory`.
   - Click **"Export Situation Report (PDF)"** or **"Export Certified .SHP Package"**.
4. **Admin & Overlap Consolidation Mode:**
   - Click **"Admin & Overlap Consolidation"** in the top-right header (and click **"Seed Overlapping Demo Reports"** if empty) to inspect how intersecting field reports in `EPSG:32651` are fused via streamlined Confidence-Weighted WSE surface interpolation and outlier exclusion, evaluating structures at true catchment WSE without elevation distortion or double-counting.

---

## Meta AI & Spatial Physics Architecture

1. **Zero-Shot Visual Water Gauge (`sam-3.1` + `muse-spark-1.3`)**
   - **`sam-3.1` (`POST /v1/responses`):** Open-vocabulary segmentation of `"water"` (displayed as `"floodwater"`), `"person"`, `"car"`, `"tricycle"`, `"gate"`, `"building entrance"`, and `"utility pole"`, parsing `<|box;...|>` and `<|polygon;...|>` detections. Rasterizes mask polygons (`_compute_mask_geometry`) to measure pixel-level object submergence ratios directly from mask overlap, with an automated confidence self-check (`< 0.70`) that re-prompts fallback scale concepts (`"fence"`, `"utility pole"`, `"sidewalk curb"`).
   - **`muse-spark-1.3` (`POST /v1/chat/completions`):** Multimodal vision-language reasoning (`response_format={"type": "json_object"}`) that grounds the primary submerged reference object, enforces `estimated_water_depth_m = reference_standard_height_m * submerged_ratio` via Pydantic validation, and estimates target ground distance (`estimated_distance_from_camera_m`). Configured with `META_API_TIMEOUT` (default: 60s, connect: 15s) to guarantee ample headroom for reasoning token generation, with clean timeout warnings and calibrated fallback.
   - **EXIF Geotagging & Compass Bearing:** Extracts raw camera coordinates and compass direction (`extract_exif_geotag`) for photo orientation (tested across multiple geotagged samples including `geotag_sample_image.jpg` and `geotag_sample_image2.jpg`).
2. **3D Topographic Ray-Casting & Connected Basin Fill (`EPSG:32651`)**
   - Projects the camera viewing ray $(\phi, \text{FOV}, u, d)$ onto the 5 m bare-earth DEM (`EPSG:32651`), anchors the local Water Surface Elevation ($\text{WSE} = Z_{\text{DEM}}(T) + d_{\text{water}}$) with its DEM uncertainty band (`dem_uncertainty_m`), and extracts the 8-neighbor connected basin polygon and OpenStreetMap building depths.
3. **Verifiable Autonomous Triage Agent & Road Severance (`muse-spark-1.3` Tool-Calling)**
   - Orchestrates a multi-turn function-calling loop (`get_inundated_structures`, `list_evacuation_centers`, `compute_safe_rescue_route`, `generate_area_advisory`). Clips flooded road edges where DEM depth exceeds the rescue vehicle's passable threshold (`0.50 m` for `6x6 High-Water Rescue Truck`, autonomous retry with `amphibious_rubber_boat` when primary routes are severed), rejects flooded evacuation centers, and synthesizes a general barangay-level advisory.
4. **Admin Flood Registry & Overlapping Prediction Consolidation Engine**
   - Persists all analyzed street photos and 3D flood predictions (`backend/incidents_store.py`) and resolves spatial overlaps when multiple field reports cover the same streets:
     - Computes pairwise polygon intersections ($\text{m}^2$), Intersection-over-Union (IoU), camera target separation, and $\Delta\text{WSE}$ in `EPSG:32651`.
     - Reconciles overlapping Water Surface Elevations via **Confidence-Weighted DEM Surface** (2D inverse-distance + `sam-3.1` confidence / inverse DEM variance weighting).
     - Evaluates building inundations per-cluster at each catchment's true reconciled WSE, ensuring multi-basin consolidations (e.g. San Jose at WSE ~32.4m vs. Burgos at WSE ~20.5m) never dilute water levels or cause false "dry" classifications inside flooded areas.
     - Flags high-variance WSE outliers ($\Delta\text{WSE} > 0.45\text{ m}$ / combined DEM uncertainty band) for 1-click exclusion and evaluates OpenStreetMap buildings once against the unified flood surface so submerged structures are never double-counted.

---

## Repository Structure

```text
hydrosight/
├── backend/
│   ├── main.py                              # FastAPI application & REST API endpoints
│   ├── meta_agents.py                       # Meta SAM 3.1 + Muse Spark 1.3 perception & triage agents
│   ├── geo_engine.py                        # EPSG:32651 ray-casting, DEM flood-fill, OSMnx routing & SHP export
│   ├── incidents_store.py                   # Persistent Admin registry & overlapping flood consolidation engine
│   ├── schemas.py                           # Pydantic request/response contracts
│   ├── enrich_buildings.py                  # Offline OSM building footprint enrichment script
│   ├── requirements.txt                     # Python backend dependencies
│   ├── test_admin_consolidation.py          # Unit tests for multi-report overlap consolidation & outlier exclusion
│   ├── test_area_advisory.py                # Unit tests for general barangay advisory rules
│   ├── test_photo_geotag.py                 # Unit tests for EXIF GPS & compass azimuth extraction
│   ├── test_triage_buildings_consistency.py # Unit tests for DEM vs. building tier consistency
│   └── data/                                # 5m DEM (EPSG:32651), enriched OSM buildings parquet, road graph, evac centers & presets
├── frontend/
│   ├── src/
│   │   ├── App.jsx                          # Unified mission control state & Workbench / Admin mode switcher
│   │   ├── index.css                        # Design system tokens & component styles
│   │   ├── components/
│   │   │   ├── HeaderBar.jsx                # Mode switcher, scenario selector & telemetry status bar
│   │   │   ├── PhotoInspector.jsx           # Step 1: Street photo upload, EXIF geotagging & SAM 3.1 gauge
│   │   │   ├── MapViewcone.jsx              # Step 2: Interactive 3D MapLibre viewcone & DEM flood projection
│   │   │   ├── TriageMap.jsx                # Step 3: Safe rescue corridor & compromised road visualization
│   │   │   ├── TriageCopilot.jsx            # Step 3: Agent execution trace & barangay area advisory
│   │   │   └── AdminDashboard.jsx           # Admin Registry: Overlap clusters, reconciliation & 3D union map
│   │   └── utils/                           # Formatting & map click coordinate utilities + unit tests
│   └── package.json
├── boundary/                                # Official Rodriguez political boundary shapefile
├── dem/                                     # Source Copernicus GLO-30 & SRTM DEM rasters
├── download_dem.py                          # DEM acquisition & UTM Zone 51N resampling utility
├── Dockerfile                               # Multi-stage unified build (React SPA + FastAPI + GDAL/PROJ)
├── docker-compose.yml                       # 1-line Docker Compose launcher (:8000 & :5173)
├── start_local.ps1 / start_local.bat        # One-command local launcher (Backend :8000 + Frontend :5173)
├── .env.example                             # Environment variable template for Meta AI API credentials
└── SPEC.md                                  # Technical specification
```

---

## Quickstart

### Option A: One-Line Docker Launch (Recommended for Hackathon Judges)
Launch the entire full-stack application (compiled React + MapLibre 3D frontend + FastAPI geospatial backend + 5 m DEM & OSM assets) in a single command:

```bash
docker compose up --build
```
*(Or with live credentials inline: `META_API_KEY=your_key META_API_TIMEOUT=60.0 docker compose up --build`)*

Once started, open:
- **Web Application UI:** [http://localhost:8000](http://localhost:8000) *(also mirrored on [http://localhost:5173](http://localhost:5173))*
- **FastAPI Interactive Docs:** [http://localhost:8000/docs](http://localhost:8000/docs)
- **Health Check:** [http://localhost:8000/api/v1/health](http://localhost:8000/api/v1/health)

---

### Option B: Local Native Setup

#### 1. Environment Configuration
Copy `.env.example` to `.env` and add your Meta AI API key (optional—calibrated deterministic fallbacks are used automatically when `META_API_KEY` is absent):
```bash
cp .env.example .env
```

#### 2. Start Backend & Frontend
On Windows PowerShell:
```powershell
.\start_local.ps1
```
Or start each service manually:
```bash
# Terminal 1 — FastAPI Backend (http://127.0.0.1:8000)
python -m pip install -r backend/requirements.txt
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload

# Terminal 2 — React + Vite Frontend (http://localhost:5173)
cd frontend
npm install
npm run dev
```

#### 3. Run Automated Tests
```bash
# Backend unit test suite (7 tests)
python -m unittest discover -s backend -p "test_*.py" -v

# Frontend unit tests & production build check
cd frontend
npm test
npm run build
```

---

## Honest limitations

- **One municipality, hard-coded.** All coordinates, scenarios, evacuation centers, and the CRS (`EPSG:32651`) are tuned for Rodriguez, Rizal. Other areas need a new DEM, road graph, building footprints, and scenario calibration.
- **High-resolution 5 m bare-earth DEM with automated CRS normalization.** The primary elevation raster (`rodriguez_dem.tif`) is a 5 m resolution bare-earth DTM in `EPSG:32651` (WGS84 UTM Zone 51N). The engine automatically normalizes Philippine PRS92 (`ESRI:102457`) rasters to prevent ~162 m datum shifts. Local DEM vertical uncertainty bands (`dem_uncertainty_m`, `wse_low_m`/`wse_high_m`) are returned with every projection because small click offsets on sloped streets can shift the planar WSE.
- **Depth comes from a visible reference object.** Water depth is `standard height × submerged ratio` for a detected object (wheel, car, tricycle, person, gate). Photos with no usable reference object give weaker estimates, and low-confidence results trigger a re-prompt with fallback concepts.
- **Fallbacks are labelled, not hidden.** With no `META_API_KEY`, or if the Meta API is unreachable, built-in scenarios use calibrated preset masks and gauges, and custom uploads may reuse them. Responses expose this via `fallback_used` and `execution_mode`. No hypothetical surge preview is generated; projections show only the measured depth with its DEM uncertainty band (`dem_uncertainty_m`, `wse_low_m`/`wse_high_m`, `flood_area_low_sqm`/`flood_area_high_sqm`).
- **Routing is only as good as OpenStreetMap.** Safe routes clip road segments by modelled depth on the OSM graph. They do not see real-time closures, debris, currents, or traffic.
- **Not an operational life-safety system.** Outputs support human MDRRMO decision-making. They must not be used as the sole basis for evacuation or rescue dispatch without local validation.
