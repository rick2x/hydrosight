import React, { useState } from "react";
import { Check, Copy, Info, RefreshCw, CheckCircle2, FileText } from "lucide-react";

const LIVE_AGENT_PREVIEW_STEPS = [
  {
    step_number: 1,
    phase: "Perception & Self-Check",
    agent_model: "sam-3.1 + muse-spark-1.3",
    tool_called: "analyze_water_level_with_sam3()",
    outcome: "Validating waterline reference mask submergence ratio and confidence threshold (≥ 0.70)...",
  },
  {
    step_number: 2,
    phase: "Hydro-Spatial Projection",
    agent_model: "muse-spark-1.3 + DEM flood engine",
    tool_called: "get_inundated_structures() & list_evacuation_centers()",
    outcome: "Spatially joining OSM building footprints against 10 m DEM WSE and screening nearest dry evacuation centers...",
  },
  {
    step_number: 3,
    phase: "Dynamic Graph Rerouting",
    agent_model: "Road router (NetworkX + DEM edge depths)",
    tool_called: "compute_safe_rescue_route()",
    outcome: "Severing road edges where DEM flood depth exceeds vehicle passability limit and computing shortest safe corridor...",
  },
  {
    step_number: 4,
    phase: "Area Advisory Generation",
    agent_model: "Rule-based area advisory (DEM aggregate)",
    tool_called: "generate_area_advisory()",
    outcome: "Synthesizing barangay-wide resident & responder guidance from aggregate depth-band counts...",
  },
];

export default function TriageCopilot({
  triageData,
  floodProjection,
  analysisResult,
  projectionLoading,
  triageLoading,
  triagePhaseIdx = 0,
  cameraParams,
}) {
  const [copied, setCopied] = useState(false);

  const steps = triageData?.agent_steps || [];
  const advisory = triageData?.area_advisory || null;
  const projSummary = floodProjection?.inundated_structures || null;
  const brgyName = projSummary?.barangay || cameraParams?.barangay || "SAN JOSE";
  const wseVal = floodProjection?.water_surface_elev_m != null ? Number(floodProjection.water_surface_elev_m).toFixed(2) : "--";

  const handleCopyAdvisory = () => {
    if (!advisory?.copyable_text) return;
    navigator.clipboard?.writeText(advisory.copyable_text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleExportSituationReport = () => {
    if (!advisory) return;
    const esc = (s) =>
      String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    const gauge = analysisResult?.visual_gauge || {};
    const masks = analysisResult?.masks || [];
    const refObj = gauge.reference_object_detected || "Submerged Reference Structure";
    const refH = Number(gauge.reference_standard_height_m ?? 1.65).toFixed(2);
    const subPct = Math.round(Number(gauge.submerged_ratio ?? 0.82) * 100);
    const depthM = Number(gauge.estimated_water_depth_m ?? cameraParams?.water_depth_m ?? 1.35).toFixed(2);
    const confPct = Math.round(Number(gauge.confidence_score ?? 0.91) * 100);
    const groundM = floodProjection?.ground_dem_m != null ? Number(floodProjection.ground_dem_m).toFixed(2) : "--";
    const uncM = floodProjection?.dem_uncertainty_m != null ? Number(floodProjection.dem_uncertainty_m).toFixed(2) : "0.25";
    const wseLow = floodProjection?.wse_low_m != null ? Number(floodProjection.wse_low_m).toFixed(2) : "--";
    const wseHigh = floodProjection?.wse_high_m != null ? Number(floodProjection.wse_high_m).toFixed(2) : "--";
    const areaSqm = floodProjection?.flood_area_sqm != null ? Math.round(Number(floodProjection.flood_area_sqm)).toLocaleString() : "--";
    const areaHa = floodProjection?.flood_area_sqm != null ? (Number(floodProjection.flood_area_sqm) / 10000).toFixed(2) : "--";
    const now = new Date();
    const ts = now.toISOString().replace("T", " ").slice(0, 19) + " UTC";
    const docId = `MDRRMO-SITREP-${brgyName.replace(/\s+/g, "")}-${now.toISOString().slice(0, 10).replace(/-/g, "")}`;
    const camLat = Number(cameraParams?.cam_lat ?? 14.7498).toFixed(5);
    const camLon = Number(cameraParams?.cam_lon ?? 121.1372).toFixed(5);
    const targetLat = floodProjection?.target_lat != null ? Number(floodProjection.target_lat).toFixed(5) : camLat;
    const targetLon = floodProjection?.target_lon != null ? Number(floodProjection.target_lon).toFixed(5) : camLon;
    const azDeg = Number(cameraParams?.azimuth_deg ?? 118).toFixed(1);
    const fovDeg = Number(cameraParams?.fov_deg ?? 65).toFixed(0);
    const distM = Number(cameraParams?.est_distance_m ?? gauge.estimated_distance_from_camera_m ?? 38).toFixed(0);
    const vehicleLabel = (advisory.vehicle_selected || "6x6 High-Water Rescue Truck").replace(/_/g, " ");
    const evacList = (triageData?.evacuation_centers_status || []).slice(0, 5);
    const isSevere = advisory.advisory_level === "SEVERE";

    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${esc(docId)} — HydroSight AI Technical Situation Report</title>
  <style>
    @page { size: A4 portrait; margin: 6mm 8mm; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body {
      font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      color: #0f172a;
      background: #e2e8f0;
      margin: 0;
      padding: 16px 12px;
      font-size: 8.5px;
      line-height: 1.28;
    }
    .sheet {
      max-width: 210mm;
      margin: 0 auto;
      background: #ffffff;
      padding: 7mm 9mm;
      border: 1px solid #94a3b8;
      box-shadow: 0 4px 16px rgba(15, 23, 42, 0.10);
    }
    .toolbar {
      max-width: 210mm;
      margin: 0 auto 8px auto;
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: #0f172a;
      color: #f8fafc;
      padding: 6px 12px;
      font-size: 11px;
    }
    .toolbar button {
      background: #ffffff;
      color: #0f172a;
      border: 1px solid #cbd5e1;
      padding: 4px 12px;
      font-weight: 700;
      font-size: 11px;
      cursor: pointer;
    }
    .toolbar button:hover { background: #f1f5f9; }
    .mono { font-family: "JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; font-variant-numeric: tabular-nums; }
    .num { font-variant-numeric: tabular-nums; }

    /* Document Header */
    .doc-header {
      display: grid;
      grid-template-columns: 1.55fr 1fr;
      gap: 10px;
      border-bottom: 2px solid #0f172a;
      padding-bottom: 5px;
      margin-bottom: 5px;
    }
    .agency-kicker {
      font-size: 7.5px;
      font-weight: 700;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      color: #334155;
      margin: 0 0 1px 0;
    }
    .agency-title {
      font-size: 12.5px;
      font-weight: 800;
      letter-spacing: -0.01em;
      color: #0f172a;
      margin: 0 0 1px 0;
      text-transform: uppercase;
    }
    .agency-sub {
      font-size: 8.5px;
      font-weight: 600;
      color: #1e293b;
      margin: 0;
    }
    .ctrl-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 8px;
    }
    .ctrl-table td {
      border: 1px solid #334155;
      padding: 1.5px 5px;
    }
    .ctrl-label {
      font-weight: 700;
      text-transform: uppercase;
      color: #334155;
      background: #f1f5f9;
      width: 36%;
      letter-spacing: 0.02em;
    }
    .status-banner {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border: 1px solid #0f172a;
      background: ${isSevere ? "#fef2f2" : "#fffbeb"};
      padding: 3px 7px;
      margin-bottom: 5px;
    }
    .status-banner-left {
      font-size: 9.5px;
      font-weight: 800;
      color: ${isSevere ? "#7f1d1d" : "#78350f"};
      text-transform: uppercase;
      letter-spacing: 0.02em;
    }
    .status-banner-right {
      font-size: 8.5px;
      font-weight: 700;
      color: #0f172a;
    }

    /* Section Headers */
    .sec-head {
      background: #0f172a;
      color: #ffffff;
      font-size: 8.5px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 2.5px 6px;
      margin: 5px 0 3px 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .sec-head span.sec-meta {
      font-weight: 500;
      font-size: 7.5px;
      color: #cbd5e1;
      text-transform: none;
      letter-spacing: 0;
    }

    /* Data Tables */
    table.data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 8px;
      margin-bottom: 3px;
    }
    table.data-table th, table.data-table td {
      border: 1px solid #64748b;
      padding: 2px 4.5px;
      text-align: left;
      vertical-align: top;
    }
    table.data-table th {
      background: #f1f5f9;
      font-weight: 700;
      font-size: 7.5px;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      color: #1e293b;
    }
    .col-split {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
    }
    .box-panel {
      border: 1px solid #64748b;
      padding: 3.5px 5.5px;
      font-size: 8px;
      line-height: 1.25;
    }
    .box-panel-title {
      font-size: 7.5px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      color: #0f172a;
      border-bottom: 1px solid #cbd5e1;
      padding-bottom: 1.5px;
      margin-bottom: 2.5px;
    }
    ol.compact-list {
      margin: 0;
      padding-left: 12px;
    }
    ol.compact-list li {
      margin-bottom: 1.5px;
    }
    .sig-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 6px;
      margin-top: 5px;
    }
    .sig-box {
      border: 1px solid #64748b;
      padding: 3px 5px;
      font-size: 7.5px;
    }
    .sig-role {
      font-weight: 700;
      text-transform: uppercase;
      color: #475569;
      letter-spacing: 0.03em;
    }
    .sig-line {
      margin-top: 8px;
      border-top: 1px solid #0f172a;
      padding-top: 1.5px;
      font-weight: 700;
      color: #0f172a;
    }
    .doc-footer {
      margin-top: 4px;
      padding-top: 3px;
      border-top: 1px solid #94a3b8;
      font-size: 7px;
      color: #475569;
      display: flex;
      justify-content: space-between;
      gap: 6px;
    }
    @media print {
      @page { size: A4 portrait; margin: 6mm 8mm; }
      html, body {
        height: 100%;
        background: #ffffff !important;
        padding: 0 !important;
        margin: 0 !important;
      }
      .sheet {
        border: none !important;
        box-shadow: none !important;
        padding: 0 !important;
        margin: 0 !important;
        max-width: 100% !important;
        page-break-inside: avoid !important;
        break-inside: avoid !important;
      }
      .no-print { display: none !important; }
    }
  </style>
</head>
<body>
  <div class="toolbar no-print">
    <div>
      <strong>OFFICIAL SITUATION REPORT PREVIEW</strong> · <span class="mono">${esc(docId)}</span>
    </div>
    <button onclick="window.print()">PRINT / SAVE OFFICIAL PDF</button>
  </div>

  <div class="sheet">
    <!-- Formal Municipal Header & Document Control Block -->
    <div class="doc-header">
      <div>
        <p class="agency-kicker">Republic of the Philippines · Province of Rizal · Municipality of Rodriguez (Montalban)</p>
        <h1 class="agency-title">MDRRMO Hydro-Spatial Flood Triage Situation Report</h1>
        <p class="agency-sub">Automated Street-Level Photogrammetry, 10 m DEM Basin Projection &amp; Emergency Corridor Analysis</p>
      </div>
      <table class="ctrl-table">
        <tbody>
          <tr>
            <td class="ctrl-label">Doc Control ID</td>
            <td class="mono"><strong>${esc(docId)}</strong></td>
          </tr>
          <tr>
            <td class="ctrl-label">Timestamp (UTC)</td>
            <td class="mono">${esc(ts)}</td>
          </tr>
          <tr>
            <td class="ctrl-label">Sector / Brgy</td>
            <td><strong>BRGY. ${esc(brgyName)}</strong>, Rodriguez, Rizal</td>
          </tr>
          <tr>
            <td class="ctrl-label">Spatial Datum</td>
            <td class="mono">EPSG:32651 (WGS84 / UTM Zone 51N)</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Alert Classification Banner -->
    <div class="status-banner">
      <div class="status-banner-left">
        OPERATIONAL ADVISORY CLASSIFICATION: ${esc(advisory.advisory_level)} — ${esc(advisory.headline)}
      </div>
      <div class="status-banner-right mono">
        WSE: ${esc(wseVal)} m MSL (±${esc(uncM)} m) · DEPTH: ${esc(depthM)} m
      </div>
    </div>

    <!-- Section I: Hydrological & Photogrammetric Telemetry Table -->
    <div class="sec-head">
      <span>Section I · Photogrammetric &amp; Topographic DEM Measurements</span>
      <span class="sec-meta">Stage 1 Vision Sensor (sam-3.1 + muse-spark-1.3) &amp; Stage 2 DEM Engine</span>
    </div>
    <table class="data-table">
      <thead>
        <tr>
          <th style="width:24%;">Parameter</th>
          <th style="width:24%;">Measured / Computed Value</th>
          <th style="width:24%;">Tolerance / Range Band</th>
          <th style="width:28%;">Derivation &amp; Sensor Basis</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><strong>Standing Street Flood Depth (h<sub>w</sub>)</strong></td>
          <td class="mono"><strong>${esc(depthM)} m</strong> (${confPct}% confidence)</td>
          <td class="mono">Submerged ratio: ${subPct}% of ${esc(refH)} m</td>
          <td class="mono">h<sub>w</sub> = H<sub>std</sub> (${esc(refH)} m) × r<sub>sub</sub> (${(Number(subPct) / 100).toFixed(2)})</td>
        </tr>
        <tr>
          <td><strong>Water Surface Elevation (WSE)</strong></td>
          <td class="mono"><strong>${esc(wseVal)} m MSL</strong></td>
          <td class="mono">${esc(wseLow)}–${esc(wseHigh)} m MSL (±${esc(uncM)} m)</td>
          <td class="mono">WSE = Z<sub>DEM</sub> (${esc(groundM)} m) + h<sub>w</sub> (${esc(depthM)} m)</td>
        </tr>
        <tr>
          <td><strong>Connected Inundation Basin</strong></td>
          <td class="mono"><strong>${esc(areaHa)} ha</strong> (${esc(areaSqm)} m²)</td>
          <td class="mono">Camera range ~${esc(distM)} m @ ${esc(azDeg)}°</td>
          <td>8-neighbor connected fill on 10 m Copernicus DEM</td>
        </tr>
        <tr>
          <td><strong>Camera &amp; Ray Target (WGS84)</strong></td>
          <td class="mono">Cam: ${esc(camLat)}, ${esc(camLon)}</td>
          <td class="mono">Target: ${esc(targetLat)}, ${esc(targetLon)}</td>
          <td class="mono">FOV ${esc(fovDeg)}° · Click (u=${Number(cameraParams?.click_u ?? 0.52).toFixed(2)}, v=${Number(cameraParams?.click_v ?? 0.56).toFixed(2)})</td>
        </tr>
      </tbody>
    </table>

    <!-- Section II: Visual Perception & Mask Evidence -->
    <div class="sec-head">
      <span>Section II · Visual Scene Observation &amp; Scale Anchor Verification</span>
      <span class="sec-meta">Primary Scale Reference: ${esc(refObj)} (${ masks.length } segmentation masks)</span>
    </div>
    <div class="col-split" style="margin-bottom:4px;">
      <div class="box-panel">
        <div class="box-panel-title">1. Visual Scene Observation (Muse Spark 1.3)</div>
        <div>${esc(gauge.scene_description || gauge.hydrological_reasoning || "Street-level flood corridor analyzed for waterline meniscus and submerged vertical scale reference objects.")}</div>
        <div style="margin-top:4px; padding-top:3px; border-top:1px dashed #cbd5e1;">
          <strong>Depth Conclusion Basis:</strong> ${esc(gauge.conclusion_summary || `Anchored on ${refObj} (${refH} m standard height) at ${subPct}% submergence -> ${depthM} m standing water depth.`)}
        </div>
      </div>
      <table class="data-table" style="margin-bottom:0;">
        <thead>
          <tr>
            <th>Segmented Concept</th>
            <th>Conf</th>
            <th>Std Height</th>
            <th>Submerged</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          ${
            masks.length > 0
              ? masks
                  .slice(0, 5)
                  .map(
                    (m) => `<tr>
                <td><strong>${esc(m.concept)}</strong></td>
                <td class="mono">${Math.round(Number(m.confidence ?? 0.9) * 100)}%</td>
                <td class="mono">${m.concept === "floodwater" ? "—" : `${Number(m.standard_height_m ?? 1.5).toFixed(2)} m`}</td>
                <td class="mono">${m.concept === "floodwater" ? "Waterline" : m.submerged_ratio != null ? `${Math.round(Number(m.submerged_ratio) * 100)}%` : "—"}</td>
                <td class="mono">${esc(m.geometry_source || "sam_box")}</td>
              </tr>`
                  )
                  .join("")
              : `<tr><td colspan="5">Calibrated scale reference (${esc(refObj)}, ${esc(refH)} m × ${subPct}% = ${esc(depthM)} m)</td></tr>`
          }
        </tbody>
      </table>
    </div>

    <!-- Section III: Inundated Structures & Evacuation Center Routing -->
    <div class="sec-head">
      <span>Section III · Structural Exposure &amp; Evacuation Corridor Screening</span>
      <span class="sec-meta">OpenStreetMap Building Footprints &amp; NetworkX Road-Edge Depth Clipping</span>
    </div>
    <div class="col-split" style="margin-bottom:4px;">
      <table class="data-table" style="margin-bottom:0;">
        <thead>
          <tr>
            <th>Inundation Depth Tier</th>
            <th>Threshold</th>
            <th>Structures</th>
            <th>Operational Triage Interpretation</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>Critical Inundation</strong></td>
            <td class="mono">&gt; 1.50 m</td>
            <td class="mono"><strong>${esc(advisory.critical_depth_count)}</strong></td>
            <td>First-floor submergence; priority area sweep</td>
          </tr>
          <tr>
            <td><strong>Medium Inundation</strong></td>
            <td class="mono">0.50 – 1.50 m</td>
            <td class="mono"><strong>${esc(advisory.medium_depth_count)}</strong></td>
            <td>Impassable to standard wheeled vehicles (&gt;0.5 m)</td>
          </tr>
          <tr>
            <td><strong>Low / Shallow</strong></td>
            <td class="mono">&lt; 0.50 m</td>
            <td class="mono"><strong>${esc(advisory.low_depth_count)}</strong></td>
            <td>Passable to high-clearance 6×6 rescue trucks</td>
          </tr>
          <tr style="background:#f8fafc;">
            <td><strong>Total Affected Footprints</strong></td>
            <td class="mono">WSE ${esc(wseVal)} m</td>
            <td class="mono"><strong>${esc(advisory.affected_structures)}</strong></td>
            <td>Schools: ${esc(advisory.affected_schools_count || 0)} · Health: ${esc(advisory.affected_healthcare_count || 0)} · Evac: ${esc(advisory.affected_evac_centers_count || 0)}</td>
          </tr>
        </tbody>
      </table>

      <table class="data-table" style="margin-bottom:0;">
        <thead>
          <tr>
            <th>Evacuation Facility</th>
            <th>Dist</th>
            <th>Status at WSE ${esc(wseVal)} m</th>
          </tr>
        </thead>
        <tbody>
          ${
            evacList.length > 0
              ? evacList
                  .map(
                    (c) => `<tr>
                <td><strong>${esc(c.name)}</strong></td>
                <td class="mono">${Math.round(Number(c.distance_m || 0))} m</td>
                <td class="mono" style="font-weight:700; color:${c.flooded ? "#991b1b" : c.is_selected ? "#0f172a" : "#475569"};">
                  ${c.is_selected ? "SELECTED STAGING (DRY)" : c.flooded ? `FLOODED (~${Number(c.flood_depth_m).toFixed(1)}m) — DO NOT USE` : "DRY (ALTERNATE)"}
                </td>
              </tr>`
                  )
                  .join("")
              : `<tr><td><strong>${esc(advisory.evacuation_center_name)}</strong></td><td class="mono">${Math.round(advisory.route_distance_m)} m</td><td><strong>SELECTED STAGING (DRY)</strong></td></tr>`
          }
          <tr style="background:#f8fafc;">
            <td colspan="3">
              <strong>Active Dispatch Corridor:</strong> ${esc(vehicleLabel)} · <span class="mono">${Math.round(advisory.route_distance_m)} m (~${Number(advisory.eta_minutes).toFixed(1)} min ETA)</span> · <span class="mono">${esc(advisory.severed_segments_count)}</span> road segment(s) severed
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Section IV: Barangay Operational Directives -->
    <div class="sec-head">
      <span>Section IV · Barangay ${esc(brgyName)} Operational Directives (Area-Wide Guidance)</span>
      <span class="sec-meta">Aggregate DEM Footprint Guidance — No Per-Address Dispatch</span>
    </div>
    <div class="col-split" style="margin-bottom:4px;">
      <div class="box-panel">
        <div class="box-panel-title">A. Resident Immediate Safety Directives</div>
        <ol class="compact-list">
          ${(advisory.resident_actions || []).map((a) => `<li>${esc(a)}</li>`).join("")}
        </ol>
      </div>
      <div class="box-panel">
        <div class="box-panel-title">B. MDRRMO Responder Staging &amp; Sweep Protocol</div>
        <ol class="compact-list">
          ${(advisory.responder_actions || []).map((a) => `<li>${esc(a)}</li>`).join("")}
        </ol>
      </div>
    </div>

    <!-- Section V: Autonomous Agent Execution Trace -->
    <div class="sec-head">
      <span>Section V · Autonomous Spatial Agent Verification Trace</span>
      <span class="sec-meta">Deterministic Tool-Calling Audit Trail</span>
    </div>
    <table class="data-table">
      <thead>
        <tr>
          <th style="width:6%;">Step</th>
          <th style="width:20%;">Execution Phase</th>
          <th style="width:24%;">Model / Engine</th>
          <th style="width:42%;">Tool Executed &amp; Verified Outcome</th>
          <th style="width:8%;">Latency</th>
        </tr>
      </thead>
      <tbody>
        ${steps
          .slice(0, 4)
          .map(
            (s) => `<tr>
            <td class="mono"><strong>0${esc(s.step_number)}</strong></td>
            <td><strong>${esc(s.phase)}</strong></td>
            <td class="mono">${esc(s.agent_model)}</td>
            <td><span class="mono" style="font-weight:700;">${esc(s.tool_called)}</span> — ${esc(s.output_summary)}</td>
            <td class="mono">${s.latency_ms >= 1000 ? `${(s.latency_ms / 1000).toFixed(1)}s` : `${s.latency_ms}ms`}</td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>

    <!-- Official Sign-Off Block -->
    <div class="sig-grid">
      <div class="sig-box">
        <div class="sig-role">Automated Telemetry Synthesis</div>
        <div class="sig-line">HydroSight AI Spatial Engine v1.0</div>
        <div class="mono" style="color:#475569;">sam-3.1 · muse-spark-1.3 · EPSG:32651</div>
      </div>
      <div class="sig-box">
        <div class="sig-role">Reviewed By (MDRRMO Duty Officer)</div>
        <div class="sig-line">Signature Over Printed Name / Date-Time</div>
        <div style="color:#475569;">Operations &amp; Warning Division</div>
      </div>
      <div class="sig-box">
        <div class="sig-role">Approved For Field Staging</div>
        <div class="sig-line">MDRRMO Incident Commander</div>
        <div style="color:#475569;">Municipality of Rodriguez, Rizal</div>
      </div>
    </div>

    <div class="doc-footer">
      <span><strong>LIMITATION NOTICE:</strong> Screening-level triage derived from 10 m resampled DEM ground-vs-WSE differentials and OpenStreetMap footprints. Verify depths on site before life-safety dispatch.</span>
      <span class="mono">${esc(docId)} · MDRRMO Flood Triage Brief</span>
    </div>
  </div>
</body>
</html>`;

    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, "_blank");
    if (!win) {
      const a = document.createElement("a");
      a.href = url;
      a.download = `${docId.toLowerCase()}.html`;
      a.click();
    }
  };

  return (
    <div className="workbench-split" style={{ alignItems: "stretch" }}>
      {/* Left Card: 4-Turn Autonomous State Machine Trace (Muse Spark 1.3 + SAM 3.1) */}
      <section className="panel-card" aria-label="Autonomous 4-turn spatial agent reasoning trace">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
            flexWrap: "wrap",
          }}
        >
          <div>
            <h2 style={{ fontSize: "15px", fontWeight: 600, margin: 0, color: "var(--text)" }}>
              Autonomous triage state machine
            </h2>
            <p style={{ margin: "2px 0 0 0", fontSize: "12.5px", color: "var(--muted)" }}>
              4-phase vision perception, DEM flood-fill, road graph routing & general area advisory
            </p>
          </div>
          <span className={`status-pill ${steps.length > 0 ? "positive" : triageLoading ? "warning" : "neutral"} num`}>
            {steps.length > 0
              ? `${steps.length} steps verified`
              : triageLoading
              ? `Executing phase ${triagePhaseIdx + 1} of 4...`
              : "Pipeline standby"}
          </span>
        </div>

        {steps.length === 0 ? (
          triageLoading || projectionLoading ? (
            <ol className="agent-step-list">
              {LIVE_AGENT_PREVIEW_STEPS.map((step, idx) => {
                const isDone = idx < triagePhaseIdx;
                const isCurrent = idx === triagePhaseIdx;
                return (
                  <li
                    key={step.step_number}
                    className="agent-step"
                    style={{ opacity: idx > triagePhaseIdx ? 0.5 : 1, transition: "opacity 0.2s ease-out" }}
                  >
                    <div className="agent-step-head">
                      <span className="agent-step-title">
                        <span className={`status-pill ${isDone ? "positive" : isCurrent ? "warning" : "neutral"} num`}>
                          Step {step.step_number}
                        </span>
                        <span className="agent-step-phase" style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                          {isDone ? (
                            <CheckCircle2 size={13} color="var(--positive)" />
                          ) : isCurrent ? (
                            <RefreshCw size={12} className="spin" color="var(--accent)" />
                          ) : null}
                          {step.phase}
                        </span>
                      </span>
                      <span className="agent-step-latency num">
                        {isDone ? "Verified" : isCurrent ? "In progress..." : "Queued"}
                      </span>
                    </div>
                    <p className="agent-step-model">{step.agent_model}</p>
                    <p className="agent-step-line">
                      <span className="agent-step-label">Decision</span>
                      <span className="mono-id">{step.tool_called}</span>
                    </p>
                    <div className="agent-step-line">
                      <span className="agent-step-label">Status</span>
                      <span>{step.outcome}</span>
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="agent-empty">
              Autonomous state machine standby. Click a point on photo or map to run triage.
            </p>
          )
        ) : (
          <ol className="agent-step-list">
            {steps.map((step) => {
              const traceParts =
                step.output_summary && /^\d+\. /.test(step.output_summary)
                  ? step.output_summary.split(/; (?=\d+\. )/)
                  : null;
              return (
                <li key={step.step_number} className="agent-step">
                  <div className="agent-step-head">
                    <span className="agent-step-title">
                      <span className="status-pill neutral num">Step {step.step_number}</span>
                      <span className="agent-step-phase">{step.phase}</span>
                    </span>
                    <span className="agent-step-latency num">{step.latency_ms >= 1000 ? `${(step.latency_ms / 1000).toFixed(1)} s` : `${step.latency_ms} ms`}</span>
                  </div>
                  <p className="agent-step-model">{step.agent_model}</p>
                  {step.tool_called && (
                    <p className="agent-step-line">
                      <span className="agent-step-label">Decision</span>
                      <span className="mono-id">{step.tool_called}</span>
                    </p>
                  )}
                  {step.input_summary && (
                    <p className="agent-step-line">
                      <span className="agent-step-label">Input</span>
                      <span>{step.input_summary}</span>
                    </p>
                  )}
                  <div className="agent-step-line">
                    <span className="agent-step-label">Outcome</span>
                    {traceParts ? (
                      <ol className="agent-trace-list">
                        {traceParts.map((part, i) => (
                          <li key={i}>{part.replace(/^\d+\. /, "")}</li>
                        ))}
                      </ol>
                    ) : (
                      <span>{step.output_summary}</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {/* Right Card: General Barangay Flood Advisory (no per-house dispatch) */}
      <section className="panel-card" aria-label="Barangay flood advisory and recommended actions">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
            flexWrap: "wrap",
          }}
        >
          <div>
            <h2 style={{ fontSize: "15px", fontWeight: 600, margin: 0, color: "var(--text)" }}>
              Barangay flood advisory — what to do
            </h2>
            <p style={{ margin: "2px 0 0 0", fontSize: "12.5px", color: "var(--muted)" }}>
              {advisory
                ? "General guidance for the whole affected area. No house-by-house rescue dispatch is issued."
                : triageLoading
                ? `Synthesizing Brgy. ${brgyName} advisory from WSE ${wseVal} m MSL footprint counts...`
                : "Area advisory standby — run triage to generate general guidance"}
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <span className={`status-pill ${!advisory ? (triageLoading ? "warning" : "neutral") : advisory.advisory_level === "SEVERE" ? "critical" : advisory.advisory_level === "LOW" ? "positive" : "warning"}`}>
              {advisory ? `Advisory: ${advisory.advisory_level}` : triageLoading ? "Synthesizing..." : "Standby"}
            </span>
          </div>
        </div>

        {!advisory ? (
          triageLoading || projectionLoading ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "12px", padding: "6px 0" }}>
              <div
                style={{
                  padding: "12px 14px",
                  borderRadius: "6px",
                  backgroundColor: "var(--raised)",
                  border: "1px solid var(--border)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", fontWeight: 600, color: "var(--text)" }}>
                  <RefreshCw size={14} className="spin" color="var(--accent)" />
                  <span>Preparing Brgy. {brgyName} Flood Advisory (WSE {wseVal} m MSL)</span>
                </div>
                <p style={{ margin: 0, fontSize: "12.5px", color: "var(--muted)", lineHeight: 1.45 }}>
                  Aggregating DEM depth-band structure counts, verifying dry evacuation center capacity, and formatting copyable resident & responder guidance.
                </p>
                {projSummary && (
                  <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "2px" }}>
                    <span className="status-pill neutral num" style={{ fontSize: "11.5px" }}>{projSummary.affected_structures} affected (Step 2 DEM)</span>
                    <span className="status-pill critical num" style={{ fontSize: "11.5px" }}>{projSummary.critical_depth_count} critical &gt;1.5 m</span>
                    <span className="status-pill warning num" style={{ fontSize: "11.5px" }}>{projSummary.medium_depth_count} medium 0.5–1.5 m</span>
                    <span className="status-pill neutral num" style={{ fontSize: "11.5px" }}>{projSummary.low_depth_count} low &lt;0.5 m</span>
                  </div>
                )}
              </div>

              <div
                style={{
                  padding: "10px 12px",
                  borderRadius: "6px",
                  backgroundColor: "var(--surface)",
                  border: "1px dashed var(--border-strong)",
                  fontSize: "12px",
                  color: "var(--muted)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                }}
              >
                <strong style={{ color: "var(--text)" }}>Incoming Advisory Sections:</strong>
                <span>• Nearest verified dry evacuation center & safe vehicle staging point</span>
                <span>• Compromised / flooded evacuation centers to avoid</span>
                <span>• Immediate resident safety checklist & responder street-sweep protocol</span>
              </div>
            </div>
          ) : (
            <p className="agent-empty">
              No advisory yet. Click a point on photo or map to run DEM flood projection and triage.
            </p>
          )
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <div>
              <strong style={{ fontSize: "13.5px", color: "var(--text)" }}>{advisory.headline}</strong>
              <p style={{ margin: "4px 0 0 0", fontSize: "12.5px", color: "var(--muted)", lineHeight: 1.45 }}>
                {advisory.summary_text}
              </p>
              {triageData?.inundated_structures?.wse_m != null && (
                <p className="num" style={{ margin: "4px 0 0 0", fontSize: "11.5px", color: "var(--muted)", lineHeight: 1.45 }}>
                  Counted at WSE {Number(triageData.inundated_structures.wse_m).toFixed(2)} m
                  {floodProjection?.water_surface_elev_m != null &&
                  Math.abs(Number(triageData.inundated_structures.wse_m) - Number(floodProjection.water_surface_elev_m)) > 0.02
                    ? ` — Step 3 re-checked the depth and changed the water level from the Step 2 projection (${Number(floodProjection.water_surface_elev_m).toFixed(2)} m), so building colours on this page are recoloured to match these counts and may differ from Step 2. See the Step 1 agent log.`
                    : " — same water level as the Step 2 projection, so these counts match the building colours."}
                </p>
              )}
            </div>

            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
              <span className="status-pill neutral num" style={{ fontSize: "11.5px" }}>{advisory.affected_structures} affected</span>
              <span className="status-pill critical num" style={{ fontSize: "11.5px" }}>{advisory.critical_depth_count} critical &gt;1.5 m</span>
              <span className="status-pill warning num" style={{ fontSize: "11.5px" }}>{advisory.medium_depth_count} medium 0.5–1.5 m</span>
              <span className="status-pill neutral num" style={{ fontSize: "11.5px" }}>{advisory.low_depth_count} low &lt;0.5 m</span>
              {advisory.affected_schools_count > 0 && (
                <span className="status-pill warning num" style={{ fontSize: "11.5px" }}>{advisory.affected_schools_count} school(s) affected</span>
              )}
              {advisory.affected_healthcare_count > 0 && (
                <span className="status-pill critical num" style={{ fontSize: "11.5px" }}>{advisory.affected_healthcare_count} health facility(ies) affected</span>
              )}
            </div>

            <div
              style={{
                padding: "8px 12px",
                borderRadius: "6px",
                backgroundColor: "var(--surface)",
                border: "1px solid var(--border)",
                fontSize: "12.5px",
                color: "var(--muted)",
                lineHeight: 1.45,
              }}
            >
              <strong style={{ color: "var(--text)" }}>Go to / staging point: </strong>
              {advisory.evacuation_center_name} · Vehicle staged there: {(advisory.vehicle_selected || "").replace(/_/g, " ")} ·
              Safe corridor <span className="num">{Math.round(advisory.route_distance_m)} m (~{Math.round(advisory.eta_minutes)} min)</span> ·{" "}
              <span className="num">{advisory.severed_segments_count} flooded road segment(s) to avoid</span>
              {advisory.compromised_evac_centers?.length > 0 && (
                <div style={{ color: "var(--negative)", fontWeight: 600, marginTop: "4px" }}>
                  Do NOT go to compromised centre(s): {advisory.compromised_evac_centers.join(", ")}
                </div>
              )}
            </div>

            {triageData?.evacuation_centers_status?.length > 0 && (
              <div>
                <h3 style={{ fontSize: "12.5px", fontWeight: 600, margin: "0 0 4px 0", color: "var(--text)" }}>
                  Evacuation centres nearest to this incident
                </h3>
                <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "4px" }}>
                  {triageData.evacuation_centers_status.map((c) => (
                    <li key={c.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", fontSize: "12.5px", color: "var(--muted)", flexWrap: "wrap" }}>
                      <span>
                        {c.name} <span className="num">· {Math.round(c.distance_m)} m away</span>
                      </span>
                      {c.is_selected ? (
                        <span className="status-pill positive" style={{ fontSize: "11px" }}>Selected — go here</span>
                      ) : c.flooded ? (
                        <span className="status-pill critical num" style={{ fontSize: "11px" }}>Flooded ~{Number(c.flood_depth_m).toFixed(1)} m — do not use</span>
                      ) : (
                        <span className="status-pill neutral" style={{ fontSize: "11px" }}>Dry</span>
                      )}
                    </li>
                  ))}
                </ul>
                <p style={{ margin: "4px 0 0 0", fontSize: "11.5px", color: "var(--muted)", lineHeight: 1.45 }}>
                  The selected centre is the nearest dry one at the counted water level. Nearer centres marked flooded are
                  skipped on purpose: their ground is below the water surface or inside the flood extent. This is why the
                  chosen centre can stay the same for nearby incidents in one cluster, and changes when you move area.
                </p>
              </div>
            )}

            <div>
              <h3 style={{ fontSize: "12.5px", fontWeight: 600, margin: "0 0 4px 0", color: "var(--text)" }}>Residents — do this now</h3>
              <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "12.5px", color: "var(--muted)", lineHeight: 1.5 }}>
                {advisory.resident_actions.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </div>

            <div>
              <h3 style={{ fontSize: "12.5px", fontWeight: 600, margin: "0 0 4px 0", color: "var(--text)" }}>Responders — general dispatch (area, not addresses)</h3>
              <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "12.5px", color: "var(--muted)", lineHeight: 1.5 }}>
                {advisory.responder_actions.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </div>

            <div>
              <h3 style={{ fontSize: "12.5px", fontWeight: 600, margin: "0 0 4px 0", color: "var(--text)" }}>Avoid</h3>
              <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "12.5px", color: "var(--muted)", lineHeight: 1.5 }}>
                {advisory.avoid_actions.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn-secondary"
                onClick={handleCopyAdvisory}
                style={{ fontSize: "12px", height: "30px" }}
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                <span>{copied ? "Advisory copied" : "Copy advisory for SMS / social media"}</span>
              </button>

              <button
                type="button"
                className="btn-primary"
                onClick={handleExportSituationReport}
                style={{ fontSize: "12px", height: "30px", padding: "0 14px" }}
                title="Generate printable MDRRMO Flood Triage Situation Report (PDF)"
              >
                <FileText size={12} />
                <span>Export Situation Report (PDF)</span>
              </button>
            </div>
          </div>
        )}

        {/* Operational Disclaimer: Screening-Level Emergency Triage */}
        <div
          style={{
            marginTop: "10px",
            padding: "8px 12px",
            borderRadius: "6px",
            backgroundColor: "var(--surface)",
            border: "1px solid var(--border)",
            fontSize: "12px",
            color: "var(--muted)",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            lineHeight: 1.4,
          }}
        >
          <Info size={14} color="var(--accent)" style={{ flexShrink: 0 }} />
          <span>
            <strong style={{ color: "var(--text)" }}>Operational Notice:</strong> General screening-level guidance derived from 10 m DEM ground-vs-WSE elevation differentials and aggregate footprint counts, not an official regulatory flood map and not a rescue order for any specific address.
          </span>
        </div>
      </section>
    </div>
  );
}
