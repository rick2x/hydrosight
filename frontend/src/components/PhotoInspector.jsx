import React, { useState, useRef, useEffect } from "react";
import { Upload, Crosshair, RefreshCw, Eye, EyeOff, Trash2, Waves } from "lucide-react";
import { formatNumber, uncertaintyBand } from "../utils/format";

const MASK_STROKES = {
  floodwater: { stroke: "#0e7490", fill: "rgba(14, 116, 144, 0.22)" },
  person: { stroke: "#b91c1c", fill: "rgba(185, 28, 28, 0.18)" },
  tricycle: { stroke: "#b91c1c", fill: "rgba(185, 28, 28, 0.18)" },
  car: { stroke: "#b91c1c", fill: "rgba(185, 28, 28, 0.18)" },
  "vehicle wheel": { stroke: "#b45309", fill: "rgba(180, 83, 9, 0.20)" },
  gate: { stroke: "#2f70bb", fill: "rgba(47, 112, 187, 0.18)" },
  "building entrance": { stroke: "#2f70bb", fill: "rgba(47, 112, 187, 0.18)" },
  "utility pole": { stroke: "#15803d", fill: "rgba(21, 128, 61, 0.20)" },
};

export default function PhotoInspector({
  analysisResult,
  cameraParams,
  onUpdateCameraParams,
  onPhotoClickTarget,
  onUploadCustomPhoto,
  photoUploading,
  photoUploadError,
  geotagNotice,
  customPhotoPreview,
  onResetCustomPhoto,
  onDeleteCustomPhoto,
  floodProjection,
  projectionLoading,
}) {
  const [showMasks, setShowMasks] = useState(true);
  const [dragActive, setDragActive] = useState(false);
  const [imgAspect, setImgAspect] = useState(16 / 9);

  const SCAN_STAGES = ["Segmenting floodwater", "Locating scale reference", "Gauging water depth"];
  const [scanStage, setScanStage] = useState(0);
  useEffect(() => {
    if (!photoUploading) {
      setScanStage(0);
      return undefined;
    }
    const id = setInterval(() => setScanStage((s) => Math.min(SCAN_STAGES.length - 1, s + 1)), 2800);
    return () => clearInterval(id);
  }, [photoUploading]);
  const innerStageRef = useRef(null);
  const fileInputRef = useRef(null);

  const isCustomPhoto = Boolean(customPhotoPreview || analysisResult?.is_custom_upload);

  const handleDeletePhoto = () => {
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (onDeleteCustomPhoto) {
      onDeleteCustomPhoto();
    } else if (onResetCustomPhoto) {
      onResetCustomPhoto();
    }
  };

  const masks = photoUploading ? [] : (analysisResult?.masks || []);
  const gauge = photoUploading ? {} : (analysisResult?.visual_gauge || {});
  const photoUrl = customPhotoPreview || analysisResult?.photo_url || null;

  // The basis is the first non-water reference object named by the gauge
  const basisConcept = (
    masks.find(
      (m) =>
        m.concept !== "floodwater" &&
        (gauge.reference_object_detected || "").toLowerCase().includes(m.concept.toLowerCase())
    ) || {}
  ).concept;
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
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <h2 style={{ fontSize: "15px", fontWeight: 600, margin: 0, color: "var(--text)" }}>
              Step 1 · Street-level perception (SAM 3.1 + Muse Spark 1.3)
            </h2>
            {isCustomPhoto ? (
              <span className="status-badge status-warning">
                Custom photo
              </span>
            ) : photoUrl ? (
              <span className="status-badge status-neutral">
                Photo loaded
              </span>
            ) : (
              <span className="status-badge status-neutral">
                Standby · No photo
              </span>
            )}
          </div>
          <p style={{ margin: "2px 0 0 0", fontSize: "12.5px", color: "var(--muted)" }}>
            {isCustomPhoto
              ? "Custom photo active · Click waterline to cast 3D ray onto 10 m DEM"
              : photoUrl
              ? "Photo loaded · Click waterline to cast 3D ray onto 10 m DEM"
              : "Upload or drop a street flood photo to begin vision perception"}
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          {photoUrl && !photoUploading && masks.length > 0 && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setShowMasks((prev) => !prev)}
              style={{ fontSize: "12px", padding: "0 10px" }}
            >
              {showMasks ? <EyeOff size={13} /> : <Eye size={13} />}
              <span>{showMasks ? "Hide masks" : "Show masks"}</span>
            </button>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={handleFileChange}
          />
          <button
            type="button"
            className="btn-secondary"
            disabled={photoUploading}
            onClick={() => fileInputRef.current?.click()}
            style={{ fontSize: "12px", padding: "0 10px" }}
          >
            <Upload size={13} />
            <span>{photoUploading ? "Analyzing..." : "Upload photo"}</span>
          </button>

          
          {photoUrl && (
            <button
              type="button"
              className="btn-secondary"
              onClick={handleDeletePhoto}
              title={isCustomPhoto ? "Delete uploaded photo and return to empty state" : "Clear sample photo and return to empty state"}
              style={{
                fontSize: "12px",
                padding: "0 10px",
                color: isCustomPhoto ? "var(--negative)" : "var(--muted)",
                borderColor: isCustomPhoto ? "var(--negative-border)" : "var(--border)",
                backgroundColor: isCustomPhoto ? "var(--negative-soft)" : "transparent",
              }}
            >
              <Trash2 size={13} color={isCustomPhoto ? "var(--negative)" : "currentColor"} />
              <span>{isCustomPhoto ? "Delete photo" : "Clear photo"}</span>
            </button>
          )}
        </div>
      </div>

      {geotagNotice && !photoUploadError && (
        <div
          style={{
            padding: "8px 12px",
            borderRadius: "6px",
            backgroundColor: "var(--surface)",
            color: "var(--muted)",
            border: "1px solid var(--border)",
            fontSize: "12.5px",
            lineHeight: 1.45,
          }}
        >
          <strong style={{ color: "var(--text)" }}>Photo location: </strong>
          {geotagNotice}
        </div>
      )}

      {photoUploadError && (
        <div
          style={{
            padding: "8px 12px",
            borderRadius: "6px",
            backgroundColor: "var(--negative-soft)",
            color: "var(--negative)",
            border: "1px solid var(--negative-border)",
            fontSize: "12.5px",
          }}
        >
          {photoUploadError}
        </div>
      )}

      {/* Photo Frame or Empty Dropzone */}
      {!photoUrl ? (
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
            minHeight: "360px",
            borderRadius: "6px",
            border: dragActive ? "2px dashed var(--accent)" : "1px dashed var(--border-strong)",
            backgroundColor: dragActive ? "var(--accent-soft)" : "var(--surface)",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            padding: "36px 20px",
            textAlign: "center",
            userSelect: "none",
            gap: "14px",
          }}
        >
          <div
            style={{
              width: "48px",
              height: "48px",
              borderRadius: "50%",
              backgroundColor: "var(--active)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--muted)",
            }}
          >
            <Upload size={22} />
          </div>

          <div>
            <h3 style={{ margin: "0 0 4px 0", fontSize: "15px", fontWeight: 600, color: "var(--text)" }}>
              No street photo loaded
            </h3>
            <p style={{ margin: 0, fontSize: "13px", color: "var(--muted)", maxWidth: "380px" }}>
              Upload or drop a street flood photograph to detect waterlines with SAM 3.1, sample the 10 m DEM, and calculate evacuation triage.
            </p>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", justifyContent: "center" }}>
            <button
              type="button"
              className="btn-primary"
              disabled={photoUploading}
              onClick={() => fileInputRef.current?.click()}
              style={{ fontSize: "12.5px", padding: "0 16px" }}
            >
              <Upload size={13} />
              <span>{photoUploading ? "Analyzing photo..." : "Upload flood photo"}</span>
            </button>

                      </div>
        </div>
      ) : (
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
            border: dragActive ? "2px dashed var(--accent)" : "1px solid var(--border)",
            backgroundColor: "#eef2f5",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            userSelect: "none",
          }}
        >
        <div
          ref={innerStageRef}
          onClick={handleImageClick}
          role="button"
          tabIndex={0}
          aria-label="Street flood photo target selector. Click to set horizontal ray position u."
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
            maxHeight: "480px",
            maxWidth: "100%",
            width: imgAspect >= 1.2 ? "100%" : "auto",
            cursor: "crosshair",
          }}
        >
          <img
            src={photoUrl}
            alt="Rodriguez street flood photo"
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

          {/* Photo perception analyzing: hydro scan overlay */}
          {photoUploading && (
            <>
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  background: "rgba(15, 23, 42, 0.10)",
                  pointerEvents: "none",
                  zIndex: 5,
                }}
              />
              <div
                className="hydro-scanline"
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  height: "2px",
                  background: "var(--accent)",
                  boxShadow: "none",
                  pointerEvents: "none",
                  zIndex: 6,
                }}
              />
              <div
                role="status"
                aria-label="Analyzing flood photo with SAM 3.1 and Muse Spark"
                style={{
                  position: "absolute",
                  top: "12px",
                  left: "50%",
                  transform: "translateX(-50%)",
                  width: "min(430px, calc(100% - 24px))",
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-card)",
                  boxShadow: "none",
                  padding: "10px 12px",
                  pointerEvents: "none",
                  zIndex: 7,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <span style={{ position: "relative", width: "32px", height: "32px", flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                    <span className="hydro-pulse-ring" style={{ position: "absolute", inset: 0, borderRadius: "50%", border: "1.5px solid var(--accent)" }} />
                    <span style={{ width: "32px", height: "32px", borderRadius: "50%", backgroundColor: "var(--accent-soft)", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                      <Waves size={16} color="var(--accent)" />
                    </span>
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block", color: "var(--text)", fontSize: "13px", fontWeight: 600, lineHeight: 1.25 }}>
                      Analyzing flood photo
                    </span>
                    <span style={{ display: "block", color: "var(--muted)", fontSize: "11.5px", lineHeight: 1.35 }}>
                      {SCAN_STAGES[scanStage]} · SAM 3.1 + Muse Spark
                    </span>
                  </span>
                </div>
                <div style={{ marginTop: "9px", height: "3px", borderRadius: "2px", backgroundColor: "var(--active)", overflow: "hidden" }}>
                  <div className="hydro-loadbar" style={{ width: "34%", height: "100%", borderRadius: "2px", background: "var(--accent)" }} />
                </div>
                <div style={{ marginTop: "8px", display: "flex", gap: "12px", flexWrap: "wrap" }}>
                  {SCAN_STAGES.map((label, i) => (
                    <span key={label} style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "11px", color: i <= scanStage ? "var(--text)" : "var(--faint)", fontWeight: i === scanStage ? 600 : 400 }}>
                      <span className={i === scanStage ? "hydro-blink" : ""} style={{ width: "6px", height: "6px", borderRadius: "50%", backgroundColor: i <= scanStage ? "var(--accent)" : "var(--border-strong)", display: "inline-block" }} />
                      {label}
                    </span>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* Standby prompt banner */}
          {!floodProjection && !photoUploading && !projectionLoading && (
            <div
              style={{
                position: "absolute",
                top: "12px",
                left: "50%",
                transform: "translateX(-50%)",
                backgroundColor: "var(--surface)",
                border: "1px solid var(--border)",
                color: "var(--text)",
                padding: "6px 14px",
                borderRadius: "var(--radius-control)",
                fontSize: "12px",
                fontWeight: 500,
                display: "flex",
                alignItems: "center",
                gap: "8px",
                pointerEvents: "none",
                zIndex: 6,
                whiteSpace: "nowrap",
              }}
            >
              <Crosshair size={13} color="var(--accent)" />
              <span>Click waterline to cast 3D projection</span>
            </div>
          )}

          {/* Projection loading indicator */}
          {projectionLoading && (
            <div
              style={{
                position: "absolute",
                top: "12px",
                left: "50%",
                transform: "translateX(-50%)",
                backgroundColor: "var(--surface)",
                border: "1px solid var(--border)",
                color: "var(--accent)",
                padding: "6px 14px",
                borderRadius: "var(--radius-control)",
                fontSize: "12px",
                fontWeight: 600,
                display: "flex",
                alignItems: "center",
                gap: "8px",
                pointerEvents: "none",
                zIndex: 6,
                whiteSpace: "nowrap",
              }}
            >
              <RefreshCw size={13} className="spin" />
              <span>Projecting 3D DEM flood extent & triage...</span>
            </div>
          )}

          {/* SVG Overlay for SAM 3.1 Polygons and Crosshair */}
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
            {showMasks && !photoUploading &&
              masks.map((m) => {
                const style = MASK_STROKES[m.concept] || {
                  stroke: "#0e7490",
                  fill: "rgba(14, 116, 144, 0.2)",
                };
                const pts = (m.polygon_norm || [])
                  .map(([u, v]) => `${(u * 1000).toFixed(1)},${(v * 562.5).toFixed(1)}`)
                  .join(" ");
                const isBasis = Boolean(basisConcept && m.concept === basisConcept);
                const labelText = `${m.concept}${isBasis ? " · basis" : ""} · ${Math.round((m.confidence || 0.9) * 100)}%${m.concept !== "floodwater" && m.submerged_ratio != null ? ` · ${Math.round(m.submerged_ratio * 100)}% sub` : ""}${m.geometry_source === "sam_polygon" ? " · mask" : m.geometry_source === "sam_box" ? " · box" : ""}`;
                const [bx1, by1, bx2, by2] = m.bbox_norm || [0.4, 0.4, 0.6, 0.6];
                return (
                  <g key={m.id}>
                    {pts && (
                      <polygon
                        points={pts}
                        fill={style.fill}
                        stroke={style.stroke}
                        strokeWidth={isBasis ? 3.5 : 2}
                      />
                    )}
                    <rect
                      x={bx1 * 1000}
                      y={by1 * 562.5}
                      width={(bx2 - bx1) * 1000}
                      height={(by2 - by1) * 562.5}
                      fill="none"
                      stroke={style.stroke}
                      strokeWidth={isBasis ? 2.5 : 1.2}
                      strokeDasharray="4,3"
                    />
                    <rect
                      x={bx1 * 1000}
                      y={Math.max(4, by1 * 562.5 - 20)}
                      width={Math.min(360, (labelText.length + 2) * 7)}
                      height="18"
                      fill="#0f172a"
                      rx="3"
                    />
                    <text
                      x={bx1 * 1000 + 5}
                      y={Math.max(17, by1 * 562.5 - 7)}
                      fill="#ffffff"
                      fontSize="11.5"
                      fontFamily="var(--font)"
                      fontWeight="500"
                    >
                      {labelText}
                    </text>
                  </g>
                );
              })}

            {/* Vertical Ray Bearing Indicator Line & Waterline Crosshair */}
            {!photoUploading && (
              <>
                <line
                  x1={cameraParams.click_u * 1000}
                  y1={0}
                  x2={cameraParams.click_u * 1000}
                  y2={562.5}
                  stroke="#0f172a"
                  strokeWidth="1.6"
                  strokeDasharray="4,4"
                />

                <circle
                  cx={cameraParams.click_u * 1000}
                  cy={cameraParams.click_v * 562.5}
                  r="10"
                  fill="rgba(255, 255, 255, 0.9)"
                  stroke="#b91c1c"
                  strokeWidth="2"
                />
                <circle
                  cx={cameraParams.click_u * 1000}
                  cy={cameraParams.click_v * 562.5}
                  r="3"
                  fill="#b91c1c"
                />
              </>
            )}
          </svg>
        </div>

        {/* Bottom HUD Telemetry Strip */}
        {!photoUploading && (
          <div
            style={{
              position: "absolute",
              left: "8px",
              bottom: "8px",
              backgroundColor: "rgba(255, 255, 255, 0.94)",
              border: "1px solid var(--border)",
              borderRadius: "4px",
              padding: "3px 8px",
              fontSize: "12px",
              color: "var(--text)",
              display: "flex",
              alignItems: "center",
              gap: "8px",
              flexWrap: "wrap",
              zIndex: 5,
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontWeight: 500 }}>
              <Crosshair size={12} color="var(--accent)" />
              Target u = <span className="mono-id">{cameraParams.click_u.toFixed(2)}</span>
            </span>
            <span style={{ color: "var(--muted)" }}>
              Δθ = <span className="num">{angleOffsetDeg}°</span>
            </span>
            <span style={{ color: "var(--muted)" }}>
              Bearing = <span className="num">{targetBearingDeg}°</span>
            </span>
          </div>
        )}
      </div>
      )}

      {/* Analysis provenance / missing-boxes notice */}
      {photoUrl && !photoUploading && masks.length === 0 && (
        <div
          style={{
            padding: "8px 12px",
            borderRadius: "6px",
            backgroundColor: "var(--warning-soft, #fffbeb)",
            color: "var(--warning, #92400e)",
            border: "1px solid var(--warning-border, #fcd34d)",
            fontSize: "12.5px",
          }}
        >
          No reference-object bounding boxes for this photo. Live SAM 3.1 segmentation is
          unavailable (no META_API_KEY configured, or the live call failed), so no basis
          object could be detected — click the waterline on the photo to set the target manually.
        </div>
      )}
      {photoUrl && !photoUploading && masks.length > 0 && analysisResult?.fallback_used && (
        <div
          style={{
            padding: "8px 12px",
            borderRadius: "6px",
            backgroundColor: "var(--surface)",
            color: "var(--muted)",
            border: "1px solid var(--border)",
            fontSize: "12.5px",
          }}
        >
          Showing calibrated baseline bounding boxes ({analysisResult.execution_mode || "fallback"}):
          live SAM 3.1 was unavailable, so these are preset reference overlays, not live
          detections. The basis box used for the depth gauge is outlined thicker and labelled “basis”.
        </div>
      )}

      {/* Visual Hydrological Gauge Telemetry */}
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: "6px",
          padding: "10px 12px",
          display: "flex",
          flexDirection: "column",
          gap: "8px",
          backgroundColor: "var(--surface)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--text)" }}>
              Scale reference:
            </span>
            <span style={{ fontSize: "13px", color: "var(--muted)" }}>
              {photoUploading
                ? "Analyzing image perception..."
                : photoUrl
                ? (gauge.reference_object_detected || (isCustomPhoto ? "Operator field photo" : "Submerged reference structure"))
                : "Awaiting photo input"}
            </span>
          </div>

          {photoUrl && !photoUploading && (
            <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
              <span className="status-pill neutral num" style={{ fontSize: "11.5px" }}>
                {!analysisResult ? "Not analyzed yet" : analysisResult.fallback_used ? "Calibrated baseline - not live" : analysisResult.cached || analysisResult.execution_mode === "cached" ? "Cached result" : "Live inference"} · Std {(gauge.reference_standard_height_m ?? 1.65).toFixed(2)} m
              </span>
              <span className="status-pill warning num" style={{ fontSize: "11.5px" }}>
                Submerged {Math.round((gauge.submerged_ratio ?? 0.82) * 100)}%
              </span>
              <span className="status-pill positive num" style={{ fontSize: "11.5px" }}>
                {Math.round((gauge.confidence_score ?? 0.91) * 100)}% conf
              </span>
              <span className="status-pill neutral num" style={{ fontSize: "11.5px" }}>
                Dist ~{Math.round(cameraParams.est_distance_m ?? gauge.estimated_distance_from_camera_m ?? 38)} m · model est.
              </span>
            </div>
          )}
        </div>

        <p style={{ margin: 0, fontSize: "12.5px", color: "var(--muted)", lineHeight: 1.45 }}>
          {photoUploading
            ? "Segmenting waterline and identifying reference objects via SAM 3.1 & Muse Spark 1.3..."
            : photoUrl
            ? (gauge.hydrological_reasoning || (isCustomPhoto ? "Field photo loaded. Click waterline on photo to calibrate ray projection." : "Vision gauge detected reference structure waterline to calculate standing depth."))
            : "SAM 3.1 segmentation and Muse Spark 1.3 visual depth gauge will analyze the street photo once loaded."}
        </p>

        {photoUrl && !photoUploading && (
          <div
            style={{
              padding: "8px 12px",
              borderRadius: "6px",
              backgroundColor: "var(--warning-soft, #fffbeb)",
              color: "var(--warning, #92400e)",
              border: "1px solid var(--warning-border, #fcd34d)",
              fontSize: "12.5px",
              lineHeight: 1.45,
            }}
          >
            Dominant uncertainty — distance: the ~{Math.round(cameraParams.est_distance_m ?? 38)} m camera-to-target
            range is model-estimated, not measured. The Step 2 flood target shifts 1:1 with any distance error
            along the camera bearing (a ±5 m range error moves the target ±5 m); the measured depth and WSE do
            not depend on it. If the true range is known, correct it before running Step 2.
          </div>
        )}

        {/* DEM uncertainty band for the measured depth (replaces the removed +1.5 m surge simulation) */}
        {(() => {
          const band = uncertaintyBand(floodProjection);
          return (
            <div
              style={{
                padding: "8px 12px",
                borderRadius: "6px",
                backgroundColor: "var(--surface)",
                color: "var(--muted)",
                border: "1px solid var(--border)",
                fontSize: "12.5px",
                lineHeight: 1.45,
              }}
            >
              <strong style={{ color: "var(--text)" }}>DEM uncertainty band · measured depth only. </strong>
              {band ? (
                <span className="num">
                  WSE {formatNumber(band.wseM, 2)} m ± {formatNumber(band.uncertaintyM, 2)} m ({formatNumber(band.wseLowM, 2)}–{formatNumber(band.wseHighM, 2)} m) ·
                  Connected flood area {formatNumber(band.areaLowHa, 1)}–{formatNumber(band.areaHighHa, 1)} ha (central {formatNumber(band.areaHa, 1)} ha).
                  This band comes from DEM vertical uncertainty on the measured depth — it is not a forecast and adds no hypothetical surge.
                </span>
              ) : (
                <span>
                  Run the Step 2 DEM projection to see the ±DEM uncertainty band for the measured depth.
                  No hypothetical surge scenario is generated.
                </span>
              )}
            </div>
          );
        })()}
      </div>
    </section>
  );
}
