import React from "react";
import { Layers, ShieldAlert, CheckCircle2, PlusCircle, Check } from "lucide-react";

export default function HeaderBar({
  floodProjection,
  triageData,
  triageLoading,
  projectionLoading,
  cameraParams,
  analysisResult,
  viewMode = "workbench",
  onChangeViewMode,
  savedIncidentsCount = 0,
  overlappingClustersCount = 0,
  onSaveToAdmin,
  savedToast = false,
  scenarios = [],
  selectedScenarioId = "",
  onSelectScenario,
}) {
  const summary = floodProjection?.inundated_structures || {
    barangay: cameraParams?.barangay || "SAN JOSE",
    critical_depth_count: 0,
    medium_depth_count: 0,
    low_depth_count: 0,
    affected_structures: 0,
    affected_evac_centers_count: 0,
    affected_schools_count: 0,
    affected_healthcare_count: 0,
    affected_civic_count: 0,
  };
  const currentBrgy = summary.barangay || cameraParams?.barangay || "SAN JOSE";
  const wse = floodProjection?.water_surface_elev_m;
  const runId = floodProjection?.run_id || "live_incident";

  const isCritical = summary.critical_depth_count > 0 || summary.affected_evac_centers_count > 0;

  const primaryFinding = projectionLoading
    ? "Sampling 10 m bare-earth DEM, calculating Water Surface Elevation, and flood-filling connected lowland basin..."
    : !floodProjection
    ? "Standby · Upload a street flood photo to project 3D flood depth and calculate evacuation routes."
    : `Water surface at ${wse?.toFixed(2)} m MSL submerges ${summary.critical_depth_count} structures above 1.5 m in Brgy. ${currentBrgy}${summary.affected_evac_centers_count > 0 ? ` (${summary.affected_evac_centers_count} evacuation center${summary.affected_evac_centers_count > 1 ? "s" : ""} compromised)` : ""}.`;

  const corridorFinding = triageData
    ? `Active corridor: ${(triageData.vehicle_selected || "6x6 Rescue Truck").replace(/_/g, " ")} to ${triageData.evacuation_center_name || "the designated evacuation centre"} (${Math.round(triageData.route_distance_m)} m · ${triageData.eta_minutes.toFixed(1)} min ETA).`
    : floodProjection
    ? `${(summary.affected_structures ?? 0).toLocaleString()} total OSM building footprints identified in flooded zone.`
    : null;

  return (
    <header className="app-header-deck" aria-label="Incident Mission Deck">
      {/* Top Row: Brand, Jurisdiction, Meta AI attribution, and Actions */}
      <div className="header-top-row">
        {/* Brand identity */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <img
              src="/hydrosight-logo.png"
              alt="HydroSight AI Logo"
              width="30"
              height="30"
              style={{ flexShrink: 0, objectFit: "contain" }}
            />
            <span style={{ fontWeight: 600, fontSize: "14.5px", color: "var(--text)", letterSpacing: "-0.01em" }}>
              HydroSight AI
            </span>
          </div>

          <span style={{ color: "var(--border-strong)" }}>·</span>

          <span style={{ fontSize: "12px", color: "var(--muted)" }}>
            Rodriguez, Rizal <strong style={{ color: "var(--text)" }}>(Brgy. {currentBrgy})</strong>
          </span>

          <span className="header-meta-desktop" style={{ color: "var(--border-strong)" }}>·</span>

          <span className="mono-id header-meta-desktop" style={{ fontSize: "11px", color: "var(--muted)" }}>
            EPSG:32651
          </span>

          <span className={`status-pill ${analysisResult && !analysisResult.fallback_used && analysisResult.execution_mode === "live_inference" ? "positive" : "neutral"}`} style={{ fontSize: "11px", height: "20px", padding: "0 6px" }}>
            <Layers size={10} />
            <span>{!analysisResult ? "SAM 3.1 + Muse Spark · Standby" : analysisResult.fallback_used ? "Calibrated baseline · Live unavailable" : analysisResult.cached || analysisResult.execution_mode === "cached" ? "SAM 3.1 + Muse Spark · Cached" : "SAM 3.1 + Muse Spark · Live"}</span>
          </span>
        </div>

        {/* Right Actions: Scenario Preset Selector, Save to Admin, and Workbench vs Admin Switcher */}
        <div className="header-actions">
          {viewMode === "workbench" && scenarios.length > 0 && onSelectScenario && (
            <select
              aria-label="Load Rodriguez flood scenario preset"
              value={selectedScenarioId || ""}
              onChange={(e) => {
                if (e.target.value) onSelectScenario(e.target.value);
              }}
              style={{
                height: "30px",
                padding: "0 8px",
                fontSize: "12px",
                borderRadius: "6px",
                border: "1px solid var(--border)",
                backgroundColor: "var(--surface)",
                color: "var(--text)",
              }}
            >
              <option value="">Load sector preset (12 barangays)...</option>
              {scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.water_depth_m.toFixed(2)}m)
                </option>
              ))}
            </select>
          )}

          {viewMode === "workbench" && floodProjection && onSaveToAdmin && (
            <button
              type="button"
              className="btn-secondary"
              onClick={onSaveToAdmin}
              style={{ height: "30px", fontSize: "12px", padding: "0 10px" }}
              title="Save this photo and 3D flood projection as a new report in the Admin Consolidation Registry"
            >
              {savedToast ? <Check size={12} color="var(--positive)" /> : <PlusCircle size={12} />}
              <span>{savedToast ? "Saved to Admin" : "Save to Admin Registry"}</span>
            </button>
          )}

          {onChangeViewMode && (
            <div className="segmented-bar" role="tablist" aria-label="Workspace mode">
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === "workbench"}
                className={`segmented-btn ${viewMode === "workbench" ? "active" : ""}`}
                onClick={() => onChangeViewMode("workbench")}
              >
                <span>Operator Workbench</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === "admin"}
                className={`segmented-btn ${viewMode === "admin" ? "active" : ""}`}
                onClick={() => onChangeViewMode("admin")}
              >
                <span>Admin & Overlap Consolidation</span>
                <span
                  className="num"
                  style={{
                    padding: "0 5px",
                    borderRadius: "999px",
                    fontSize: "11px",
                    backgroundColor: overlappingClustersCount > 0 ? "var(--warning-soft)" : "var(--active)",
                    color: overlappingClustersCount > 0 ? "var(--warning)" : "var(--text)",
                    border: "1px solid var(--border)",
                  }}
                >
                  {savedIncidentsCount}
                </span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Subtle Divider */}
      <div style={{ height: "1px", backgroundColor: "var(--rule)" /* taste-skill-ignore */ }} />

      {/* Bottom Row: Incident Briefing & Status */}
      <div className="header-bottom-row">
        <div style={{ display: "flex", flexDirection: "column", gap: "3px", minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <h1 style={{ fontSize: "17px", fontWeight: 600, margin: 0, color: "var(--text)", letterSpacing: "-0.01em" }}>
              Rodriguez 3D hydro-spatial flood triage
            </h1>
            <span
              className={`status-pill ${!floodProjection ? "neutral" : isCritical ? "critical" : "positive"}`}
              style={{ fontSize: "11px", height: "20px" }}
            >
              {!floodProjection ? (
                <span>Standby · Awaiting photo</span>
              ) : isCritical ? (
                <>
                  <ShieldAlert size={11} />
                  <span>Critical flood alert</span>
                </>
              ) : (
                <>
                  <CheckCircle2 size={11} />
                  <span>Basin stable</span>
                </>
              )}
            </span>
          </div>

          <p style={{ margin: "2px 0 0 0", fontSize: "13px", color: "var(--muted)", lineHeight: 1.45 }}>
            {primaryFinding}
          </p>

          {corridorFinding && (
            <p style={{ margin: "1px 0 0 0", fontSize: "12.5px", color: "var(--text)", fontWeight: 500, lineHeight: 1.4 }}>
              {corridorFinding}
            </p>
          )}
        </div>

        {/* Live Engine Indicator */}
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            fontSize: "11.5px",
            color: "var(--muted)",
            alignSelf: "flex-start",
            flexShrink: 0,
            paddingTop: "2px",
          }}
        >
          <span
            style={{
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              backgroundColor: projectionLoading || triageLoading
                ? "var(--warning)"
                : floodProjection
                ? "var(--positive)"
                : "var(--accent)",
              display: "inline-block",
            }}
          />
          <span style={{ fontWeight: 500, color: "var(--text)" }}>
            {projectionLoading ? "Computing DEM fill" : triageLoading ? "Routing corridor" : "Engine online"}
          </span>
          <span>·</span>
          <span className="mono-id">{runId}</span>
        </div>
      </div>
    </header>
  );
}
