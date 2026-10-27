import React, { useState, useRef } from "react";
import { Upload, Crosshair, AlertTriangle, Copy, Check, RefreshCw } from "lucide-react";

const MASK_STROKES = {
  floodwater: { stroke: "#1b6c80", fill: "rgba(27, 108, 128, 0.24)" },
  person: { stroke: "#c4242a", fill: "rgba(196, 36, 42, 0.18)" },
  tricycle: { stroke: "#c4242a", fill: "rgba(196, 36, 42, 0.18)" },
  car: { stroke: "#c4242a", fill: "rgba(196, 36, 42, 0.18)" },
  "vehicle wheel": { stroke: "#a86f0c", fill: "rgba(168, 111, 12, 0.20)" },
  gate: { stroke: "#2f70bb", fill: "rgba(47, 112, 187, 0.16)" },
  "building entrance": { stroke: "#2f70bb", fill: "rgba(47, 112, 187, 0.16)" },
  "utility pole": { stroke: "#1e7b4f", fill: "rgba(30, 123, 79, 0.20)" },
};

export default function PhotoInspector({
  scenario,
  analysisResult,
  cameraParams,
  onUpdateCameraParams,
  onPhotoClickTarget,
  onUploadCustomPhoto,
  photoUploading,
  photoUploadError,
  customPhotoPreview,
  onResetCustomPhoto,
  onSimulateSurge,
  surgeResult,
  surgeLoading,
}) {
  const [showMasks, setShowMasks] = useState(true);
  const [compareSlider, setCompareSlider] = useState(50);
  const [copiedSms, setCopiedSms] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [imgAspect, setImgAspect] = useState(16 / 9);
  const innerStageRef = useRef(null);
  const fileInputRef = useRef(null);

  const masks = analysisResult?.masks || scenario?.sam_masks || [];
  const gauge = analysisResult?.visual_gauge || scenario?.visual_gauge || {};
  const photoUrl =
    customPhotoPreview ||
    analysisResult?.photo_url ||
    scenario?.photo_url ||
    "/static/photos/kasiglahan_village.jpg";

  const angleOffsetDeg = ((cameraParams.click_u - 0.5) * cameraParams.fov_deg).toFixed(1);
  const targetBearingDeg = (
    (cameraParams.azimuth_deg + (cameraParams.click_u - 0.5) * cameraParams.fov_deg + 360) %
    360
  ).toFixed(1);

  const handleImageClick = (e) => {
    if (!innerStageRef.current) return;
    const rect = innerStageRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const u = Math.max(0.02, Math.min(0.98, (e.clientX - rect.left) / rect.width));
    const v = Math.max(0.05, Math.min(0.95, (e.clientY - rect.top) / rect.height));
    onPhotoClickTarget(Number(u.toFixed(3)), Number(v.toFixed(3)));
  };

  const handleFileChange = (e) => {
    const selected = e.target.files?.[0];
    if (selected) {
      onUploadCustomPhoto(selected);
    }
    e.target.value = "";
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const droppedFile = e.dataTransfer?.files?.[0];
    if (droppedFile && droppedFile.type.startsWith("image/")) {
      onUploadCustomPhoto(droppedFile);
    }
  };

  const handleCopyAlert = () => {
    if (!surgeResult?.sms_broadcast_text) return;
    navigator.clipboard?.writeText(surgeResult.sms_broadcast_text);
    setCopiedSms(true);
    setTimeout(() => setCopiedSms(false), 2000);
  };

  return (
    <section className="panel-card" aria-label="Street photo perception and visual gauge">
      {/* Header Row */}
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
            Street-level visual gauge (SAM 3.1 + Muse Spark 1.3)
          </h2>
          <p style={{ margin: "2px 0 0 0", fontSize: "13px", color: "var(--muted)" }}>
            Upload or drop any flood photo, or click the waterline to cast a 3D ray onto the 10 m DEM
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setShowMasks((prev) => !prev)}
          >
            {showMasks ? "Hide SAM 3.1 masks" : "Show SAM 3.1 masks"}
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={handleFileChange}
          />
          <button
            type="button"
            className="btn-primary"
            disabled={photoUploading}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={14} />
            {photoUploading ? "Analyzing photo..." : "Upload flood photo"}
          </button>

          {customPhotoPreview && (
            <button
              type="button"
              className="btn-secondary"
              onClick={onResetCustomPhoto}
              title="Restore default sector camera feed"
            >
              <RefreshCw size={13} />
              Reset feed
            </button>
          )}
        </div>
      </div>

      {photoUploadError && (
        <div
          style={{
            padding: "8px 12px",
            borderRadius: "6px",
            backgroundColor: "var(--pill-critical-bg)",
            color: "var(--pill-critical-ink)",
            fontSize: "13px",
          }}
        >
          {photoUploadError}
        </div>
      )}

      {/* Outer Frame supporting both landscape (16:9) and portrait (9:16) photos without cropping */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        style={{
          position: "relative",
          width: "100%",
          borderRadius: "6px",
          overflow: "hidden",
          border: dragActive ? "2px dashed #1b6c80" : "1px solid var(--border)",
          backgroundColor: "#eef2f5",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          userSelect: "none",
        }}
      >
        {/* Exact-Aspect-Ratio Inner Stage so SAM 3.1 normalized [0..1] boxes never shift or crop */}
        <div
          ref={innerStageRef}
          onClick={handleImageClick}
          role="button"
          tabIndex={0}
          aria-label="Street flood photo target selector. Click to set horizontal ray position u or drop an image file."
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") {
              onPhotoClickTarget(Math.max(0.05, Number((cameraParams.click_u - 0.05).toFixed(2))), cameraParams.click_v);
            } else if (e.key === "ArrowRight") {
              onPhotoClickTarget(Math.min(0.95, Number((cameraParams.click_u + 0.05).toFixed(2))), cameraParams.click_v);
            }
          }}
          style={{
            position: "relative",
            aspectRatio: `${imgAspect}`,
            maxHeight: "420px",
            maxWidth: "100%",
            width: imgAspect >= 1.2 ? "100%" : "auto",
            cursor: "crosshair",
          }}
        >
          <img
            src={photoUrl}
            alt={scenario?.name || "Rodriguez street flood photo"}
            onLoad={(e) => {
              const nw = e.currentTarget.naturalWidth;
              const nh = e.currentTarget.naturalHeight;
              if (nw > 0 && nh > 0) {
                setImgAspect(Number((nw / nh).toFixed(4)));
              }
            }}
            style={{
              width: "100%",
              height: "100%",
              display: "block",
            }}
          />

          {/* Optional Side-by-Side +1.5m Typhoon Surge Forecast Overlay (Muse Image 1.0) */}
          {surgeResult && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                clipPath: `inset(0 0 0 ${compareSlider}%)`,
                pointerEvents: "none",
              }}
            >
              <img
                src={surgeResult.surge_forecast_image_url}
                alt="Muse Image +1.5m typhoon surge visual forecast"
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                  display: "block",
                }}
              />
            </div>
          )}

          {/* SVG Overlay for SAM 3.1 Polygons, Bounding Boxes, and Ray Reticle */}
          <svg
            viewBox="0 0 1000 562.5"
            preserveAspectRatio="none"
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              pointerEvents: "none",
            }}
          >
            {showMasks &&
              masks.map((m) => {
                const style = MASK_STROKES[m.concept] || {
                  stroke: "#1b6c80",
                  fill: "rgba(27, 108, 128, 0.2)",
                };
                const pts = (m.polygon_norm || [])
                  .map(([u, v]) => `${(u * 1000).toFixed(1)},${(v * 562.5).toFixed(1)}`)
                  .join(" ");
                const [bx1, by1, bx2, by2] = m.bbox_norm || [0.4, 0.4, 0.6, 0.6];
                return (
                  <g key={m.id}>
                    {pts && (
                      <polygon
                        points={pts}
                        fill={style.fill}
                        stroke={style.stroke}
                        strokeWidth="2.5"
                      />
                    )}
                    <rect
                      x={bx1 * 1000}
                      y={by1 * 562.5}
                      width={(bx2 - bx1) * 1000}
                      height={(by2 - by1) * 562.5}
                      fill="none"
                      stroke={style.stroke}
                      strokeWidth="1.5"
                      strokeDasharray="5,3"
                    />
                    <rect
                      x={bx1 * 1000}
                      y={Math.max(4, by1 * 562.5 - 24)}
                      width={Math.min(240, (m.concept.length + 10) * 8.5)}
                      height="22"
                      fill="#131416"
                      rx="3"
                    />
                    <text
                      x={bx1 * 1000 + 6}
                      y={Math.max(19, by1 * 562.5 - 9)}
                      fill="#ffffff"
                      fontSize="13"
                      fontFamily="IBM Plex Sans, sans-serif"
                      fontWeight="500"
                    >
                      {m.concept} · {Math.round((m.confidence || 0.9) * 100)}%
                    </text>
                  </g>
                );
              })}

            {/* Vertical Ray Bearing Indicator Line at click_u */}
            <line
              x1={cameraParams.click_u * 1000}
              y1={0}
              x2={cameraParams.click_u * 1000}
              y2={562.5}
              stroke="#131416"
              strokeWidth="2"
              strokeDasharray="4,4"
            />

            {/* Target Waterline Click Crosshair */}
            <circle
              cx={cameraParams.click_u * 1000}
              cy={cameraParams.click_v * 562.5}
              r="11"
              fill="rgba(255, 255, 255, 0.88)"
              stroke="#c4242a"
              strokeWidth="2.5"
            />
            <circle
              cx={cameraParams.click_u * 1000}
              cy={cameraParams.click_v * 562.5}
              r="3.5"
              fill="#c4242a"
            />
          </svg>
        </div>

        {photoUploading && (
          <div
            style={{
              position: "absolute",
              top: "10px",
              right: "10px",
              backgroundColor: "rgba(19, 20, 22, 0.88)",
              color: "#ffffff",
              padding: "6px 10px",
              borderRadius: "4px",
              fontSize: "13px",
              fontWeight: 500,
            }}
          >
            Running SAM 3.1 + Muse Spark 1.3 on uploaded photo...
          </div>
        )}

        {/* Bottom HUD Telemetry Strip */}
        <div
          style={{
            position: "absolute",
            left: "10px",
            bottom: "10px",
            backgroundColor: "rgba(255, 255, 255, 0.94)",
            border: "1px solid var(--border)",
            borderRadius: "4px",
            padding: "4px 8px",
            fontSize: "13px",
            color: "var(--text)",
            display: "flex",
            alignItems: "center",
            gap: "10px",
            flexWrap: "wrap",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontWeight: 500 }}>
            <Crosshair size={13} />
            Ray target u = <span className="mono-id">{cameraParams.click_u.toFixed(2)}</span>
          </span>
          <span style={{ color: "var(--muted)" }}>
            Δθ = <span className="num">{angleOffsetDeg}°</span>
          </span>
          <span style={{ color: "var(--muted)" }}>
            Bearing = <span className="num">{targetBearingDeg}°</span>
          </span>
          {customPhotoPreview && (
            <span className="status-pill positive">Custom uploaded photo active</span>
          )}
        </div>
      </div>

      {/* Camera Frustum & Hydrological Override Sliders */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
          gap: "12px",
          padding: "12px",
          backgroundColor: "var(--raised)",
          borderRadius: "6px",
          border: "1px solid var(--border)",
        }}
      >
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", marginBottom: "4px" }}>
            <label htmlFor="slider-azimuth" style={{ fontWeight: 500, color: "var(--text)" }}>
              Camera azimuth
            </label>
            <span className="num" style={{ color: "var(--muted)" }}>
              {cameraParams.azimuth_deg}°
            </span>
          </div>
          <input
            id="slider-azimuth"
            type="range"
            min="0"
            max="360"
            step="1"
            value={cameraParams.azimuth_deg}
            onChange={(e) => onUpdateCameraParams({ azimuth_deg: Number(e.target.value) })}
            style={{ width: "100%" }}
          />
        </div>

        <div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", marginBottom: "4px" }}>
            <label htmlFor="slider-fov" style={{ fontWeight: 500, color: "var(--text)" }}>
              Horizontal FOV
            </label>
            <span className="num" style={{ color: "var(--muted)" }}>
              {cameraParams.fov_deg}°
            </span>
          </div>
          <input
            id="slider-fov"
            type="range"
            min="40"
            max="90"
            step="1"
            value={cameraParams.fov_deg}
            onChange={(e) => onUpdateCameraParams({ fov_deg: Number(e.target.value) })}
            style={{ width: "100%" }}
          />
        </div>

        <div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", marginBottom: "4px" }}>
            <label htmlFor="slider-depth" style={{ fontWeight: 500, color: "var(--text)" }}>
              Water depth
            </label>
            <span className="num" style={{ color: "var(--text)", fontWeight: 600 }}>
              {cameraParams.water_depth_m.toFixed(2)} m
            </span>
          </div>
          <input
            id="slider-depth"
            type="range"
            min="0.2"
            max="3.5"
            step="0.05"
            value={cameraParams.water_depth_m}
            onChange={(e) => onUpdateCameraParams({ water_depth_m: Number(e.target.value) })}
            style={{ width: "100%" }}
          />
        </div>
      </div>

      {/* Muse Spark 1.3 Hydrological Reasoning & Scale Reference Breakdown */}
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: "6px",
          padding: "12px",
          display: "flex",
          flexDirection: "column",
          gap: "8px",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <span style={{ fontSize: "14px", fontWeight: 600, color: "var(--text)" }}>
            Scale reference: {gauge.reference_object_detected || "Submerged Tricycle & Gate"}
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <span className="status-pill neutral num">
              Std height {(gauge.reference_standard_height_m ?? 1.65).toFixed(2)} m
            </span>
            <span className="status-pill warning num">
              Submerged {Math.round((gauge.submerged_ratio ?? 0.82) * 100)}%
            </span>
            <span className="status-pill positive num">
              Confidence {Math.round((gauge.confidence_score ?? 0.91) * 100)}%
            </span>
          </div>
        </div>

        <p style={{ margin: 0, fontSize: "13px", color: "var(--muted)" }}>
          {gauge.hydrological_reasoning}
        </p>

        {/* Section 9.3 Bonus Prize Feature: Muse Image / Wonder +1.5m Typhoon Surge Simulator */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
            paddingTop: "8px",
            borderTop: "1px solid var(--rule)",
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            className="btn-secondary"
            onClick={onSimulateSurge}
            disabled={surgeLoading}
          >
            <AlertTriangle size={14} />
            {surgeLoading
              ? "Generating +1.5m surge (Muse Image)..."
              : "Simulate +1.5m Typhoon Surge (Muse Image)"}
          </button>

          {surgeResult && (
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flex: 1, minWidth: "180px" }}>
              <label htmlFor="surge-compare" style={{ fontSize: "13px", color: "var(--muted)", whiteSpace: "nowrap" }}>
                Current vs +1.5m surge
              </label>
              <input
                id="surge-compare"
                type="range"
                min="0"
                max="100"
                value={compareSlider}
                onChange={(e) => setCompareSlider(Number(e.target.value))}
                style={{ flex: 1 }}
              />
            </div>
          )}
        </div>

        {surgeResult && (
          <div
            style={{
              backgroundColor: "var(--pill-warning-bg)",
              border: "1px solid #fde68a",
              borderRadius: "6px",
              padding: "10px 12px",
              display: "flex",
              flexDirection: "column",
              gap: "6px",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <strong style={{ fontSize: "13px", color: "var(--pill-warning-ink)" }}>
                {surgeResult.alert_headline}
              </strong>
              <button type="button" className="btn-secondary" onClick={handleCopyAlert}>
                {copiedSms ? <Check size={13} /> : <Copy size={13} />}
                {copiedSms ? "Copied SMS alert" : "Copy SMS evacuation card"}
              </button>
            </div>
            <p style={{ margin: 0, fontSize: "13px", color: "var(--pill-warning-ink)" }}>
              {surgeResult.sms_broadcast_text}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
