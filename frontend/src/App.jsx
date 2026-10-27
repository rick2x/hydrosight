import React, { useEffect, useState, useCallback, useRef } from "react";
import { Layers, MapPin, ShieldAlert, FileCheck2, Radio, Building2, AlertTriangle, School, HeartPulse, Landmark } from "lucide-react";
import HeaderBar from "./components/HeaderBar";
import PhotoInspector from "./components/PhotoInspector";
import MapViewcone from "./components/MapViewcone";
import TriageCopilot from "./components/TriageCopilot";

export default function App() {
  const [analysisResult, setAnalysisResult] = useState(null);
  const [customPhotoPreview, setCustomPhotoPreview] = useState(null);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoUploadError, setPhotoUploadError] = useState(null);

  // Live state from backend (no fake mock preloads)
  const [floodProjection, setFloodProjection] = useState(null);
  const [triageData, setTriageData] = useState(null);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [initialError, setInitialError] = useState(null);

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
  const currentConfidence = analysisResult?.visual_gauge?.confidence_score ?? 0.91;

  const runProjectionAndTriage = useCallback(
    async (params, triggerTriage = true, showSpinner = false) => {
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
      }
    },
    []
  );

  const initApp = useCallback(async () => {
    setIsInitialLoading(true);
    setInitialError(null);
    try {
      const [bndRes, ecRes, photoRes] = await Promise.all([
        fetch("/api/v1/boundary"),
        fetch("/api/v1/evacuation-centers"),
        fetch("/api/v1/analyze-photo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scenario_id: "kasiglahan_village" }),
        }),
      ]);
      if (bndRes.ok) {
        setBoundaryGeojson(await bndRes.json());
      }
      if (ecRes.ok) {
        setEvacCentersGeojson(await ecRes.json());
      }
      if (photoRes.ok) {
        setAnalysisResult(await photoRes.json());
      }
      await runProjectionAndTriage(cameraParams, true);
    } catch (err) {
      setInitialError(err?.message || "Failed to connect to HydroSight AI backend.");
    } finally {
      setIsInitialLoading(false);
    }
  }, [cameraParams, runProjectionAndTriage]);

  // Load initial political boundaries, evacuation centers, and run initial projection
  useEffect(() => {
    initApp();
  }, []);

  // Accepts both key/value or partial cameraParams object (e.g. from PhotoInspector sliders)
  const handleUpdateCameraParams = (keyOrObj, maybeValue) => {
    const patch =
      typeof keyOrObj === "object" && keyOrObj !== null
        ? keyOrObj
        : { [keyOrObj]: Number(maybeValue) };
    const updated = { ...cameraParams, ...patch };
    setCameraParams(updated);
    if (sliderTimerRef.current) clearTimeout(sliderTimerRef.current);
    sliderTimerRef.current = setTimeout(() => {
      runProjectionAndTriage(updated, true);
    }, 120);
  };

  const handleUpdateCameraCoords = (lat, lon) => {
    const updated = { ...cameraParams, cam_lat: lat, cam_lon: lon };
    setCameraParams(updated);
    runProjectionAndTriage(updated, true);
  };

  const handlePhotoClickTarget = (normU, normV) => {
    const updated = { ...cameraParams, click_u: normU, click_v: normV };
    setCameraParams(updated);
    runProjectionAndTriage(updated, true);
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
        const nextParams = {
          ...cameraParams,
          water_depth_m: data.visual_gauge.estimated_water_depth_m,
          est_distance_m: data.visual_gauge.estimated_distance_from_camera_m,
          click_u: data.visual_gauge.recommended_click_u,
          click_v: data.visual_gauge.recommended_click_v,
        };
        setCameraParams(nextParams);
        await runProjectionAndTriage(nextParams, true);
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
    const nextParams = {
      ...cameraParams,
      water_depth_m: 1.35,
      est_distance_m: 38.0,
      click_u: 0.52,
      click_v: 0.56,
    };
    setCameraParams(nextParams);
    runProjectionAndTriage(nextParams, true);
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
    total_structures: 0,
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
  const floodHectares = floodProjection?.flood_area_sqm != null
    ? ((floodProjection.flood_area_sqm) / 10000).toFixed(1)
    : "--";

  return (
    <div className="app-layout">
      {/* Sidebar: Incident & Infrastructure Monitor */}
      <aside className={`app-sidebar ${mobileNavOpen ? "open" : ""}`} aria-label="Incident & Infrastructure Monitor">
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {/* Brand Header */}
          <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "4px 8px" }}>
            <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">
              <rect width="26" height="26" rx="6" fill="#131416" />
              <path d="M5 16 C9 12, 13 20, 21 13" stroke="#1b6c80" strokeWidth="2.2" fill="none" />
              <path d="M5 20 C9 16, 13 22, 21 17" stroke="#131416" strokeWidth="1.8" fill="none" />
              <circle cx="13" cy="8" r="2.5" fill="#c4242a" />
            </svg>
            <div>
              <div style={{ fontWeight: 600, fontSize: "15px", color: "var(--text)", lineHeight: 1.2 }}>
                HydroSight AI
              </div>
              <div style={{ fontSize: "12px", color: "var(--muted)" }}>
                Rodriguez, Rizal · EPSG:32651
              </div>
            </div>
          </div>

          {/* Active Incident Sector Card */}
          <div
            style={{
              padding: "10px 12px",
              borderRadius: "6px",
              border: "1px solid var(--border)",
              backgroundColor: "var(--raised)",
              display: "flex",
              flexDirection: "column",
              gap: "6px",
            }}
          >
            <div style={{ fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--muted)", fontWeight: 600 }}>
              Incident Location
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", fontWeight: 600, color: "var(--text)", fontSize: "14px" }}>
              <MapPin size={15} color="#1b6c80" />
              <span>Brgy. {summary.barangay || cameraParams.barangay || "SAN JOSE"}</span>
            </div>
            <div style={{ fontSize: "12px", color: "var(--muted)", display: "grid", gridTemplateColumns: "1fr", gap: "2px", marginTop: "2px" }}>
              <div>Pin: <span className="mono-id">{cameraParams.cam_lat.toFixed(4)}, {cameraParams.cam_lon.toFixed(4)}</span></div>
              <div>Ground DEM: <span className="mono-id">{floodProjection ? `${floodProjection.ground_dem_m.toFixed(1)} m` : (isInitialLoading ? "Sampling..." : "--")}</span></div>
              <div>WSE Surface: <span className="mono-id" style={{ color: "#1b6c80", fontWeight: 600 }}>{floodProjection ? `${floodProjection.water_surface_elev_m.toFixed(2)} m MSL` : (isInitialLoading ? "Calculating..." : "--")}</span></div>
            </div>
          </div>

          {/* Real-time Infrastructure Impact Monitor */}
          <div style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "0 4px" }}>
            <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text)", display: "flex", alignItems: "center", gap: "6px" }}>
              <Building2 size={14} color="#525659" />
              <span>Infrastructure Impact</span>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 8px", background: "var(--surface)", borderRadius: "4px", border: "1px solid var(--border)" }}>
                <span style={{ color: "var(--muted)" }}>Total Footprints:</span>
                <span className="mono-id" style={{ fontWeight: 600 }}>{floodProjection ? (summary.total_structures || 0).toLocaleString() : "--"}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 8px", background: "var(--surface)", borderRadius: "4px", border: "1px solid var(--border)" }}>
                <span style={{ color: "var(--muted)" }}>Inundated:</span>
                <span className="mono-id" style={{ fontWeight: 600, color: summary.affected_structures > 0 ? "var(--negative)" : "var(--text)" }}>
                  {floodProjection ? (summary.affected_structures || 0).toLocaleString() : "--"}
                </span>
              </div>

              {summary.affected_evac_centers_count > 0 && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 8px", background: "#fee2e2", borderRadius: "4px", border: "1px solid #fecaca", color: "#991b1b", fontWeight: 600 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: "4px" }}><AlertTriangle size={12} /> Evac Centers:</span>
                  <span className="mono-id">{summary.affected_evac_centers_count}</span>
                </div>
              )}

              {summary.affected_schools_count > 0 && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 8px", background: "#fef3c7", borderRadius: "4px", border: "1px solid #fde68a", color: "#92400e" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: "4px" }}><School size={12} /> Schools:</span>
                  <span className="mono-id" style={{ fontWeight: 600 }}>{summary.affected_schools_count}</span>
                </div>
              )}

              {summary.affected_healthcare_count > 0 && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 8px", background: "#fee2e2", borderRadius: "4px", border: "1px solid #fecaca", color: "#991b1b" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: "4px" }}><HeartPulse size={12} /> Clinics / RHU:</span>
                  <span className="mono-id" style={{ fontWeight: 600 }}>{summary.affected_healthcare_count}</span>
                </div>
              )}

              {summary.affected_civic_count > 0 && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 8px", background: "var(--surface)", borderRadius: "4px", border: "1px solid var(--border)" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: "4px" }}><Landmark size={12} /> Civic / Halls:</span>
                  <span className="mono-id" style={{ fontWeight: 600 }}>{summary.affected_civic_count}</span>
                </div>
              )}
            </div>
          </div>

          {/* Meta AI Pipeline Layers */}
          <div style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "0 8px" }}>
            <div style={{ fontSize: "12px", color: "var(--muted)", marginBottom: "2px", fontWeight: 600 }}>
              Active AI pipeline
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--text)" }}>
              <Layers size={13} color="#525659" />
              <span>SAM 3.1 zero-shot vision</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--text)" }}>
              <ShieldAlert size={13} color="#525659" />
              <span>Muse Spark 1.3 spatial gauge</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--text)" }}>
              <Radio size={13} color="#525659" />
              <span>Muse Spark dispatcher (Meta API)</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--text)" }}>
              <FileCheck2 size={13} color="#525659" />
              <span>10m DEM bare-earth fill</span>
            </div>
          </div>
        </div>

        {/* Bottom Help Box */}
        <div
          style={{
            padding: "8px 10px",
            borderRadius: "6px",
            border: "1px solid var(--border)",
            backgroundColor: "var(--surface)",
            fontSize: "12px",
            color: "var(--muted)",
            display: "flex",
            flexDirection: "column",
            gap: "3px",
          }}
        >
          <div style={{ fontWeight: 600, color: "var(--text)" }}>
            Real Buildings.shp Active
          </div>
          <div>
            Click any 3D building to inspect depth & category without shifting camera pin.
          </div>
        </div>
      </aside>

      {/* Main Content Column */}
      <div className="app-main-col">
        <main className="app-sheet">
          {initialError && (
            <div
              style={{
                background: "#fee2e2",
                border: "1px solid #fca5a5",
                color: "#991b1b",
                padding: "10px 14px",
                borderRadius: "6px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "12px",
                fontSize: "13px",
              }}
            >
              <span><strong>Backend Connection Error:</strong> {initialError}</span>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => initApp()}
                style={{ padding: "4px 10px", fontSize: "12px" }}
              >
                Retry Connection
              </button>
            </div>
          )}

          <HeaderBar
            floodProjection={floodProjection}
            triageData={triageData}
            onRunTriage={() => runProjectionAndTriage(cameraParams, true, true)}
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
                {floodProjection ? floodProjection.water_surface_elev_m.toFixed(2) : "--"}{" "}
                <span style={{ fontSize: "13px", color: "var(--muted)" }}>m MSL</span>
              </div>
              <span className="num" style={{ fontSize: "13px", color: "var(--muted)" }}>
                {floodProjection ? `DEM ground ${floodProjection.ground_dem_m.toFixed(2)} m + ${cameraParams.water_depth_m.toFixed(2)} m` : (isInitialLoading ? "Calculating WSE..." : "Standby")}
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
                SAM 3.1 + Muse Spark · {Math.round(currentConfidence * 100)}% conf
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
                {floodProjection ? `${Math.round(floodProjection.flood_area_sqm).toLocaleString()} m² in EPSG:32651` : (isInitialLoading ? "Rasterizing DEM fill..." : "--")}
              </span>
            </div>

            <div className="kpi-cell">
              <span style={{ fontSize: "13px", fontWeight: 500, color: "var(--muted)" }}>
                Critical structures (&gt;1.5 m)
              </span>
              <div className="num" style={{ fontSize: "24px", fontWeight: 400, color: "var(--negative)" }}>
                {floodProjection ? summary.critical_depth_count : "--"}{" "}
                <span style={{ fontSize: "13px", color: "var(--muted)" }}>bldgs</span>
              </div>
              <span className="num" style={{ fontSize: "13px", color: "var(--muted)" }}>
                {floodProjection ? `${summary.medium_depth_count} med (0.5–1.5 m) · ${summary.low_depth_count} low (<0.5 m)` : (isInitialLoading ? "Scanning footprints..." : "--")}
              </span>
              {summary.affected_evac_centers_count > 0 && (
                <div style={{ fontSize: "12px", color: "var(--negative)", fontWeight: 600, marginTop: "2px" }}>
                  <AlertTriangle size={12} /><span>{summary.affected_evac_centers_count} evac center(s) compromised</span>
                </div>
              )}
            </div>

            <div className="kpi-cell">
              <span style={{ fontSize: "13px", fontWeight: 500, color: "var(--muted)" }}>
                Safe evacuation corridor
              </span>
              <div className="num" style={{ fontSize: "24px", fontWeight: 400, color: "var(--text)" }}>
                {triageData ? Math.round(triageData.route_distance_m) : "--"}{" "}
                <span style={{ fontSize: "13px", color: "var(--muted)" }}>m</span>
              </div>
              <span className="num" style={{ fontSize: "13px", color: "var(--muted)" }}>
                {triageData ? `ETA ${triageData.eta_minutes.toFixed(1)} min · ${(triageData.vehicle_selected || "amphibious_boat").replace(/_/g, " ")}` : (triageLoading || isInitialLoading ? "Computing corridor..." : "No corridor active")}
              </span>
            </div>
          </section>

          {/* Split-Screen Workbench: Left PhotoInspector + Right MapViewcone */}
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
              onResetCustomPhoto={handleResetCustomPhoto}
              onSimulateSurge={handleSimulateSurge}
              surgeResult={surgeResult}
              surgeLoading={surgeLoading}
            />

            <MapViewcone
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
