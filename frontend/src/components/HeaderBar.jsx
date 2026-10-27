import React from "react";
import { Download, RefreshCw, Menu } from "lucide-react";

export default function HeaderBar({
  scenarios,
  activeScenarioId,
  onSelectScenario,
  floodProjection,
  triageData,
  onRunTriage,
  triageLoading,
  onToggleMobileNav,
}) {
  const activeScenario =
    scenarios.find((s) => s.id === activeScenarioId) || scenarios[0] || {};
  const summary = floodProjection?.inundated_structures || {
    critical_depth_count: 216,
    medium_depth_count: 53,
    low_depth_count: 39,
    estimated_affected_residents: 2189,
  };
  const wse = floodProjection?.water_surface_elev_m ?? 35.89;
  const depth = floodProjection?.measured_depth_m ?? activeScenario.water_depth_m ?? 1.35;
  const runId = floodProjection?.run_id || activeScenarioId || "kasiglahan_village";

  const findingText = triageData
    ? `Water surface elevation at ${wse.toFixed(2)} m MSL submerges ${summary.critical_depth_count} structures above 1.5 m in Brgy. ${activeScenario.barangay || "SAN JOSE"}; ${triageData.severed_segments_count} road segments severed at 0.5 m — ${triageData.vehicle_selected.replace(/_/g, " ")} corridor (${Math.round(triageData.route_distance_m)} m, ${triageData.eta_minutes.toFixed(1)} min ETA) active.`
    : `Water surface elevation at ${wse.toFixed(2)} m MSL submerges ${summary.critical_depth_count} structures above 1.5 m in Brgy. ${activeScenario.barangay || "SAN JOSE"} (~${summary.estimated_affected_residents.toLocaleString()} residents affected).`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px", minWidth: 0 }}>
      {/* Top chrome bar inside main column */}
      <div className="app-topbar">
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", minWidth: 0 }}>
          <button
            type="button"
            className="btn-secondary"
            style={{ display: "none" }}
            aria-label="Open navigation"
            onClick={onToggleMobileNav}
          >
            <Menu size={15} />
          </button>
          <span style={{ fontSize: "13px", color: "var(--muted)" }}>
            Rodriguez (Montalban), Rizal · CRS{" "}
            <span className="mono-id">EPSG:32651</span>
          </span>
          <span className="status-pill positive">
            Meta Open Weights (Muse Glimmer + Muse Spark Open)
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", minWidth: 0 }}>
          <label
            htmlFor="scenario-select"
            style={{ fontSize: "13px", color: "var(--muted)", fontWeight: 500 }}
          >
            Scenario
          </label>
          <select
            id="scenario-select"
            className="select-control"
            value={activeScenarioId}
            onChange={(e) => onSelectScenario(e.target.value)}
            aria-label="Select Rodriguez flood scenario"
          >
            {scenarios.map((scen) => (
              <option key={scen.id} value={scen.id}>
                {scen.name}
              </option>
            ))}
          </select>

          <button
            type="button"
            className="btn-secondary"
            onClick={onRunTriage}
            disabled={triageLoading}
          >
            <RefreshCw size={14} />
            {triageLoading ? "Running agent..." : "Re-run triage"}
          </button>

          <a
            href={`/api/v1/download-shp/${runId}`}
            download={`rodriguez_flood_extent_${runId}.zip`}
            className="btn-primary"
            style={{ textDecoration: "none" }}
          >
            <Download size={14} />
            Export .SHP ({depth.toFixed(2)} m)
          </a>
        </div>
      </div>

      {/* Sheet Title & Finding Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "16px",
          flexWrap: "wrap",
          paddingBottom: "8px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "4px", maxWidth: "840px", minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <h1
              style={{
                fontSize: "22px",
                fontWeight: 600,
                margin: 0,
                color: "var(--text)",
                letterSpacing: "-0.01em",
              }}
            >
              Rodriguez 3D hydro-spatial flood triage
            </h1>
            <span className="status-pill critical">
              {activeScenario.alert_level || "CRITICAL (Red Warning)"}
            </span>
            <span className="status-pill neutral">
              {activeScenario.river_basin || "Upper Marikina Basin"}
            </span>
          </div>
          <p style={{ margin: 0, fontSize: "14px", color: "var(--muted)" }}>{findingText}</p>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            fontSize: "13px",
            color: "var(--muted)",
            flexWrap: "wrap",
          }}
        >
          <span>
            DEM datum: <strong style={{ color: "var(--text)" }}>USGS SRTMGL1 10 m</strong>
          </span>
          <span>·</span>
          <span className="num">Updated Oct 27, 2026 06:55 PST</span>
        </div>
      </div>
    </div>
  );
}
