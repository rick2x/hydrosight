import React, { useState } from "react";
import { Check, Copy, Info } from "lucide-react";

export default function TriageCopilot({ triageData, floodProjection, projectionLoading, triageLoading }) {
  const [copied, setCopied] = useState(false);

  const steps = triageData?.agent_steps || [];
  const advisory = triageData?.area_advisory || null;

  const handleCopyAdvisory = () => {
    if (!advisory?.copyable_text) return;
    navigator.clipboard?.writeText(advisory.copyable_text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
          <span className={`status-pill ${steps.length > 0 ? "positive" : "neutral"} num`}>
            {steps.length > 0 ? `${steps.length} steps verified` : "Pipeline standby"}
          </span>
        </div>

        {steps.length === 0 ? (
          <p className="agent-empty">
            {projectionLoading || triageLoading
              ? "Autonomous spatial state machine running perception & DEM projection..."
              : "Autonomous state machine standby. Click a point on photo or map to run triage."}
          </p>
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
                : "Area advisory standby — run triage to generate general guidance"}
            </p>
          </div>
          <span className={`status-pill ${!advisory ? "neutral" : advisory.advisory_level === "SEVERE" ? "critical" : advisory.advisory_level === "LOW" ? "positive" : "warning"}`}>
            {advisory ? `Advisory: ${advisory.advisory_level}` : "Standby"}
          </span>
        </div>

        {!advisory ? (
          <p className="agent-empty">
            {projectionLoading || triageLoading
              ? "Building the area advisory from aggregate DEM depth-band counts..."
              : "No advisory yet. Click a point on photo or map to run DEM flood projection and triage."}
          </p>
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

            <button
              type="button"
              className="btn-secondary"
              onClick={handleCopyAdvisory}
              style={{ fontSize: "12px", height: "30px", alignSelf: "flex-start" }}
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              <span>{copied ? "Advisory copied" : "Copy advisory for SMS / social media"}</span>
            </button>
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
