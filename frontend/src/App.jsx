import React, { useEffect, useState, useCallback, useRef } from "react";
import { RefreshCw } from "lucide-react";
import HeaderBar from "./components/HeaderBar";
import PhotoInspector from "./components/PhotoInspector";
import MapViewcone from "./components/MapViewcone";
import TriageCopilot from "./components/TriageCopilot";

export default function App() {
  const [analysisResult, setAnalysisResult] = useState(null);
  const [customPhotoPreview, setCustomPhotoPreview] = useState(null);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoUploadError, setPhotoUploadError] = useState(null);

  // Live state from backend
  const [floodProjection, setFloodProjection] = useState(null);
  const [triageData, setTriageData] = useState(null);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [initialError, setInitialError] = useState(null);

  const [boundaryGeojson, setBoundaryGeojson] = useState(null);
  const [evacCentersGeojson, setEvacCentersGeojson] = useState(null);
  const [triageLoading, setTriageLoading] = useState(false);
  const [projectionLoading, setProjectionLoading] = useState(false);
  const [surgeResult, setSurgeResult] = useState(null);
  const [surgeLoading, setSurgeLoading] = useState(false);

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

  // Guided 3-Step Pipeline State
  const [activeStep, setActiveStep] = useState(1);
  const [cameraPinPlaced, setCameraPinPlaced] = useState(false);

  const sliderTimerRef = useRef(null);
  const projAbortRef = useRef(null);
  const currentConfidence = analysisResult?.visual_gauge?.confidence_score ?? 0.91;

  const runFloodProjection = useCallback(
    async (params) => {
      setProjectionLoading(true);
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
            scenario_id: "live_operator",
            barangay: params.barangay,
          }),
        });
        if (projRes.ok) {
          const projData = await projRes.json();
          setFloodProjection(projData);
          setCameraPinPlaced(true);

          const resolvedBrgy = projData.inundated_structures?.barangay || params.barangay;
          if (resolvedBrgy && resolvedBrgy !== params.barangay) {
            setCameraParams((prev) => ({ ...prev, barangay: resolvedBrgy }));
          }
          return projData;
        }
      } catch (err) {
        // Abort or network
      } finally {
        setProjectionLoading(false);
      }
      return null;
    },
    []
  );

  const runTriageDispatch = useCallback(
    async (params, currentProj = null) => {
      setTriageLoading(true);
      try {
        const proj = currentProj || floodProjection;
        const resolvedBrgy = proj?.inundated_structures?.barangay || params.barangay || "SAN JOSE";
        const targetLat = proj?.target_lat || params.cam_lat;
        const targetLon = proj?.target_lon || params.cam_lon;
        const wse = proj?.water_surface_elev_m || 24.5;

        const triRes = await fetch("/api/v1/triage-route", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scenario_id: "live_operator",
            cam_lat: params.cam_lat,
            cam_lon: params.cam_lon,
            target_lat: targetLat,
            target_lon: targetLon,
            water_depth_m: params.water_depth_m,
            wse_m: wse,
            barangay: resolvedBrgy,
            max_passable_depth_m: 0.5,
            confidence_score: currentConfidence,
            flood_geojson: proj?.flood_geojson || null,
          }),
        });
        if (triRes.ok) {
          const data = await triRes.json();
          setTriageData(data);
        }
      } catch (err) {
        // Ignore
      } finally {
        setTriageLoading(false);
      }
    },
    [floodProjection, currentConfidence]
  );

  const handleGoToStep = (step) => {
    setActiveStep(step);
    window.scrollTo({ top: 0, behavior: "smooth" });

    // When navigating to Step 3, trigger agent triage and dispatch!
    if (step === 3) {
      runTriageDispatch(cameraParams, floodProjection);
    }
  };

  const initApp = useCallback(async () => {
    setIsInitialLoading(true);
    setInitialError(null);
    setCustomPhotoPreview((prev) => {
      if (prev && prev.startsWith("blob:")) {
        try {
          URL.revokeObjectURL(prev);
        } catch {}
      }
      return null;
    });
    setAnalysisResult(null);
    setFloodProjection(null);
    setTriageData(null);
    setPhotoUploadError(null);
    setSurgeResult(null);
    try {
      const [bndRes, ecRes] = await Promise.all([
        fetch("/api/v1/boundary"),
        fetch("/api/v1/evacuation-centers"),
      ]);
      if (bndRes.ok) {
        setBoundaryGeojson(await bndRes.json());
      }
      if (ecRes.ok) {
        setEvacCentersGeojson(await ecRes.json());
      }
    } catch (err) {
      setInitialError(err?.message || "Failed to connect to HydroSight AI backend.");
    } finally {
      setIsInitialLoading(false);
    }
  }, []);

  const handleLoadSampleScenario = useCallback(
    async (scenarioId = "kasiglahan_village") => {
      setPhotoUploading(true);
      setPhotoUploadError(null);
      setSurgeResult(null);
      setFloodProjection(null);
      setTriageData(null);
      setCameraPinPlaced(false);
      setAnalysisResult(null);
      if (customPhotoPreview && customPhotoPreview.startsWith("blob:")) {
        try {
          URL.revokeObjectURL(customPhotoPreview);
        } catch {}
      }
      setCustomPhotoPreview(null);

      try {
        const photoRes = await fetch("/api/v1/analyze-photo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scenario_id: scenarioId }),
        });
        if (photoRes.ok) {
          const photoData = await photoRes.json();
          setAnalysisResult(photoData);
          const resolvedBrgy = photoData.resolved_location?.barangay;
          const initParams = {
            ...cameraParams,
            cam_lat: photoData.resolved_location?.cam_lat ?? cameraParams.cam_lat,
            cam_lon: photoData.resolved_location?.cam_lon ?? cameraParams.cam_lon,
            azimuth_deg: photoData.resolved_location?.azimuth_deg ?? cameraParams.azimuth_deg,
            fov_deg: photoData.resolved_location?.fov_deg ?? cameraParams.fov_deg,
            barangay: resolvedBrgy || cameraParams.barangay,
            water_depth_m: photoData.visual_gauge?.estimated_water_depth_m ?? cameraParams.water_depth_m,
            est_distance_m: photoData.visual_gauge?.estimated_distance_from_camera_m ?? cameraParams.est_distance_m,
            click_u: photoData.visual_gauge?.recommended_click_u ?? cameraParams.click_u,
            click_v: photoData.visual_gauge?.recommended_click_v ?? cameraParams.click_v,
          };
          setCameraParams(initParams);
        } else {
          setPhotoUploadError("Failed to load benchmark scenario.");
        }
      } catch {
        setPhotoUploadError("Could not reach backend photo analyzer.");
      } finally {
        setPhotoUploading(false);
      }
    },
    [cameraParams, customPhotoPreview]
  );

  useEffect(() => {
    initApp();
  }, []);

  // Pre-load the default benchmark scenario so Step 1 opens with the photo,
  // SAM mask bounding boxes, and visual gauge already analyzed (SPEC Sec.7).
  const didAutoLoadRef = useRef(false);
  useEffect(() => {
    if (didAutoLoadRef.current) return;
    didAutoLoadRef.current = true;
    handleLoadSampleScenario("kasiglahan_village");
  }, []);

  const handleUpdateCameraParams = (keyOrObj, maybeValue) => {
    const patch =
      typeof keyOrObj === "object" && keyOrObj !== null
        ? keyOrObj
        : { [keyOrObj]: Number(maybeValue) };
    const updated = { ...cameraParams, ...patch };
    setCameraParams(updated);
    if (sliderTimerRef.current) clearTimeout(sliderTimerRef.current);
    if (cameraPinPlaced || floodProjection) {
      sliderTimerRef.current = setTimeout(() => {
        runFloodProjection(updated);
      }, 120);
    }
  };

  const handleUpdateCameraCoords = (lat, lon) => {
    const updated = { ...cameraParams, cam_lat: lat, cam_lon: lon };
    setCameraParams(updated);
    setCameraPinPlaced(true);
    runFloodProjection(updated);
  };

  const handleConfirmPin = (lat, lon) => {
    const updated = {
      ...cameraParams,
      cam_lat: lat ?? cameraParams.cam_lat,
      cam_lon: lon ?? cameraParams.cam_lon,
    };
    setCameraParams(updated);
    setCameraPinPlaced(true);
    runFloodProjection(updated);
  };

  const handlePhotoClickTarget = (normU, normV) => {
    const updated = { ...cameraParams, click_u: normU, click_v: normV };
    setCameraParams(updated);
    if (cameraPinPlaced || floodProjection) {
      runFloodProjection(updated);
    }
  };

  const handleUploadCustomPhoto = async (file) => {
    if (!file) return;
    setPhotoUploading(true);
    setPhotoUploadError(null);
    setSurgeResult(null);

    if (customPhotoPreview && customPhotoPreview.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(customPhotoPreview);
      } catch {}
    }

    const localUrl = URL.createObjectURL(file);
    setCustomPhotoPreview(localUrl);

    // Clear previous analysis and downstream projections immediately
    setAnalysisResult(null);
    setFloodProjection(null);
    setTriageData(null);
    setCameraPinPlaced(false);

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("scenario_id", "live_operator");

      const res = await fetch("/api/v1/analyze-photo", {
        method: "POST",
        body: formData,
      });

      if (res.ok) {
        const data = await res.json();
        setAnalysisResult(data);
        const resolvedBrgy = data.resolved_location?.barangay;
        if (resolvedBrgy) {
          setCameraParams((prev) => ({ ...prev, barangay: resolvedBrgy }));
        }
        setFloodProjection(null);
        setTriageData(null);
        setCameraPinPlaced(false);
        const nextParams = {
          ...cameraParams,
          barangay: resolvedBrgy || cameraParams.barangay,
          water_depth_m: data.visual_gauge?.estimated_water_depth_m ?? cameraParams.water_depth_m,
          est_distance_m: data.visual_gauge?.estimated_distance_from_camera_m ?? cameraParams.est_distance_m,
          click_u: data.visual_gauge?.recommended_click_u ?? cameraParams.click_u,
          click_v: data.visual_gauge?.recommended_click_v ?? cameraParams.click_v,
        };
        setCameraParams(nextParams);
      } else {
        setPhotoUploadError(`Upload analysis failed (${res.status}). Using local photo preview.`);
      }
    } catch {
      setPhotoUploadError("Could not reach backend photo analyzer. Local preview active.");
    } finally {
      setPhotoUploading(false);
    }
  };

  const handleDeleteCustomPhoto = async () => {
    if (customPhotoPreview && customPhotoPreview.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(customPhotoPreview);
      } catch {}
    }
    setCustomPhotoPreview(null);
    setPhotoUploadError(null);
    setSurgeResult(null);

    const uploadedUrl = analysisResult?.photo_url;
    const isCustom = analysisResult?.is_custom_upload;
    if (uploadedUrl && isCustom) {
      try {
        await fetch("/api/v1/delete-photo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ photo_url: uploadedUrl }),
        });
      } catch {}
    }

    // Return directly to pure NO INPUT state
    setAnalysisResult(null);
    setFloodProjection(null);
    setTriageData(null);
    setCameraPinPlaced(false);
    setActiveStep(1);
  };

  const handleSimulateSurge = async () => {
    setSurgeLoading(true);
    try {
      const res = await fetch("/api/v1/simulate-surge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scenario_id: "live_operator",
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
    barangay: cameraParams.barangay || "SAN JOSE",
    total_structures: 2797,
    affected_structures: 0,
    critical_depth_count: 0,
    medium_depth_count: 0,
    low_depth_count: 0,
    safe_count: 0,
    affected_schools_count: 0,
    affected_healthcare_count: 0,
    affected_civic_count: 0,
    affected_evac_centers_count: 0,
    affected_commercial_count: 0,
    affected_residential_count: 0,
  };

  const floodHectares =
    floodProjection?.flood_area_sqm != null
      ? (floodProjection.flood_area_sqm / 10000).toFixed(1)
      : "--";

  return (
    <div className="app-shell">
      {/* Main Operations Container */}
      <main className="app-container">
        {/* Unified Mission Deck Header */}
        <HeaderBar
          analysisResult={analysisResult}
          floodProjection={floodProjection}
          triageData={triageData}
          onRunTriage={() => {
            handleGoToStep(3);
          }}
          triageLoading={triageLoading}
          projectionLoading={projectionLoading}
          cameraParams={cameraParams}
        />
        {initialError && (
          <div
            style={{
              backgroundColor: "var(--negative-soft)",
              border: "1px solid var(--negative-border)",
              color: "var(--negative)",
              padding: "10px 14px",
              borderRadius: "6px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              fontSize: "13px",
            }}
          >
            <span>
              <strong>Backend Connection Error:</strong> {initialError}
            </span>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => initApp()}
              style={{ padding: "4px 10px", fontSize: "12px", height: "28px" }}
            >
              Retry Connection
            </button>
          </div>
        )}

        {/* 5-Column Hydrological KPI Ribbon */}
        <section className="kpi-strip" aria-label="Key hydrological and rescue metrics">
          <div className="kpi-cell">
            <span className="kpi-label">Water surface elevation (WSE)</span>
            <div className="kpi-value num">
              {floodProjection ? floodProjection.water_surface_elev_m.toFixed(2) : "--"}
              <span className="kpi-unit">m MSL</span>
            </div>
            <span className="kpi-subtext num">
              {projectionLoading
                ? "Sampling DEM ground elevation..."
                : floodProjection
                ? `DEM ground ${floodProjection.ground_dem_m.toFixed(1)} m + ${cameraParams.water_depth_m.toFixed(2)} m depth`
                : "Standby · Click photo to sample DEM"}
            </span>
          </div>

          <div className="kpi-cell">
            <span className="kpi-label">Measured street flood depth</span>
            <div className="kpi-value num">
              {analysisResult ? cameraParams.water_depth_m.toFixed(2) : "--"}
              <span className="kpi-unit">m</span>
            </div>
            <span className="kpi-subtext num" style={{ color: analysisResult ? "var(--positive)" : "var(--muted)", fontWeight: 500 }}>
              {analysisResult
                ? `${analysisResult.fallback_used ? "Calibrated baseline (live unavailable)" : analysisResult.cached || analysisResult.execution_mode === "cached" ? "SAM 3.1 + Muse Spark - cached" : "SAM 3.1 + Muse Spark - live"} - ${Math.round(currentConfidence * 100)}% conf`
                : "Standby - Awaiting photo input"}
            </span>
          </div>

          <div className="kpi-cell">
            <span className="kpi-label">Connected flood extent</span>
            <div className="kpi-value num">
              {floodHectares}
              <span className="kpi-unit">ha</span>
            </div>
            <span className="kpi-subtext num">
              {projectionLoading
                ? "Rasterizing DEM fill..."
                : floodProjection
                ? `${Math.round(floodProjection.flood_area_sqm).toLocaleString()} m² connected basin`
                : "Awaiting point selection"}
            </span>
          </div>

          <div className="kpi-cell">
            <span className="kpi-label">Critical structures (&gt;1.5 m)</span>
            <div className="kpi-value num" style={{ color: summary.critical_depth_count > 0 ? "var(--negative)" : "var(--text)" }}>
              {floodProjection ? summary.critical_depth_count : "--"}
              <span className="kpi-unit">bldgs</span>
            </div>
            <span className="kpi-subtext num">
              {summary.affected_evac_centers_count > 0 ? (
                <span style={{ color: "var(--negative)", fontWeight: 600 }}>
                  {summary.affected_evac_centers_count} evac center(s) compromised
                </span>
              ) : projectionLoading ? (
                "Scanning footprints..."
              ) : floodProjection ? (
                `${summary.medium_depth_count} med (0.5–1.5m) · ${summary.low_depth_count} low (<0.5m)`
              ) : (
                "Awaiting DEM projection"
              )}
            </span>
          </div>

          <div className="kpi-cell">
            <span className="kpi-label">Safe evacuation corridor</span>
            <div className="kpi-value num">
              {triageData ? Math.round(triageData.route_distance_m) : "--"}
              <span className="kpi-unit">m</span>
            </div>
            <span className="kpi-subtext num">
              {triageLoading
                ? "Computing corridor..."
                : triageData
                ? `ETA ${triageData.eta_minutes.toFixed(1)} min · ${(triageData.vehicle_selected || "amphibious_boat").replace(/_/g, " ")}`
                : "No corridor active"}
            </span>
          </div>
        </section>

        {/* Operational 3-Step Guided Workflow Deck */}
        <section aria-label="Operational 3-Step Workflow Pipeline" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
            <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--text)", letterSpacing: "0.01em" }}>
              Operational triage pipeline (Step {activeStep} of 3):
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              {activeStep > 1 && (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => handleGoToStep(activeStep - 1)}
                  style={{ height: "26px", fontSize: "11.5px", padding: "0 9px" }}
                >
                  ← Back to Step {activeStep - 1}
                </button>
              )}
              {activeStep < 3 && (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => handleGoToStep(activeStep + 1)}
                  disabled={activeStep === 1 && !analysisResult && !customPhotoPreview}
                  style={{ height: "26px", fontSize: "11.5px", padding: "0 10px" }}
                >
                  Proceed to Step {activeStep + 1} →
                </button>
              )}
            </div>
          </div>

          <div className="pipeline-deck">
            {/* Step 1 */}
            <div
              className={`pipeline-step ${activeStep === 1 ? "active" : ""}`}
              onClick={() => handleGoToStep(1)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && handleGoToStep(1)}
            >
              <div className="pipeline-step-header">
                <span className="pipeline-step-title">
                  01 · Street Photo & Perception
                </span>
                <span className={`status-pill ${analysisResult ? "positive" : "neutral"}`} style={{ height: "18px", fontSize: "10.5px" }}>
                  {analysisResult ? "Calibrated" : "Step 1"}
                </span>
              </div>
              <span className="pipeline-step-desc">
                {analysisResult
                  ? `Target u=${cameraParams.click_u.toFixed(2)} · ${cameraParams.water_depth_m.toFixed(2)}m water depth`
                  : "Upload street flood photo or load benchmark sample"}
              </span>
            </div>

            {/* Step 2 */}
            <div
              className={`pipeline-step ${activeStep === 2 ? "active" : ""}`}
              onClick={() => handleGoToStep(2)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && handleGoToStep(2)}
            >
              <div className="pipeline-step-header">
                <span className="pipeline-step-title">
                  02 · Viewcone & 3D Mapping
                </span>
                <span className={`status-pill ${floodProjection ? "positive" : "neutral"}`} style={{ height: "18px", fontSize: "10.5px" }}>
                  {floodProjection ? "Projected" : "Step 2"}
                </span>
              </div>
              <span className="pipeline-step-desc">
                {floodProjection
                  ? `Azimuth ${cameraParams.azimuth_deg}° · FOV ${cameraParams.fov_deg}° · WSE ${floodProjection.water_surface_elev_m.toFixed(2)}m MSL`
                  : "Rotate azimuth & FOV down street to cast DEM ray"}
              </span>
            </div>

            {/* Step 3 */}
            <div
              className={`pipeline-step ${activeStep === 3 ? "active" : ""}`}
              onClick={() => handleGoToStep(3)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && handleGoToStep(3)}
            >
              <div className="pipeline-step-header">
                <span className="pipeline-step-title">
                  03 · Agent Triage & Dispatch
                </span>
                <span className={`status-pill ${triageData ? "positive" : "neutral"}`} style={{ height: "18px", fontSize: "10.5px" }}>
                  {triageData ? "Dispatched" : "Step 3"}
                </span>
              </div>
              <span className="pipeline-step-desc">
                {triageData
                  ? `Corridor active (${Math.round(triageData.route_distance_m)}m) · ${triageData.dispatch_tickets?.length || 0} tickets`
                  : "Sever flooded road network & queue tickets"}
              </span>
            </div>
          </div>
        </section>

        {/* Step-by-Step Viewport: Only active step is shown */}
        <div style={{ display: activeStep === 1 ? "flex" : "none", flexDirection: "column", gap: "12px" }}>
          <PhotoInspector
            analysisResult={analysisResult}
            cameraParams={cameraParams}
            onUpdateCameraParams={handleUpdateCameraParams}
            onPhotoClickTarget={handlePhotoClickTarget}
            onUploadCustomPhoto={handleUploadCustomPhoto}
            photoUploading={photoUploading}
            photoUploadError={photoUploadError}
            customPhotoPreview={customPhotoPreview}
            onDeleteCustomPhoto={handleDeleteCustomPhoto}
            onResetCustomPhoto={handleDeleteCustomPhoto}
            onLoadSampleScenario={handleLoadSampleScenario}
            onSimulateSurge={handleSimulateSurge}
            surgeResult={surgeResult}
            surgeLoading={surgeLoading}
            floodProjection={floodProjection}
            projectionLoading={projectionLoading}
          />

          <div className="step-advance-bar" style={{ padding: "12px 16px" }}>
            <span style={{ color: "var(--muted)", fontSize: "13px" }}>
              {analysisResult
                ? `Photo calibrated (u=${cameraParams.click_u.toFixed(2)}, depth=${cameraParams.water_depth_m.toFixed(2)}m). Ready to align viewcone on 3D map.`
                : "Awaiting photo input. Upload photo or click 'Load sample benchmark' above to begin."}
            </span>
            <button
              type="button"
              className="btn-primary"
              disabled={!analysisResult && !customPhotoPreview}
              onClick={() => handleGoToStep(2)}
              style={{ fontSize: "13px", height: "32px", padding: "0 14px" }}
            >
              <span>Proceed to Step 2: 3D Mapping & Viewcone →</span>
            </button>
          </div>
        </div>

        <div style={{ display: activeStep === 2 ? "flex" : "none", flexDirection: "column", gap: "12px" }}>
          <MapViewcone
            cameraParams={cameraParams}
            floodProjection={floodProjection}
            triageData={triageData}
            boundaryGeojson={boundaryGeojson}
            evacCentersGeojson={evacCentersGeojson}
            onUpdateCameraCoords={handleUpdateCameraCoords}
            onUpdateCameraParams={handleUpdateCameraParams}
            cameraPinPlaced={cameraPinPlaced}
            onConfirmPin={handleConfirmPin}
            activeStep={activeStep}
            projectionLoading={projectionLoading}
            triageLoading={triageLoading}
          />

          <div className="step-advance-bar" style={{ padding: "12px 16px" }}>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => handleGoToStep(1)}
              style={{ fontSize: "12.5px", height: "32px", padding: "0 12px" }}
            >
              <span>← Back to Step 1: Photo</span>
            </button>
            <span style={{ color: "var(--muted)", fontSize: "13px" }}>
              {floodProjection
                ? `WSE at ${floodProjection.water_surface_elev_m.toFixed(2)} m MSL submerges ${summary.affected_structures} structures. Ready to dispatch rescue.`
                : cameraPinPlaced
                ? "3D topographic viewcone calculated. Ready to dispatch."
                : "Point or confirm camera pin location on map to calculate 3D flood."}
            </span>
            <button
              type="button"
              className="btn-primary"
              disabled={!cameraPinPlaced && !floodProjection}
              onClick={() => handleGoToStep(3)}
              style={{ fontSize: "13px", height: "32px", padding: "0 14px" }}
            >
              <span>Proceed to Step 3: Agent Triage & Dispatch →</span>
            </button>
          </div>
        </div>

        <div style={{ display: activeStep === 3 ? "flex" : "none", flexDirection: "column", gap: "12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px", padding: "4px 2px" }}>
            <span style={{ fontSize: "12.5px", color: "var(--muted)", fontWeight: 500 }}>
              Step 3 of 3 · Autonomous spatial agent reasoning, road severance & rescue dispatch queue
            </span>
            <button
              type="button"
              className="btn-secondary"
              disabled={triageLoading}
              onClick={() => handleGoToStep(3)}
              style={{ fontSize: "12px", height: "30px", padding: "0 12px" }}
            >
              <RefreshCw size={12} className={triageLoading ? "spin" : ""} />
              <span>{triageLoading ? "Analyzing..." : "Re-run Triage"}</span>
            </button>
          </div>

          {/* Prominent High-Craft Loading State when Triage is Triggered */}
          {triageLoading && (
            <div
              style={{
                padding: "36px 20px",
                borderRadius: "var(--radius-card)",
                backgroundColor: "var(--surface)",
                border: "1px solid var(--border)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: "14px",
                textAlign: "center",
                minHeight: "240px",
              }}
            >
              <RefreshCw size={32} className="spin" color="var(--accent)" />
              <div>
                <h3 style={{ margin: "0 0 6px 0", fontSize: "16px", fontWeight: 600, color: "var(--text)" }}>
                  Triggering Autonomous Agent Triage & Dispatch...
                </h3>
                <p style={{ margin: 0, fontSize: "13px", color: "var(--muted)", maxWidth: "560px", lineHeight: 1.45 }}>
                  Loading the Rodriguez road network graph, clipping road segments whose DEM flood depth exceeds the vehicle limit, computing the shortest safe corridor to the nearest evacuation center, and preparing building dispatch tickets.
                </p>
              </div>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "center" }}>
                <span className="status-pill neutral num" style={{ fontSize: "11px" }}>
                  OSMnx Road Graph: 1,842 nodes
                </span>
                <span className="status-pill neutral num" style={{ fontSize: "11px" }}>
                  Max Passable Depth: 0.50 m
                </span>
                <span className="status-pill positive num" style={{ fontSize: "11px" }}>
                  DEM flood-fill + road-graph routing
                </span>
              </div>
            </div>
          )}

          <TriageCopilot
            triageData={triageData}
            floodProjection={floodProjection}
            projectionLoading={projectionLoading}
            triageLoading={triageLoading}
          />

          <div className="step-advance-bar" style={{ padding: "12px 16px" }}>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => handleGoToStep(2)}
              style={{ fontSize: "12.5px", height: "32px", padding: "0 12px" }}
            >
              <span>← Back to Step 2: 3D Mapping</span>
            </button>
            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
              <span style={{ color: "var(--text)", fontSize: "12.5px", fontWeight: 500 }}>
                {triageData
                  ? `Corridor active: ${Math.round(triageData.route_distance_m)} m to ${triageData.evacuation_center_name || "Evacuation Center"} · ${triageData.dispatch_tickets?.length || 0} tickets queued`
                  : "Computing autonomous triage..."}
              </span>
              <span style={{ color: "var(--muted)", fontSize: "11px" }}>
                Screening-level emergency triage derived from DEM ground-vs-WSE differentials, not an official flood map.
              </span>
            </div>
            <a
              href={floodProjection ? `/api/v1/download-shp/${floodProjection?.run_id || "live_incident"}` : "#"}
              download={floodProjection ? `rodriguez_flood_extent_${floodProjection?.run_id || "live_incident"}.zip` : undefined}
              className="btn-primary"
              style={{
                fontSize: "13px",
                height: "32px",
                padding: "0 14px",
                textDecoration: "none",
                display: "inline-flex",
                alignItems: "center",
              }}
            >
              <span>Export Certified .SHP Package</span>
            </a>
          </div>
        </div>
      </main>
    </div>
  );
}
