import React, { useEffect, useState, useCallback, useRef } from "react";
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

  const sliderTimerRef = useRef(null);
  const projAbortRef = useRef(null);
  const currentConfidence = analysisResult?.visual_gauge?.confidence_score ?? 0.91;

  const runProjectionAndTriage = useCallback(
    async (params, triggerTriage = true, showSpinner = false) => {
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
                scenario_id: "live_operator",
                cam_lat: params.cam_lat,
                cam_lon: params.cam_lon,
                target_lat: projData.target_lat,
                target_lon: projData.target_lon,
                water_depth_m: params.water_depth_m,
                wse_m: projData.water_surface_elev_m,
                barangay: resolvedBrgy,
                max_passable_depth_m: 0.5,
                confidence_score: currentConfidence,
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
      } finally {
        setProjectionLoading(false);
      }
    },
    [currentConfidence]
  );

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
            barangay: resolvedBrgy || cameraParams.barangay,
            water_depth_m: photoData.visual_gauge?.estimated_water_depth_m ?? cameraParams.water_depth_m,
            est_distance_m: photoData.visual_gauge?.estimated_distance_from_camera_m ?? cameraParams.est_distance_m,
            click_u: photoData.visual_gauge?.recommended_click_u ?? cameraParams.click_u,
            click_v: photoData.visual_gauge?.recommended_click_v ?? cameraParams.click_v,
          };
          setCameraParams(initParams);
          runProjectionAndTriage(initParams, true, false);
        } else {
          setPhotoUploadError("Failed to load benchmark scenario.");
        }
      } catch {
        setPhotoUploadError("Could not reach backend photo analyzer.");
      } finally {
        setPhotoUploading(false);
      }
    },
    [cameraParams, runProjectionAndTriage, customPhotoPreview]
  );

  useEffect(() => {
    initApp();
  }, []);

  const handleUpdateCameraParams = (keyOrObj, maybeValue) => {
    const patch =
      typeof keyOrObj === "object" && keyOrObj !== null
        ? keyOrObj
        : { [keyOrObj]: Number(maybeValue) };
    const updated = { ...cameraParams, ...patch };
    setCameraParams(updated);
    if (sliderTimerRef.current) clearTimeout(sliderTimerRef.current);
    if (floodProjection) {
      sliderTimerRef.current = setTimeout(() => {
        runProjectionAndTriage(updated, true);
      }, 120);
    }
  };

  const handleUpdateCameraCoords = (lat, lon) => {
    const updated = { ...cameraParams, cam_lat: lat, cam_lon: lon };
    setCameraParams(updated);
    runProjectionAndTriage(updated, true);
  };

  const handlePhotoClickTarget = (normU, normV) => {
    const updated = { ...cameraParams, click_u: normU, click_v: normV };
    setCameraParams(updated);
    runProjectionAndTriage(updated, true, true);
  };

  const handleUploadCustomPhoto = async (file) => {
    if (!file) return;
    setPhotoUploading(true);
    setPhotoUploadError(null);
    setSurgeResult(null);

    const localUrl = URL.createObjectURL(file);
    setCustomPhotoPreview(localUrl);

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
        const nextParams = {
          ...cameraParams,
          barangay: resolvedBrgy || cameraParams.barangay,
          water_depth_m: data.visual_gauge.estimated_water_depth_m,
          est_distance_m: data.visual_gauge.estimated_distance_from_camera_m,
          click_u: data.visual_gauge.recommended_click_u,
          click_v: data.visual_gauge.recommended_click_v,
        };
        setCameraParams(nextParams);
        runProjectionAndTriage(nextParams, true, false);
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
          floodProjection={floodProjection}
          triageData={triageData}
          onRunTriage={() => {
            if (analysisResult || customPhotoPreview) {
              runProjectionAndTriage(cameraParams, true, true);
            } else {
              handleLoadSampleScenario("kasiglahan_village");
            }
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
                ? `SAM 3.1 + Muse Spark · ${Math.round(currentConfidence * 100)}% conf`
                : "Standby · Awaiting photo input"}
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

        {/* Dual Operational Workbench */}
        <div className="workbench-split">
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

          <MapViewcone
            cameraParams={cameraParams}
            floodProjection={floodProjection}
            triageData={triageData}
            boundaryGeojson={boundaryGeojson}
            evacCentersGeojson={evacCentersGeojson}
            onUpdateCameraCoords={handleUpdateCameraCoords}
            projectionLoading={projectionLoading}
            triageLoading={triageLoading}
          />
        </div>

        {/* Bottom Drawer: Multi-Agent State Machine & Dispatch Queue */}
        <TriageCopilot
          triageData={triageData}
          floodProjection={floodProjection}
          projectionLoading={projectionLoading}
          triageLoading={triageLoading}
        />
      </main>
    </div>
  );
}
