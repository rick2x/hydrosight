import React, { useState } from "react";
import { AlertTriangle, School, HeartPulse, Landmark, Check, Send } from "lucide-react";

export default function TriageCopilot({ triageData, floodProjection, projectionLoading, triageLoading }) {
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
            <h2 style={{ fontSize: "15px", fontWeight: 600, margin: 0, color: "var(--text)" }}>
              Step 3 · Autonomous triage state machine (Muse Spark 1.3)
            </h2>
            <p style={{ margin: "2px 0 0 0", fontSize: "12.5px", color: "var(--muted)" }}>
              4-phase vision perception, DEM flood-fill, road graph routing & dispatch handoff
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
                <th style={{ width: "28%" }}>Phase & model</th>
                <th style={{ width: "56%" }}>Autonomous decision & outcome</th>
                <th className="num" style={{ width: "16%" }}>Latency</th>
              </tr>
            </thead>
            <tbody>
              {steps.length === 0 ? (
                <tr>
                  <td colSpan="3" style={{ textAlign: "center", color: "var(--muted)", padding: "28px 12px" }}>
                    {projectionLoading || triageLoading
                      ? "Autonomous spatial state machine running perception & DEM projection..."
                      : "Autonomous state machine standby. Click a point on photo or map to run triage."}
                  </td>
                </tr>
              ) : (
                steps.map((step) => (
                  <tr key={step.step_number}>
                    <td>
                      <div style={{ fontWeight: 500, color: "var(--text)", fontSize: "12.5px" }}>
                        {step.phase}
                      </div>
                      <div style={{ fontSize: "11.5px", color: "var(--muted)" }}>
                        {step.agent_model}
                      </div>
                    </td>
                    <td style={{ fontSize: "12.5px", color: "var(--muted)", lineHeight: 1.4 }}>
                      {step.output_summary}
                    </td>
                    <td className="num">
                      <span style={{ color: "var(--text)", fontWeight: 500 }}>{step.latency_ms}</span>{" "}
                      <span style={{ color: "var(--muted)", fontSize: "11.5px" }}>ms</span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Right Card: Priority Rescue Dispatch Tickets (Muse Spark Dispatcher) */}
      <section className="panel-card" aria-label="Priority rescue dispatch tickets">
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
              Step 3 · Priority rescue dispatch queue (Muse Spark Dispatcher)
            </h2>
            <p style={{ margin: "2px 0 0 0", fontSize: "12.5px", color: "var(--muted)" }}>
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
                <th style={{ width: "44%" }}>Ticket & directive</th>
                <th style={{ width: "16%" }}>Priority</th>
                <th className="num" style={{ width: "14%" }}>Depth</th>
                <th className="num" style={{ width: "12%" }}>ETA</th>
                <th style={{ width: "14%" }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {tickets.length === 0 ? (
                <tr>
                  <td colSpan="5" style={{ textAlign: "center", color: "var(--muted)", padding: "28px 12px" }}>
                    {projectionLoading || triageLoading
                      ? "Evaluating inundated footprints from spatial join and queuing dispatch tickets..."
                      : "No dispatch tickets queued. Click a point on photo or map to run DEM flood projection."}
                  </td>
                </tr>
              ) : (
                tickets.map((t) => {
                  const isSent = Boolean(dispatchedIds[t.ticket_id]);
                  return (
                    <tr key={t.ticket_id}>
                      <td>
                        <div style={{ fontWeight: 500, color: "var(--text)", fontSize: "12.5px", display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                          <span className="mono-id">{t.ticket_id}</span>
                          <span>· {t.building_name || `${(t.building_type || "building").replace(/^\w/, (c) => c.toUpperCase())} ${t.building_id}`}</span>
                          {t.is_evac_center && (
                            <span className="status-pill critical" style={{ fontSize: "10.5px", padding: "1px 5px", height: "18px" }}>
                              <AlertTriangle size={10} /> <span>EVAC CENTER</span>
                            </span>
                          )}
                          {t.infra_category === "education" && (
                            <span className="status-pill warning" style={{ fontSize: "10.5px", padding: "1px 5px", height: "18px" }}>
                              <School size={10} /> <span>School</span>
                            </span>
                          )}
                          {t.infra_category === "healthcare" && (
                            <span className="status-pill critical" style={{ fontSize: "10.5px", padding: "1px 5px", height: "18px" }}>
                              <HeartPulse size={10} /> <span>Clinic</span>
                            </span>
                          )}
                          {t.infra_category === "emergency_civic" && !t.is_evac_center && (
                            <span className="status-pill neutral" style={{ fontSize: "10.5px", padding: "1px 5px", height: "18px" }}>
                              <Landmark size={10} /> <span>Civic</span>
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: "12px", color: "var(--muted)", marginTop: "2px" }}>
                          {t.tactical_directive}
                        </div>
                      </td>
                      <td>
                        <span
                          className={`status-pill ${
                            t.priority === "CRITICAL" ? "critical" : "warning"
                          }`}
                          style={{ fontSize: "11px" }}
                        >
                          {t.priority}
                        </span>
                      </td>
                      <td className="num">
                        <span style={{ fontWeight: 500, color: "var(--text)" }}>
                          {t.flood_depth_m.toFixed(2)}
                        </span>{" "}
                        <span style={{ color: "var(--muted)", fontSize: "11.5px" }}>m</span>
                      </td>
                      <td className="num">
                        <span style={{ fontWeight: 500, color: "var(--text)" }}>
                          {t.eta_minutes}
                        </span>{" "}
                        <span style={{ color: "var(--muted)", fontSize: "11.5px" }}>min</span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className={isSent ? "btn-secondary" : "btn-primary"}
                          onClick={() => handleDispatchToggle(t.ticket_id)}
                          style={{
                            fontSize: "11.5px",
                            padding: "0 8px",
                            height: "28px",
                            width: "100%",
                            justifyContent: "center",
                            backgroundColor: isSent ? "var(--positive-soft)" : undefined,
                            borderColor: isSent ? "var(--positive-border)" : undefined,
                            color: isSent ? "var(--positive)" : undefined,
                          }}
                        >
                          {isSent ? <Check size={12} /> : <Send size={11} />}
                          <span>{isSent ? "Dispatched" : "Dispatch"}</span>
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
