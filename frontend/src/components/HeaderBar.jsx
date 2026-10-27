import React from "react";
import { Download, RefreshCw, Menu } from "lucide-react";

export default function HeaderBar({
  floodProjection,
  triageData,
  onRunTriage,
  triageLoading,
  onToggleMobileNav,
}) {
  const summary = floodProjection?.inundated_structures || {
    barangay: "SAN JOSE",
    critical_depth_count: 0,
    medium_depth_count: 0,
    low_depth_count: 0,
    affected_structures: 0,
  };
  const currentBrgy = summary.barangay || "SAN JOSE";
  const wse = floodProjection?.water_surface_elev_m;
  const depth = floodProjection?.measured_depth_m ?? 1.35;
  const runId = floodProjection?.run_id || "live_incident";

  const infraAlerts = [];
  if (summary.affected_evac_centers_count > 0) {
    infraAlerts.push(`${summary.affected_evac_centers_count} evac center(s) compromised`);
  }
  if (summary.affected_schools_count > 0) {
    infraAlerts.push(`${summary.affected_schools_count} school(s)`);
  }
  if (summary.affected_healthcare_count > 0) {
    infraAlerts.push(`${summary.affected_healthcare_count} clinic(s)`);
  }
  if (summary.affected_civic_count > 0) {
    infraAlerts.push(`${summary.affected_civic_count} civic hall(s)`);
  }
  const infraSuffix = infraAlerts.length > 0 ? ` [Impact: ${infraAlerts.join(", ")}]` : "";

  const findingText = !floodProjection
    ? "Connecting to Rodriguez Hydro-Spatial DEM flood projection engine..."
    : triageData
    ? `Water surface elevation at ${wse?.toFixed(2)} m MSL submerges ${summary.critical_depth_count} structures above 1.5 m in Brgy. ${currentBrgy}${infraSuffix}; ${triageData.severed_segments_count} road segments severed at 0.5 m — ${triageData.vehicle_selected.replace(/_/g, " ")} corridor (${Math.round(triageData.route_distance_m)} m, ${triageData.eta_minutes.toFixed(1)} min ETA) active.`
    : `Water surface elevation at ${wse?.toFixed(2)} m MSL submerges ${summary.critical_depth_count} structures above 1.5 m in Brgy. ${currentBrgy}${infraSuffix} (${(summary.affected_structures ?? 0).toLocaleString()} OSM footprints in flood zones).`;

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
            Meta AI (SAM 3.1 + Muse Spark 1.3)
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", minWidth: 0 }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "4px 10px",
              borderRadius: "4px",
              backgroundColor: "var(--surface)",
              border: "1px solid var(--border)",
              fontSize: "13px",
              fontWeight: 500,
              color: "var(--text)",
            }}
          >
            <span>Brgy. {currentBrgy}</span>
          </div>

          <button
            type="button"
            className="btn-secondary"
            onClick={onRunTriage}
            disabled={triageLoading || !floodProjection}
          >
            <RefreshCw size={14} />
            {triageLoading ? "Running agent..." : "Re-run triage"}
          </button>

          <a
            href={floodProjection ? `/api/v1/download-shp/${runId}` : "#"}
            download={floodProjection ? `rodriguez_flood_extent_${runId}.zip` : undefined}
            onClick={(e) => {
              if (!floodProjection) {
                e.preventDefault();
                alert("Flood projection is still computing or backend is connecting.");
              }
            }}
            className="btn-primary"
            style={{ textDecoration: "none", opacity: floodProjection ? 1 : 0.6 }}
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
              Critical flood alert
            </span>
          </div>
          <p
            style={{
              margin: 0,
              fontSize: "14px",
              lineHeight: 1.5,
              color: "var(--muted)",
            }}
          >
            {findingText}
          </p>
        </div>

        {/* Live Status indicator */}
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
            padding: "6px 12px",
            borderRadius: "4px",
            backgroundColor: "var(--surface)",
            border: "1px solid var(--border)",
            fontSize: "13px",
            color: "var(--text)",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              backgroundColor: floodProjection ? "var(--positive)" : "var(--negative)",
              display: "inline-block",
            }}
          />
          <span style={{ fontWeight: 500 }}>
            {floodProjection ? "Engine online" : "Connecting..."}
          </span>
          <span style={{ color: "var(--muted)" }}>·</span>
          <span className="mono-id" style={{ color: "var(--muted)" }}>
            {runId}
          </span>
        </div>
      </div>
    </div>
  );
}
