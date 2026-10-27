import React, { useState } from "react";
import { AlertTriangle, School, HeartPulse, Landmark } from "lucide-react";

export default function TriageCopilot({ triageData, floodProjection }) {
  const [dispatchedIds, setDispatchedIds] = useState({});

  const steps = triageData?.agent_steps || [];
  const tickets = triageData?.dispatch_tickets || [];
  const telemetry = triageData?.open_weight_telemetry || null;

  const handleDispatchToggle = (ticketId) => {
    setDispatchedIds((prev) => ({
      ...prev,
      [ticketId]: !prev[ticketId],
    }));
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
            <h2 style={{ fontSize: "16px", fontWeight: 600, margin: 0, color: "var(--text)" }}>
              Autonomous triage state machine (Muse Spark 1.3)
            </h2>
            <p style={{ margin: "2px 0 0 0", fontSize: "13px", color: "var(--muted)" }}>
              Deterministic 4-step perception, DEM projection, dynamic road graph rerouting & incident dispatch handoff
            </p>
          </div>
          <span className={`status-pill ${steps.length > 0 ? "positive" : "neutral"} num`}>
            {steps.length > 0 ? `${steps.length} steps verified` : "Pipeline standby"}
          </span>
        </div>

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: "26%" }}>Phase & model</th>
                <th style={{ width: "58%" }}>Autonomous decision & outcome</th>
                <th className="num" style={{ width: "16%" }}>Latency</th>
              </tr>
            </thead>
            <tbody>
              {steps.length === 0 ? (
                <tr>
                  <td colSpan="3" style={{ textAlign: "center", color: "var(--muted)", padding: "28px 12px" }}>
                    Autonomous spatial state machine standby. Running live perception & DEM projection...
                  </td>
                </tr>
              ) : (
                steps.map((step) => (
                  <tr key={step.step_number}>
                    <td>
                      <div style={{ fontWeight: 500, color: "var(--text)", fontSize: "13px" }}>
                        {step.phase}
                      </div>
                      <div style={{ fontSize: "13px", color: "var(--muted)" }}>
                        {step.agent_model}
                      </div>
                    </td>
                    <td style={{ fontSize: "13px", color: "var(--muted)" }}>
                      {step.output_summary}
                    </td>
                    <td className="num">
                      <span style={{ color: "var(--text)" }}>{step.latency_ms}</span>{" "}
                      <span style={{ color: "var(--muted)" }}>ms</span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Right Card: Priority Rescue Dispatch Tickets (Muse Glimmer Open Weights) */}
      <section className="panel-card" aria-label="Muse Glimmer priority rescue dispatch tickets">
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
            <h2 style={{ fontSize: "16px", fontWeight: 600, margin: 0, color: "var(--text)" }}>
              Priority rescue dispatch queue (Muse Spark Dispatcher)
            </h2>
            <p style={{ margin: "2px 0 0 0", fontSize: "13px", color: "var(--muted)" }}>
              {telemetry ? (
                <>Provider: {telemetry.provider} · <span className="num">{telemetry.tokens_used} tokens</span> logged</>
              ) : (
                "Multi-agent dispatch handoff standby"
              )}
            </p>
          </div>
          <span className="status-pill neutral">
            Vehicle: {(triageData?.vehicle_selected || "Standby").replace(/_/g, " ")}
          </span>
        </div>

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: "42%" }}>Ticket & directive</th>
                <th style={{ width: "16%" }}>Priority</th>
                <th className="num" style={{ width: "16%" }}>Depth</th>
                <th className="num" style={{ width: "12%" }}>ETA</th>
                <th style={{ width: "14%" }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {tickets.length === 0 ? (
                <tr>
                  <td colSpan="5" style={{ textAlign: "center", color: "var(--muted)", padding: "28px 12px" }}>
                    No dispatch tickets queued. Evaluating inundated footprints from spatial join...
                  </td>
                </tr>
              ) : (
                tickets.map((t) => {
                  const isSent = Boolean(dispatchedIds[t.ticket_id]);
                  return (
                    <tr key={t.ticket_id}>
                      <td>
                        <div className="mono-id" style={{ fontWeight: 500, color: "var(--text)", fontSize: "13px", display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                          <span>{t.ticket_id} · {t.building_name || `${(t.building_type || "building").replace(/^\w/, (c) => c.toUpperCase())} ${t.building_id}`}</span>
                          {t.is_evac_center && (
                            <span className="status-pill critical" style={{ fontSize: "11px", padding: "1px 6px" }}>
                              <AlertTriangle size={11} /> <span>EVAC CENTER</span>
                            </span>
                          )}
                          {t.infra_category === "education" && (
                            <span className="status-pill warning" style={{ fontSize: "11px", padding: "1px 6px" }}>
                              <School size={11} /> <span>School</span>
                            </span>
                          )}
                          {t.infra_category === "healthcare" && (
                            <span className="status-pill critical" style={{ fontSize: "11px", padding: "1px 6px" }}>
                              <HeartPulse size={11} /> <span>Clinic</span>
                            </span>
                          )}
                          {t.infra_category === "emergency_civic" && !t.is_evac_center && (
                            <span className="status-pill neutral" style={{ fontSize: "11px", padding: "1px 6px" }}>
                              <Landmark size={11} /> <span>Civic</span>
                            </span>
                          )}
                          {t.footprint_sqm ? <span style={{ color: "var(--muted)" }}>· {Math.round(t.footprint_sqm)} m²</span> : ""}
                          <span style={{ color: "var(--muted)" }}>· occupants: {t.stranded_residents_est ?? "unknown"}</span>
                        </div>
                        <div style={{ fontSize: "13px", color: "var(--muted)" }}>
                          {t.tactical_directive}
                        </div>
                      </td>
                      <td>
                        <span
                          className={`status-pill ${
                            t.priority === "CRITICAL" ? "critical" : "warning"
                          }`}
                        >
                          {t.priority}
                        </span>
                      </td>
                      <td className="num">
                        <span style={{ fontWeight: 500, color: "var(--text)" }}>
                          {t.flood_depth_m.toFixed(2)}
                        </span>{" "}
                        <span style={{ color: "var(--muted)" }}>m</span>
                      </td>
                      <td className="num">
                        <span style={{ fontWeight: 500, color: "var(--text)" }}>
                          {t.eta_minutes}
                        </span>{" "}
                        <span style={{ color: "var(--muted)" }}>min</span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className={isSent ? "btn-secondary" : "btn-primary"}
                          onClick={() => handleDispatchToggle(t.ticket_id)}
                          style={{
                            fontSize: "12px",
                            padding: "4px 10px",
                            minHeight: "28px",
                            width: "100%",
                          }}
                        >
                          {isSent ? "Dispatched" : "Dispatch"}
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
