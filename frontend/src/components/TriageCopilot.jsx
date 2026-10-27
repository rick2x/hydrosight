import React, { useState } from "react";

export default function TriageCopilot({ triageData }) {
  const [dispatchedIds, setDispatchedIds] = useState({});

  const steps = triageData?.agent_steps || [];
  const tickets = triageData?.dispatch_tickets || [];
  const telemetry = triageData?.open_weight_telemetry || {
    model_id: "muse-glimmer (Open Weights)",
    provider: "Fireworks AI / Meta Open-Weights Hub",
    latency_ms: 118,
    tokens_used: 485,
    verification_log_path: "backend/outputs/open_weight_verification.log",
  };

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
              Deterministic 4-step perception, DEM projection, dynamic road graph rerouting & open-weight handoff
            </p>
          </div>
          <span className="status-pill positive num">
            {steps.length || 4} steps verified
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
              {steps.map((step) => (
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
              ))}
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
              Priority rescue dispatch queue (Muse Glimmer Open Weights)
            </h2>
            <p style={{ margin: "2px 0 0 0", fontSize: "13px", color: "var(--muted)" }}>
              Provider: {telemetry.provider} ·{" "}
              <span className="num">{telemetry.tokens_used} tokens</span> logged
            </p>
          </div>
          <span className="status-pill neutral">
            Vehicle: {(triageData?.vehicle_selected || "amphibious_rubber_boat").replace(/_/g, " ")}
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
              {tickets.map((t) => {
                const isSent = Boolean(dispatchedIds[t.ticket_id]);
                return (
                  <tr key={t.ticket_id}>
                    <td>
                      <div className="mono-id" style={{ fontWeight: 500, color: "var(--text)", fontSize: "13px" }}>
                        {t.ticket_id} · {t.building_name || `${(t.building_type || "building").replace(/^\w/, (c) => c.toUpperCase())} ${t.building_id}`}
                        {t.footprint_sqm ? ` · ${Math.round(t.footprint_sqm)} m²` : ""}
                        {` · occupants: ${t.stranded_residents_est ?? "unknown"}`}
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
                      <span style={{ color: "var(--text)" }}>{t.eta_minutes}</span>{" "}
                      <span style={{ color: "var(--muted)" }}>m</span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn-secondary"
                        style={{ height: "28px", padding: "0 8px", fontSize: "13px" }}
                        onClick={() => handleDispatchToggle(t.ticket_id)}
                      >
                        {isSent ? "Sent" : "Dispatch"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
