import React from "react";
import { Download, RefreshCw, Layers, ShieldAlert, CheckCircle2 } from "lucide-react";

export default function HeaderBar({
  floodProjection,
  triageData,
  onRunTriage,
  triageLoading,
  projectionLoading,
  cameraParams,
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
  const depth = floodProjection?.measured_depth_m ?? cameraParams?.water_depth_m ?? 1.35;
  const runId = floodProjection?.run_id || "live_incident";

  const isCritical = summary.critical_depth_count > 0 || summary.affected_evac_centers_count > 0;

  const primaryFinding = projectionLoading
    ? "Sampling 10 m bare-earth DEM, calculating Water Surface Elevation, and flood-filling connected lowland basin..."
    : !floodProjection
    ? "Standby · Upload a street flood photo or load benchmark sample to project 3D flood depth and calculate evacuation routes."
    : `Water surface at ${wse?.toFixed(2)} m MSL submerges ${summary.critical_depth_count} structures above 1.5 m in Brgy. ${currentBrgy}${summary.affected_evac_centers_count > 0 ? ` (${summary.affected_evac_centers_count} evacuation center${summary.affected_evac_centers_count > 1 ? "s" : ""} compromised)` : ""}.`;

  const corridorFinding = triageData
    ? `Active corridor: ${(triageData.vehicle_selected || "6x6 Rescue Truck").replace(/_/g, " ")} to ${triageData.evacuation_center_name || "Kasiglahan Village Elementary School"} (${Math.round(triageData.route_distance_m)} m · ${triageData.eta_minutes.toFixed(1)} min ETA).`
    : floodProjection
    ? `${(summary.affected_structures ?? 0).toLocaleString()} total OSM building footprints identified in flooded zone.`
    : null;

  return (
    <header className="app-header-deck" aria-label="Incident Mission Deck">
      {/* Top Row: Brand, Jurisdiction, Meta AI attribution, and Actions */}
      <div className="header-top-row">
        {/* Brand identity */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect width="24" height="24" rx="5" fill="#0f172a" />
              <path d="M4 15 C8 11, 12 19, 20 12" stroke="#0e7490" strokeWidth="2.2" strokeLinecap="round" fill="none" />
              <path d="M4 19 C8 15, 12 21, 20 16" stroke="#38bdf8" strokeWidth="1.6" strokeLinecap="round" fill="none" />
              <circle cx="12" cy="7.5" r="2" fill="#b91c1c" />
            </svg>
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

          <span className="status-pill positive" style={{ fontSize: "11px", height: "20px", padding: "0 6px" }}>
            <Layers size={10} />
            <span>SAM 3.1 + Muse Spark</span>
          </span>
        </div>

        {/* Actions */}
        <div className="header-actions">
          <button
            type="button"
            className="btn-secondary"
            onClick={onRunTriage}
            disabled={triageLoading || projectionLoading}
            style={{ height: "28px", fontSize: "12px", padding: "0 9px" }}
          >
            <RefreshCw size={12} className={triageLoading || projectionLoading ? "spin" : ""} />
            <span>
              {projectionLoading
                ? "Projecting DEM..."
                : triageLoading
                ? "Running triage..."
                : (!floodProjection ? "Project flood extent" : "Re-run triage")}
            </span>
          </button>

          <a
            href={floodProjection ? `/api/v1/download-shp/${runId}` : "#"}
            download={floodProjection ? `rodriguez_flood_extent_${runId}.zip` : undefined}
            onClick={(e) => {
              if (!floodProjection) {
                e.preventDefault();
                alert("Flood projection is computing or awaiting waterline selection.");
              }
            }}
            className="btn-primary"
            style={{
              height: "28px",
              fontSize: "12px",
              padding: "0 10px",
              textDecoration: "none",
              opacity: floodProjection ? 1 : 0.6,
            }}
          >
            <Download size={12} />
            <span>Export .SHP ({depth.toFixed(2)} m)</span>
          </a>
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
