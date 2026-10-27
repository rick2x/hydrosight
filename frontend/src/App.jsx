import React, { useEffect, useState, useCallback, useRef } from "react";
import { Layers, MapPin, ShieldAlert, FileCheck2, Radio } from "lucide-react";
import HeaderBar from "./components/HeaderBar";
import PhotoInspector from "./components/PhotoInspector";
import MapViewcone from "./components/MapViewcone";
import TriageCopilot from "./components/TriageCopilot";

const INITIAL_SCENARIOS = [
  {
    id: "kasiglahan_village",
    name: "Kasiglahan Village Housing (Brgy. San Jose)",
    barangay: "SAN JOSE",
    subtitle: "Phase 1K Lowland Basin · Puray-Montalban River Confluence",
    cam_lat: 14.7498,
    cam_lon: 121.1372,
    azimuth_deg: 118.0,
    fov_deg: 65.0,
    default_click_u: 0.52,
    default_click_v: 0.56,
    est_distance_m: 38.0,
    water_depth_m: 1.35,
    photo_url: "/static/photos/kasiglahan_village.jpg",
    evacuation_center_name: "Kasiglahan Village Elementary School (MDRRMO Sector 1)",
    evacuation_center_lat: 14.7528,
    evacuation_center_lon: 121.1414,
    river_basin: "Upper Marikina / Puray Creek",
    alert_level: "CRITICAL (Red Warning)",
    visual_gauge: {
      reference_object_detected: "Submerged Utility Tricycle & Residential Gate",
      reference_standard_height_m: 1.65,
      submerged_ratio: 0.82,
      estimated_water_depth_m: 1.35,
      estimated_distance_from_camera_m: 38.0,
      recommended_click_u: 0.52,
      recommended_click_v: 0.56,
      confidence_score: 0.91,
      hydrological_reasoning:
        "Floodwater meniscus reaches 82% of the standard 1.65m residential steel gate and fully submerges the 1.25m tricycle sidecar cabin roof line at 38m forward range (depth = 1.35m).",
    },
    sam_masks: [
      {
        id: "mask-floodwater-kv",
        concept: "floodwater",
        confidence: 0.97,
        bbox_norm: [0.0, 0.55, 1.0, 1.0],
        polygon_norm: [
          [0.0, 0.56],
          [0.36, 0.55],
          [0.64, 0.55],
          [1.0, 0.56],
          [1.0, 1.0],
          [0.0, 1.0],
        ],
      },
      {
        id: "mask-tricycle-kv",
        concept: "tricycle",
        confidence: 0.92,
        bbox_norm: [0.45, 0.44, 0.62, 0.69],
        polygon_norm: [
          [0.45, 0.44],
          [0.62, 0.44],
          [0.62, 0.69],
          [0.45, 0.69],
        ],
        submerged_ratio: 0.82,
        standard_height_m: 1.65,
      },
      {
        id: "mask-gate-kv",
        concept: "gate",
        confidence: 0.89,
        bbox_norm: [0.1, 0.42, 0.23, 0.78],
        polygon_norm: [
          [0.1, 0.42],
          [0.23, 0.42],
          [0.23, 0.78],
          [0.1, 0.78],
        ],
        submerged_ratio: 0.61,
        standard_height_m: 2.1,
      },
    ],
  },
];

const SHORT_SECTOR_LABELS = {
  kasiglahan_village: "San Jose · Kasiglahan",
  san_jose_riverfront: "San Jose · River Dike",
  montalban_town_center: "Rosario · Town Center",
  san_isidro_southville: "San Isidro · Southville",
  burgos_lowland: "Burgos · Del Pilar",
  san_rafael_wawa: "San Rafael · Wawa",
  manggahan_highway: "Manggahan · Highway",
  balite_proper: "Balite · Town Proper",
  geronimo_riverbank: "Geronimo · Riverbank",
  macabud_upland: "Macabud · Foothills",
  mascap_valley: "Mascap · Valley",
  puray_basin: "Puray · River Basin",
};

const INITIAL_TRIAGE = {
  run_id: "triage_kasiglahan_village",
  barangay: "SAN JOSE",
  evacuation_center_name: "Kasiglahan Village Elementary School (MDRRMO Sector 1)",
  evacuation_center_lat: 14.7528,
  evacuation_center_lon: 121.1414,
  vehicle_selected: "amphibious_rubber_boat",
  max_passable_depth_m: 2.5,
  primary_route_severed: true,
  route_distance_m: 773.7,
  eta_minutes: 6.5,
  severed_segments_count: 19,
  route_geojson: { type: "FeatureCollection", features: [] },
  severed_roads_geojson: { type: "FeatureCollection", features: [] },
  agent_steps: [
    {
      step_number: 1,
      phase: "Perception & Self-Check",
      agent_model: "sam-3.1 + muse-spark-1.3",
      tool_called: "analyze_water_level_with_sam3()",
      input_summary: "scenario=kasiglahan_village, confidence=0.91",
      output_summary:
        "Verified SAM 3.1 waterline & scale reference (Submerged Utility Tricycle & Residential Gate) at confidence 0.91 → depth 1.35m.",
      latency_ms: 142,
    },
    {
      step_number: 2,
      phase: "Hydro-Spatial Projection",
      agent_model: "muse-spark-1.3 (Spatial Commander)",
      tool_called: "get_inundated_structures(wse_m, barangay)",
      input_summary: "WSE=35.89m, barangay=SAN JOSE",
      output_summary:
        "Spatial join across 360 OSM footprints: 216 critical (>1.5m), 53 medium (0.5-1.5m), 39 low (<0.5m); ~2,189 residents affected.",
      latency_ms: 98,
    },
    {
      step_number: 3,
      phase: "Dynamic Graph Rerouting",
      agent_model: "muse-spark-1.3 (OSMnx Router)",
      tool_called: "compute_safe_rescue_route()",
      input_summary: "origin=Kasiglahan Village Elementary School, initial_max_depth=0.5m",
      output_summary:
        "Primary wheeled route (max_depth=0.5m) severed across 19 flooded road segments. Autonomously switched vehicle_type='amphibious_rubber_boat' (max_passable_depth_m=2.5m) and computed 774m safe corridor (ETA 6.5 min).",
      latency_ms: 146,
    },
    {
      step_number: 4,
      phase: "Multi-Agent Handoff to Muse Glimmer",
      agent_model: "muse-glimmer (Meta Open Weights)",
      tool_called: "generate_dispatch_ticket()",
      input_summary: "clusters=3, vehicle=amphibious_rubber_boat",
      output_summary:
        "Dispatched 3 structured JSON rescue tickets via muse-glimmer (Open Weights) (118ms, 485 tokens logged to open_weight_verification.log).",
      latency_ms: 118,
    },
  ],
  dispatch_tickets: [
    {
      ticket_id: "MDRRMO-2026-104",
      priority: "CRITICAL",
      barangay: "SAN JOSE",
      cluster_name: "Brgy. San Jose Floodplain Block 1",
      building_id: "KV-BLK-014",
      flood_depth_m: 1.92,
      wse_m: 35.89,
      stranded_residents_est: 12,
      assigned_unit: "RODRIGUEZ-SAR-01",
      vehicle_type: "amphibious_rubber_boat",
      evacuation_center: "Kasiglahan Village Elementary School (MDRRMO Sector 1)",
      eta_minutes: 6,
      tactical_directive:
        "Approach via elevated bypass; water depth 1.92m exceeds wheeled clearance. Extract 12 residents from KV-BLK-014.",
      generated_by_model: "muse-glimmer (Open Weights)",
    },
    {
      ticket_id: "MDRRMO-2026-105",
      priority: "CRITICAL",
      barangay: "SAN JOSE",
      cluster_name: "Brgy. San Jose Floodplain Block 2",
      building_id: "KV-BLK-029",
      flood_depth_m: 1.68,
      wse_m: 35.89,
      stranded_residents_est: 9,
      assigned_unit: "RODRIGUEZ-SAR-02",
      vehicle_type: "amphibious_rubber_boat",
      evacuation_center: "Kasiglahan Village Elementary School (MDRRMO Sector 1)",
      eta_minutes: 8,
      tactical_directive:
        "Deploy inflatable boat along Phase 1K ridge corridor; prioritize ground-floor households at KV-BLK-029.",
      generated_by_model: "muse-glimmer (Open Weights)",
    },
    {
      ticket_id: "MDRRMO-2026-106",
      priority: "HIGH",
      barangay: "SAN JOSE",
      cluster_name: "Brgy. San Jose Floodplain Block 3",
      building_id: "KV-BLK-042",
      flood_depth_m: 1.35,
      wse_m: 35.89,
      stranded_residents_est: 7,
      assigned_unit: "RODRIGUEZ-SAR-03",
      vehicle_type: "amphibious_rubber_boat",
      evacuation_center: "Kasiglahan Village Elementary School (MDRRMO Sector 1)",
      eta_minutes: 10,
      tactical_directive:
        "Secondary extraction wave from KV-BLK-042 to Kasiglahan Village Elementary School staging area.",
      generated_by_model: "muse-glimmer (Open Weights)",
    },
  ],
  open_weight_telemetry: {
    model_id: "muse-glimmer (Open Weights)",
    provider: "Fireworks AI / Meta Open-Weights Hub",
    latency_ms: 118,
    tokens_used: 485,
    verification_log_path: "backend/outputs/open_weight_verification.log",
  },
};

export default function App() {
  const [scenarios, setScenarios] = useState(INITIAL_SCENARIOS);
  const [activeScenarioId, setActiveScenarioId] = useState("kasiglahan_village");
  const [analysisResult, setAnalysisResult] = useState(null);
  const [customPhotoPreview, setCustomPhotoPreview] = useState(null);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoUploadError, setPhotoUploadError] = useState(null);

  const [floodProjection, setFloodProjection] = useState({
    run_id: "kasiglahan_village",
    target_lat: 14.74964,
    target_lon: 121.13751,
    ground_dem_m: 34.54,
    measured_depth_m: 1.35,
    water_surface_elev_m: 35.89,
    flood_area_sqm: 620599.0,
    inundated_structures: {
      barangay: "SAN JOSE",
      wse_m: 35.89,
      total_structures: 360,
      low_depth_count: 39,
      medium_depth_count: 53,
      critical_depth_count: 216,
      estimated_affected_residents: 2189,
    },
  });
  const [triageData, setTriageData] = useState(INITIAL_TRIAGE);
  const [boundaryGeojson, setBoundaryGeojson] = useState(null);
  const [evacCentersGeojson, setEvacCentersGeojson] = useState(null);
  const [triageLoading, setTriageLoading] = useState(false);
  const [surgeResult, setSurgeResult] = useState(null);
  const [surgeLoading, setSurgeLoading] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const [cameraParams, setCameraParams] = useState({
    cam_lat: 14.7498,
    cam_lon: 121.1372,
    azimuth_deg: 118.0,
    fov_deg: 65.0,
    click_u: 0.52,
    click_v: 0.56,
    est_distance_m: 38.0,
    water_depth_m: 1.35,
    barangay: "SAN JOSE",
  });

  const sliderTimerRef = useRef(null);
  const projAbortRef = useRef(null);

  const activeScenario =
    scenarios.find((s) => s.id === activeScenarioId) || scenarios[0];

  const runProjectionAndTriage = useCallback(
    async (params, scenId, triggerTriage = true, showSpinner = false) => {
      try {
        if (projAbortRef.current) {
          projAbortRef.current.abort();
        }
        const controller = new AbortController();
        projAbortRef.current = controller;

        const projRes = await fetch("/api/v1/project-flood", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            cam_lat: params.cam_lat,
            cam_lon: params.cam_lon,
            azimuth_deg: params.azimuth_deg,
            fov_deg: params.fov_deg,
            click_u: params.click_u,
            est_distance_m: params.est_distance_m,
            water_depth_m: params.water_depth_m,
            search_radius_m: 450.0,
            scenario_id: scenId,
            barangay: params.barangay,
          }),
        });
        if (projRes.ok) {
          const projData = await projRes.json();
          setFloodProjection(projData);

          const resolvedBrgy = projData.inundated_structures?.barangay || params.barangay;
          if (resolvedBrgy && resolvedBrgy !== params.barangay) {
            setCameraParams((prev) => ({ ...prev, barangay: resolvedBrgy }));
          }

          if (triggerTriage) {
            if (showSpinner) setTriageLoading(true);
            const triRes = await fetch("/api/v1/triage-route", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                scenario_id: scenId,
                cam_lat: params.cam_lat,
                cam_lon: params.cam_lon,
                target_lat: projData.target_lat,
                target_lon: projData.target_lon,
                water_depth_m: params.water_depth_m,
                wse_m: projData.water_surface_elev_m,
                barangay: resolvedBrgy,
                max_passable_depth_m: 0.5,
                confidence_score: 0.91,
              }),
            });
            if (triRes.ok) {
              setTriageData(await triRes.json());
            }
            setTriageLoading(false);
          }
        }
      } catch (err) {
        if (err?.name !== "AbortError") {
          setTriageLoading(false);
        }
      }
    },
    []
  );

  // Load initial scenarios, political boundaries, evacuation centers, and run initial projection
  useEffect(() => {
    async function init() {
      try {
        const [scenRes, bndRes, ecRes] = await Promise.all([
          fetch("/api/v1/scenarios"),
          fetch("/api/v1/boundary"),
          fetch("/api/v1/evacuation-centers"),
        ]);
        if (scenRes.ok) {
          const scenList = await scenRes.json();
          if (scenList.length > 0) {
            setScenarios(scenList);
          }
        }
        if (bndRes.ok) {
          setBoundaryGeojson(await bndRes.json());
        }
        if (ecRes.ok) {
          setEvacCentersGeojson(await ecRes.json());
        }
      } catch {
        // Fallback to pre-hydrated state
      }
      runProjectionAndTriage(cameraParams, "kasiglahan_village", true);
    }
    init();
  }, []);

  const handleSelectScenario = async (scenId) => {
    setActiveScenarioId(scenId);
    setSurgeResult(null);
    setCustomPhotoPreview(null);
    setPhotoUploadError(null);
    const scen = scenarios.find((s) => s.id === scenId);
    if (!scen) return;

    const nextParams = {
      cam_lat: scen.cam_lat,
      cam_lon: scen.cam_lon,
      azimuth_deg: scen.azimuth_deg,
      fov_deg: scen.fov_deg,
      click_u: scen.default_click_u,
      click_v: scen.default_click_v,
      est_distance_m: scen.est_distance_m,
      water_depth_m: scen.water_depth_m,
      barangay: scen.barangay,
    };
    setCameraParams(nextParams);

    try {
      const anRes = await fetch("/api/v1/analyze-photo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario_id: scenId }),
      });
      if (anRes.ok) {
        setAnalysisResult(await anRes.json());
      }
    } catch {
      // Ignore network error
    }

    runProjectionAndTriage(nextParams, scenId, true);
  };

  const handleUpdateCameraParams = (partial) => {
    const updated = { ...cameraParams, ...partial };
    setCameraParams(updated);
    if (sliderTimerRef.current) {
      clearTimeout(sliderTimerRef.current);
    }
    sliderTimerRef.current = setTimeout(() => {
      runProjectionAndTriage(updated, activeScenarioId, true);
    }, 160);
  };

  const handlePhotoClickTarget = (u, v) => {
    const updated = { ...cameraParams, click_u: u, click_v: v };
    setCameraParams(updated);
    runProjectionAndTriage(updated, activeScenarioId, true);
  };

  const handleUpdateCameraCoords = (lat, lon) => {
    const updated = { ...cameraParams, cam_lat: lat, cam_lon: lon };
    setCameraParams(updated);
    runProjectionAndTriage(updated, activeScenarioId, true);
  };

  const handleUploadCustomPhoto = async (file) => {
    if (!file) return;
    setPhotoUploadError(null);
    setPhotoUploading(true);
    setSurgeResult(null);

    // Show immediate local preview of the uploaded file
    const objectUrl = URL.createObjectURL(file);
    setCustomPhotoPreview(objectUrl);

    try {
      // Convert file to base64 DataURL so upload succeeds reliably across all proxies
      const b64DataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = (err) => reject(err);
        reader.readAsDataURL(file);
      });

      const res = await fetch("/api/v1/analyze-photo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scenario_id: activeScenarioId,
          image_b64: b64DataUrl,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setAnalysisResult(data);
        if (data.photo_url) {
          setCustomPhotoPreview(data.photo_url);
        }
        const nextParams = {
          ...cameraParams,
          water_depth_m: data.visual_gauge.estimated_water_depth_m,
          est_distance_m: data.visual_gauge.estimated_distance_from_camera_m,
          click_u: data.visual_gauge.recommended_click_u,
          click_v: data.visual_gauge.recommended_click_v,
        };
        setCameraParams(nextParams);
        await runProjectionAndTriage(nextParams, activeScenarioId, true);
      } else {
        setPhotoUploadError(`Upload analysis failed (${res.status}). Using local photo preview.`);
      }
    } catch {
      setPhotoUploadError("Could not reach backend photo analyzer. Local preview active.");
    } finally {
      setPhotoUploading(false);
    }
  };

  const handleResetCustomPhoto = () => {
    setCustomPhotoPreview(null);
    setPhotoUploadError(null);
    setAnalysisResult(null);
    if (activeScenario) {
      const nextParams = {
        ...cameraParams,
        water_depth_m: activeScenario.water_depth_m,
        est_distance_m: activeScenario.est_distance_m,
        click_u: activeScenario.default_click_u,
        click_v: activeScenario.default_click_v,
      };
      setCameraParams(nextParams);
      runProjectionAndTriage(nextParams, activeScenarioId, true);
    }
  };

  const handleSimulateSurge = async () => {
    setSurgeLoading(true);
    try {
      const res = await fetch("/api/v1/simulate-surge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scenario_id: activeScenarioId,
          current_depth_m: cameraParams.water_depth_m,
          surge_delta_m: 1.5,
          barangay: cameraParams.barangay,
          cam_lat: cameraParams.cam_lat,
          cam_lon: cameraParams.cam_lon,
          azimuth_deg: cameraParams.azimuth_deg,
          fov_deg: cameraParams.fov_deg,
          click_u: cameraParams.click_u,
          est_distance_m: cameraParams.est_distance_m,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setSurgeResult(data);
        if (data.surge_flood_geojson) {
          setFloodProjection((prev) => ({
            ...prev,
            flood_geojson: data.surge_flood_geojson,
            water_surface_elev_m: data.surge_wse_m,
          }));
        }
      }
    } catch {
      // Ignore
    }
    setSurgeLoading(false);
  };

  const summary = floodProjection?.inundated_structures || {
    critical_depth_count: 216,
    medium_depth_count: 53,
    low_depth_count: 39,
    estimated_affected_residents: 2189,
  };
  const floodHectares = ((floodProjection?.flood_area_sqm ?? 620599) / 10000).toFixed(1);

  return (
    <div className="app-frame">
      {/* Left Sidebar in Tinted L-Frame */}
      <aside className={`app-sidebar ${mobileNavOpen ? "mobile-open" : ""}`} aria-label="Workspace navigation">
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {/* Product Mark & Workspace Scope */}
          <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "4px 8px" }}>
            <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
              <rect x="1" y="1" width="24" height="24" rx="5" fill="#ffffff" stroke="#1b6c80" strokeWidth="2" />
              <path d="M5 16 C9 12, 13 20, 21 13" stroke="#1b6c80" strokeWidth="2.2" fill="none" />
              <path d="M5 20 C9 16, 13 22, 21 17" stroke="#131416" strokeWidth="1.8" fill="none" />
              <circle cx="13" cy="8" r="2.5" fill="#c4242a" />
            </svg>
            <div>
              <div style={{ fontWeight: 600, fontSize: "15px", color: "var(--text)", lineHeight: 1.2 }}>
                HydroSight AI
              </div>
              <div style={{ fontSize: "13px", color: "var(--muted)" }}>
                Whole Montalban · 11 Brgys
              </div>
            </div>
          </div>

          {/* All 12 Montalban Flood Sectors across 11 Barangays */}
          <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
            <div style={{ fontSize: "13px", color: "var(--muted)", padding: "0 8px 4px 8px" }}>
              Montalban barangay sectors (12)
            </div>
            {scenarios.map((scen) => {
              const active = scen.id === activeScenarioId;
              const shortLabel = SHORT_SECTOR_LABELS[scen.id] || scen.barangay;
              return (
                <button
                  key={scen.id}
                  type="button"
                  onClick={() => {
                    handleSelectScenario(scen.id);
                    setMobileNavOpen(false);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "6px",
                    height: "32px",
                    padding: "0 8px",
                    borderRadius: "6px",
                    border: "none",
                    backgroundColor: active ? "var(--active)" : "transparent",
                    color: "var(--text)",
                    fontWeight: active ? 500 : 400,
                    fontSize: "13px",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    <MapPin size={13} color={active ? "#1b6c80" : "#525659"} style={{ flexShrink: 0 }} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                      {shortLabel}
                    </span>
                  </span>
                  <span className="mono-id" style={{ fontSize: "13px", color: "var(--muted)" }}>
                    {scen.water_depth_m.toFixed(2)}m
                  </span>
                </button>
              );
            })}
          </div>

          {/* Meta AI Pipeline Layers */}
          <div style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "0 8px" }}>
            <div style={{ fontSize: "13px", color: "var(--muted)", marginBottom: "2px" }}>
              Active Meta AI pipeline
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "var(--text)" }}>
              <Layers size={14} color="#525659" />
              <span>SAM 3.1 zero-shot masks</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "var(--text)" }}>
              <ShieldAlert size={14} color="#525659" />
              <span>Muse Spark 1.3 gauge</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "var(--text)" }}>
              <Radio size={14} color="#525659" />
              <span>Muse Glimmer open weights</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "var(--text)" }}>
              <FileCheck2 size={14} color="#525659" />
              <span>Muse Image 1.0 surge</span>
            </div>
          </div>
        </div>

        {/* Bottom Metadata Box */}
        <div
          style={{
            padding: "10px 12px",
            borderRadius: "6px",
            border: "1px solid var(--border)",
            backgroundColor: "var(--surface)",
            fontSize: "13px",
            color: "var(--muted)",
            display: "flex",
            flexDirection: "column",
            gap: "4px",
          }}
        >
          <div style={{ fontWeight: 500, color: "var(--text)" }}>
            Full Montalban DEM active
          </div>
          <div>
            Click any street or barangay on the map to project flood & rescue routes.
          </div>
        </div>
      </aside>

      {/* Main Content Column */}
      <div className="app-main-col">
        <main className="app-sheet">
          <HeaderBar
            scenarios={scenarios}
            activeScenarioId={activeScenarioId}
            onSelectScenario={handleSelectScenario}
            floodProjection={floodProjection}
            triageData={triageData}
            onRunTriage={() => runProjectionAndTriage(cameraParams, activeScenarioId, true, true)}
            triageLoading={triageLoading}
            onToggleMobileNav={() => setMobileNavOpen((prev) => !prev)}
          />

          {/* 5-Cell Divided Hydrological KPI Strip */}
          <section className="kpi-strip" aria-label="Key hydrological and rescue metrics">
            <div className="kpi-cell">
              <span style={{ fontSize: "13px", fontWeight: 500, color: "var(--muted)" }}>
                Water surface elevation (WSE)
              </span>
              <div className="num" style={{ fontSize: "24px", fontWeight: 400, color: "var(--text)" }}>
                {(floodProjection?.water_surface_elev_m ?? 35.89).toFixed(2)}{" "}
                <span style={{ fontSize: "13px", color: "var(--muted)" }}>m MSL</span>
              </div>
              <span className="num" style={{ fontSize: "13px", color: "var(--muted)" }}>
                DEM ground {(floodProjection?.ground_dem_m ?? 34.54).toFixed(2)} m + {cameraParams.water_depth_m.toFixed(2)} m
              </span>
            </div>

            <div className="kpi-cell">
              <span style={{ fontSize: "13px", fontWeight: 500, color: "var(--muted)" }}>
                Measured street flood depth
              </span>
              <div className="num" style={{ fontSize: "24px", fontWeight: 400, color: "var(--text)" }}>
                {cameraParams.water_depth_m.toFixed(2)}{" "}
                <span style={{ fontSize: "13px", color: "var(--muted)" }}>m</span>
              </div>
              <span className="num" style={{ fontSize: "13px", color: "var(--positive)" }}>
                SAM 3.1 + Muse Spark · {Math.round((activeScenario?.visual_gauge?.confidence_score ?? 0.91) * 100)}% conf
              </span>
            </div>

            <div className="kpi-cell">
              <span style={{ fontSize: "13px", fontWeight: 500, color: "var(--muted)" }}>
                Connected flood extent
              </span>
              <div className="num" style={{ fontSize: "24px", fontWeight: 400, color: "var(--text)" }}>
                {floodHectares}{" "}
                <span style={{ fontSize: "13px", color: "var(--muted)" }}>ha</span>
              </div>
              <span className="num" style={{ fontSize: "13px", color: "var(--muted)" }}>
                {Math.round(floodProjection?.flood_area_sqm ?? 620599).toLocaleString()} m² in EPSG:32651
              </span>
            </div>

            <div className="kpi-cell">
              <span style={{ fontSize: "13px", fontWeight: 500, color: "var(--muted)" }}>
                Critical structures (&gt;1.5 m)
              </span>
              <div className="num" style={{ fontSize: "24px", fontWeight: 400, color: "var(--negative)" }}>
                {summary.critical_depth_count}{" "}
                <span style={{ fontSize: "13px", color: "var(--muted)" }}>bldgs</span>
              </div>
              <span className="num" style={{ fontSize: "13px", color: "var(--muted)" }}>
                {summary.medium_depth_count} med (0.5–1.5 m) · {summary.low_depth_count} low (&lt;0.5 m)
              </span>
            </div>

            <div className="kpi-cell">
              <span style={{ fontSize: "13px", fontWeight: 500, color: "var(--muted)" }}>
                Safe evacuation corridor
              </span>
              <div className="num" style={{ fontSize: "24px", fontWeight: 400, color: "var(--text)" }}>
                {Math.round(triageData?.route_distance_m ?? 774)}{" "}
                <span style={{ fontSize: "13px", color: "var(--muted)" }}>m</span>
              </div>
              <span className="num" style={{ fontSize: "13px", color: "var(--muted)" }}>
                ETA {(triageData?.eta_minutes ?? 6.5).toFixed(1)} min · {(triageData?.vehicle_selected || "amphibious_boat").replace(/_/g, " ")}
              </span>
            </div>
          </section>

          {/* Split-Screen Workbench: Left PhotoInspector + Right MapViewcone */}
          <div className="workbench-split">
            <PhotoInspector
              scenario={activeScenario}
              analysisResult={analysisResult}
              cameraParams={cameraParams}
              onUpdateCameraParams={handleUpdateCameraParams}
              onPhotoClickTarget={handlePhotoClickTarget}
              onUploadCustomPhoto={handleUploadCustomPhoto}
              photoUploading={photoUploading}
              photoUploadError={photoUploadError}
              customPhotoPreview={customPhotoPreview}
              onResetCustomPhoto={handleResetCustomPhoto}
              onSimulateSurge={handleSimulateSurge}
              surgeResult={surgeResult}
              surgeLoading={surgeLoading}
            />

            <MapViewcone
              activeScenarioId={activeScenarioId}
              cameraParams={cameraParams}
              floodProjection={floodProjection}
              triageData={triageData}
              boundaryGeojson={boundaryGeojson}
              evacCentersGeojson={evacCentersGeojson}
              onUpdateCameraCoords={handleUpdateCameraCoords}
            />
          </div>

          {/* Bottom Drawer: Muse Spark 1.3 State Machine & Muse Glimmer Dispatch Queue */}
          <TriageCopilot
            triageData={triageData}
            floodProjection={floodProjection}
          />
        </main>
      </div>
    </div>
  );
}
