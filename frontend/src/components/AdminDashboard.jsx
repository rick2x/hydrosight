import React, { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import {
  Layers,
  ShieldAlert,
  CheckCircle2,
  RefreshCw,
  Trash2,
  Eye,
  ExternalLink,
  Download,
  PlusCircle,
  Sliders,
  MapPin,
} from "lucide-react";
import { formatNumber } from "../utils/format";

const LIGHT_MAP_STYLE = {
  version: 8,
  sources: {
    "osm-light": {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [
    {
      id: "osm-light-layer",
      type: "raster",
      source: "osm-light",
      minzoom: 0,
      maxzoom: 19,
      paint: {
        "raster-saturation": -0.82,
        "raster-contrast": -0.08,
        "raster-brightness-min": 0.14,
      },
    },
  ],
};

const EMPTY_FC = { type: "FeatureCollection", features: [] };

function collectCoords(node, out) {
  if (!node) return;
  if (Array.isArray(node) && node.length >= 2 && typeof node[0] === "number" && typeof node[1] === "number") {
    out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((c) => collectCoords(c, out));
    return;
  }
  if (node.type === "FeatureCollection") {
    (node.features || []).forEach((f) => collectCoords(f, out));
  } else if (node.type === "Feature") {
    collectCoords(node.geometry, out);
  } else if (node.coordinates) {
    collectCoords(node.coordinates, out);
  }
}

export default function AdminDashboard({
  incidents,
  consolidation,
  adminLoading,
  reconciliationMode,
  onChangeReconciliationMode,
  onRefreshAdmin,
  onSeedDemoIncidents,
  onClearAllIncidents,
  onUpdateIncidentStatus,
  onDeleteIncident,
  onLoadIncidentIntoWorkbench,
  onSaveCurrentToAdmin,
  canSaveCurrent,
  boundaryGeojson,
  evacCentersGeojson,
  active,
}) {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const popupRef = useRef(null);
  const [mapReady, setMapReady] = useState(false);

  const [showConsolidatedFill, setShowConsolidatedFill] = useState(true);
  const [showIndividualOutlines, setShowIndividualOutlines] = useState(true);
  const [showOverlapZones, setShowOverlapZones] = useState(true);
  const [showBuildings3D, setShowBuildings3D] = useState(true);
  const [selectedIncidentId, setSelectedIncidentId] = useState(null);

  const selectedIncident =
    incidents.find((inc) => inc.incident_id === selectedIncidentId) ||
    incidents[0] ||
    null;

  // Map each incident_id to its cluster & outlier status
  const clusterByIncident = {};
  const outlierIncidents = new Set();
  (consolidation?.clusters || []).forEach((c) => {
    (c.incident_ids || []).forEach((id) => {
      clusterByIncident[id] = c;
    });
    if (c.outlier_incident_id) {
      outlierIncidents.add(c.outlier_incident_id);
    }
  });

  // Initialize MapLibre GL map
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;
    try {
      const map = new maplibregl.Map({
        container: mapContainerRef.current,
        style: LIGHT_MAP_STYLE,
        center: [121.1375, 14.7495],
        zoom: 14.5,
        pitch: 42,
        bearing: -10,
        attributionControl: true,
      });
      map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");
      popupRef.current = new maplibregl.Popup({ closeButton: true, closeOnClick: false, maxWidth: "340px" });

      map.on("load", () => {
        map.addSource("admin-boundary", { type: "geojson", data: boundaryGeojson || EMPTY_FC });
        map.addLayer({
          id: "admin-boundary-line",
          type: "line",
          source: "admin-boundary",
          paint: { "line-color": "#475569", "line-width": 1.2, "line-dasharray": [4, 3] },
        });

        // 1. Consolidated de-duplicated flood extent
        map.addSource("admin-consolidated-flood", {
          type: "geojson",
          data: consolidation?.consolidated_flood_geojson || EMPTY_FC,
        });
        map.addLayer({
          id: "admin-consolidated-fill",
          type: "fill",
          source: "admin-consolidated-flood",
          paint: {
            "fill-color": ["coalesce", ["get", "fill_color"], "#0e7490"],
            "fill-opacity": 0.38,
          },
        });
        map.addLayer({
          id: "admin-consolidated-outline",
          type: "line",
          source: "admin-consolidated-flood",
          paint: {
            "line-color": ["coalesce", ["get", "line_color"], "#0e7490"],
            "line-width": 1.6,
          },
        });

        // 2. Individual report outlines (dashed per-photo polygon boundary)
        map.addSource("admin-individual-outlines", {
          type: "geojson",
          data: consolidation?.individual_outlines_geojson || EMPTY_FC,
        });
        map.addLayer({
          id: "admin-individual-line",
          type: "line",
          source: "admin-individual-outlines",
          paint: {
            "line-color": ["coalesce", ["get", "outline_color"], "#0284c7"],
            "line-width": 2.2,
            "line-dasharray": [3, 2],
            "line-opacity": 0.9,
          },
        });

        // 3. Intersection / Overlap Conflict Zones
        map.addSource("admin-overlap-zones", {
          type: "geojson",
          data: consolidation?.intersection_zones_geojson || EMPTY_FC,
        });
        map.addLayer({
          id: "admin-overlap-fill",
          type: "fill",
          source: "admin-overlap-zones",
          paint: {
            "fill-color": [
              "case",
              ["boolean", ["get", "discrepancy_flagged"], false],
              "#b91c1c",
              "#7c3aed",
            ],
            "fill-opacity": 0.28,
          },
        });
        map.addLayer({
          id: "admin-overlap-outline",
          type: "line",
          source: "admin-overlap-zones",
          paint: {
            "line-color": [
              "case",
              ["boolean", ["get", "discrepancy_flagged"], false],
              "#b91c1c",
              "#7c3aed",
            ],
            "line-width": 2.4,
          },
        });

        // 4. De-duplicated 3D OSM Buildings
        map.addSource("admin-buildings", {
          type: "geojson",
          data: consolidation?.buildings_geojson || EMPTY_FC,
        });
        map.addLayer({
          id: "admin-buildings-3d",
          type: "fill-extrusion",
          source: "admin-buildings",
          paint: {
            "fill-extrusion-color": ["coalesce", ["get", "extrusion_color"], "#94a3b8"],
            "fill-extrusion-height": ["coalesce", ["get", "height_m"], 6.0],
            "fill-extrusion-base": 0,
            "fill-extrusion-opacity": 0.58,
          },
        });

        // 5. Safe rescue corridors & severed roads
        map.addSource("admin-severed", {
          type: "geojson",
          data: consolidation?.severed_roads_geojson || EMPTY_FC,
        });
        map.addLayer({
          id: "admin-severed-line",
          type: "line",
          source: "admin-severed",
          paint: { "line-color": "#b91c1c", "line-width": 2, "line-opacity": 0.65 },
        });

        map.addSource("admin-routes", {
          type: "geojson",
          data: consolidation?.routes_geojson || EMPTY_FC,
        });
        map.addLayer({
          id: "admin-routes-casing",
          type: "line",
          source: "admin-routes",
          paint: { "line-color": "#ffffff", "line-width": 8, "line-opacity": 0.9 },
        });
        map.addLayer({
          id: "admin-routes-line",
          type: "line",
          source: "admin-routes",
          paint: { "line-color": "#0284c7", "line-width": 4.5 },
        });

        // 6. Camera stations & ray lines
        map.addSource("admin-stations", {
          type: "geojson",
          data: consolidation?.camera_stations_geojson || EMPTY_FC,
        });
        map.addLayer({
          id: "admin-stations-ray",
          type: "line",
          source: "admin-stations",
          filter: ["==", ["get", "kind"], "ray"],
          paint: {
            "line-color": ["coalesce", ["get", "color"], "#0f172a"],
            "line-width": 2,
            "line-dasharray": [2, 2],
          },
        });
        map.addLayer({
          id: "admin-stations-camera",
          type: "circle",
          source: "admin-stations",
          filter: ["==", ["get", "kind"], "camera"],
          paint: {
            "circle-radius": 7.5,
            "circle-color": ["coalesce", ["get", "color"], "#0f172a"],
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 2.5,
          },
        });

        // Click handlers for overlap zones & camera pins
        map.on("mouseenter", "admin-overlap-fill", () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", "admin-overlap-fill", () => {
          map.getCanvas().style.cursor = "";
        });
        map.on("click", "admin-overlap-fill", (e) => {
          if (!e.features?.length) return;
          const p = e.features[0].properties;
          const flagged = p.discrepancy_flagged === true || p.discrepancy_flagged === "true";
          popupRef.current
            .setLngLat(e.lngLat)
            .setHTML(
              `<div style="font-family:inherit;font-size:12.5px;color:#0f172a;padding:4px;">
                <div style="font-weight:600;font-size:13px;margin-bottom:4px;color:${flagged ? "#b91c1c" : "#0f172a"};">
                  ${flagged ? "Overlap Discrepancy Zone" : "Overlapping Flood Zone"}
                </div>
                <div style="font-size:11.5px;color:#475569;margin-bottom:6px;">
                  <div><strong>Report A:</strong> ${p.incident_a_label || ""}</div>
                  <div><strong>Report B:</strong> ${p.incident_b_label || ""}</div>
                </div>
                <div style="border-top:1px solid #e2e8f0;padding-top:6px;display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:11.5px;">
                  <div><span style="color:#64748b;">Overlap Area:</span> <strong>${Math.round(Number(p.overlap_area_sqm || 0)).toLocaleString()} m²</strong></div>
                  <div><span style="color:#64748b;">IoU Ratio:</span> <strong>${(Number(p.iou_ratio || 0) * 100).toFixed(1)}%</strong></div>
                  <div><span style="color:#64748b;">WSE Spread:</span> <strong style="color:${flagged ? "#b91c1c" : "#0f172a"};">Δ${Number(p.wse_delta_m || 0).toFixed(2)} m</strong></div>
                </div>
              </div>`
            )
            .addTo(map);
        });

        map.on("mouseenter", "admin-stations-camera", () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", "admin-stations-camera", () => {
          map.getCanvas().style.cursor = "";
        });
        map.on("click", "admin-stations-camera", (e) => {
          if (!e.features?.length) return;
          const p = e.features[0].properties;
          if (p.incident_id) {
            setSelectedIncidentId(p.incident_id);
          }
          popupRef.current
            .setLngLat(e.lngLat)
            .setHTML(
              `<div style="font-family:inherit;font-size:12.5px;color:#0f172a;padding:4px;">
                <div style="font-weight:600;font-size:13px;margin-bottom:3px;">${p.label || p.incident_id}</div>
                <div style="font-size:11.5px;color:#64748b;margin-bottom:6px;">Brgy. ${p.barangay} · Azimuth ${p.azimuth_deg}°</div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:11.5px;border-top:1px solid #e2e8f0;padding-top:5px;">
                  <div>Depth: <strong>${Number(p.water_depth_m || 0).toFixed(2)} m</strong></div>
                  <div>WSE: <strong>${Number(p.wse_m || 0).toFixed(2)} m</strong></div>
                  <div>Confidence: <strong>${Math.round(Number(p.confidence_score || 0.85) * 100)}%</strong></div>
                </div>
              </div>`
            )
            .addTo(map);
        });

        setMapReady(true);
      });

      mapRef.current = map;
    } catch {
      setMapReady(false);
    }

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  // Resize when tab becomes active
  useEffect(() => {
    if (!active || !mapRef.current) return;
    const id = setTimeout(() => {
      try {
        mapRef.current.resize();
      } catch {}
    }, 60);
    return () => clearTimeout(id);
  }, [active]);

  // Sync GeoJSON sources & fit bounds when consolidation updates
  useEffect(() => {
    if (!mapRef.current || !mapReady) return;
    const map = mapRef.current;

    map.getSource("admin-boundary")?.setData(boundaryGeojson || EMPTY_FC);
    map.getSource("admin-consolidated-flood")?.setData(consolidation?.consolidated_flood_geojson || EMPTY_FC);
    map.getSource("admin-individual-outlines")?.setData(consolidation?.individual_outlines_geojson || EMPTY_FC);
    map.getSource("admin-overlap-zones")?.setData(consolidation?.intersection_zones_geojson || EMPTY_FC);
    map.getSource("admin-buildings")?.setData(consolidation?.buildings_geojson || EMPTY_FC);
    map.getSource("admin-severed")?.setData(consolidation?.severed_roads_geojson || EMPTY_FC);
    map.getSource("admin-routes")?.setData(consolidation?.routes_geojson || EMPTY_FC);
    map.getSource("admin-stations")?.setData(consolidation?.camera_stations_geojson || EMPTY_FC);

    const coords = [];
    collectCoords(consolidation?.consolidated_flood_geojson, coords);
    collectCoords(consolidation?.camera_stations_geojson, coords);
    if (coords.length >= 2) {
      const bounds = new maplibregl.LngLatBounds();
      coords.forEach((pt) => bounds.extend(pt));
      try {
        map.fitBounds(bounds, { padding: { top: 48, bottom: 48, left: 48, right: 48 }, maxZoom: 16, duration: 400 });
      } catch {}
    }
  }, [mapReady, consolidation, boundaryGeojson]);

  // Sync layer visibility toggles
  useEffect(() => {
    if (!mapRef.current || !mapReady) return;
    const map = mapRef.current;
    const setVis = (layerId, vis) => {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, "visibility", vis ? "visible" : "none");
      }
    };
    setVis("admin-consolidated-fill", showConsolidatedFill);
    setVis("admin-consolidated-outline", showConsolidatedFill);
    setVis("admin-individual-line", showIndividualOutlines);
    setVis("admin-overlap-fill", showOverlapZones);
    setVis("admin-overlap-outline", showOverlapZones);
    setVis("admin-buildings-3d", showBuildings3D);
  }, [mapReady, showConsolidatedFill, showIndividualOutlines, showOverlapZones, showBuildings3D]);

  const handleFlyToIncident = (inc) => {
    setSelectedIncidentId(inc.incident_id);
    if (mapRef.current && mapReady) {
      try {
        mapRef.current.flyTo({
          center: [inc.target_lon || inc.cam_lon, inc.target_lat || inc.cam_lat],
          zoom: 16.4,
          pitch: 48,
          duration: 600,
        });
      } catch {}
    }
  };

  const consHa =
    consolidation?.consolidated_flood_area_sqm != null
      ? formatNumber(consolidation.consolidated_flood_area_sqm / 10000, 2)
      : "0.00";
  const rawHa =
    consolidation?.raw_sum_flood_area_sqm != null
      ? formatNumber(consolidation.raw_sum_flood_area_sqm / 10000, 2)
      : "0.00";
  const elimHa =
    consolidation?.overlap_area_eliminated_sqm != null
      ? formatNumber(consolidation.overlap_area_eliminated_sqm / 10000, 2)
      : "0.00";

  const discrepancyCount = (consolidation?.overlap_pairs || []).filter((p) => p.discrepancy_flagged).length;
  const structSummary = consolidation?.inundated_structures || {
    critical_depth_count: 0,
    medium_depth_count: 0,
    low_depth_count: 0,
    affected_structures: 0,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* Top Admin Control & Reconciliation Mode Deck */}
      <section className="panel-card" aria-label="Admin flood consolidation controls">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <h2 style={{ fontSize: "16px", fontWeight: 600, margin: 0, color: "var(--text)" }}>
                Admin Flood Registry & Overlapping Prediction Consolidation
              </h2>
              <span className={`status-pill ${consolidation?.overlapping_clusters_count > 0 ? "warning" : "positive"} num`}>
                {consolidation?.overlapping_clusters_count > 0
                  ? `${consolidation.overlapping_clusters_count} overlapping cluster(s) reconciled`
                  : `${consolidation?.active_consolidated_incidents || 0} active report(s)`}
              </span>
            </div>
            <p style={{ margin: "3px 0 0 0", fontSize: "12.5px", color: "var(--muted)" }}>
              All saved street flood photos and 3D DEM projections are stored here, grouped by spatial intersection in EPSG:32651, and fused into one de-duplicated municipal flood surface.
            </p>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            {canSaveCurrent && (
              <button
                type="button"
                className="btn-secondary"
                onClick={onSaveCurrentToAdmin}
                disabled={adminLoading}
                style={{ fontSize: "12px", height: "32px" }}
              >
                <PlusCircle size={13} />
                <span>Save active workbench run</span>
              </button>
            )}

            <button
              type="button"
              className="btn-secondary"
              onClick={onSeedDemoIncidents}
              disabled={adminLoading}
              style={{ fontSize: "12px", height: "32px" }}
              title="Populate 5 realistic overlapping street flood reports across Brgy. San Jose and Brgy. Burgos"
            >
              <Layers size={13} />
              <span>{incidents.length === 0 ? "Seed 5 Overlapping Demo Reports" : "Reset / Re-seed 5 Overlapping Reports"}</span>
            </button>

            <button
              type="button"
              className="btn-secondary"
              onClick={onRefreshAdmin}
              disabled={adminLoading}
              style={{ fontSize: "12px", height: "32px" }}
            >
              <RefreshCw size={12} className={adminLoading ? "spin" : ""} />
              <span>{adminLoading ? "Consolidating..." : "Re-consolidate"}</span>
            </button>

            <a
              href={consolidation?.download_shp_url || "/api/v1/download-shp/consolidated_latest"}
              download="rodriguez_flood_extent_consolidated.zip"
              className="btn-primary"
              style={{ fontSize: "12.5px", height: "32px", textDecoration: "none" }}
            >
              <Download size={13} />
              <span>Export Consolidated .SHP</span>
            </a>
          </div>
        </div>

        {/* Reconciliation Mode Bar */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
            flexWrap: "wrap",
            paddingTop: "10px",
            borderTop: "1px solid var(--rule)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--text)", display: "inline-flex", alignItems: "center", gap: "5px" }}>
              <Sliders size={13} color="var(--accent)" />
              Overlapping WSE Reconciliation:
            </span>
            <span
              style={{
                fontSize: "12px",
                fontWeight: 600,
                color: "var(--accent)",
                background: "var(--surface)",
                border: "1px solid var(--rule)",
                borderRadius: "6px",
                padding: "3px 9px",
              }}
            >
              Confidence-Weighted Fusion (SAM 3.1 + IDW)
            </span>
          </div>

          {incidents.length > 0 && (
            <button
              type="button"
              className="btn-secondary"
              onClick={onClearAllIncidents}
              disabled={adminLoading}
              style={{
                fontSize: "12px",
                height: "28px",
                padding: "0 10px",
                color: "var(--negative)",
                borderColor: "var(--negative-border)",
              }}
            >
              <Trash2 size={12} />
              <span>Clear registry</span>
            </button>
          )}
        </div>
      </section>

      {/* 5-Column Consolidation KPI Ribbon */}
      <section className="kpi-strip" aria-label="Consolidation and de-duplication metrics">
        <div className="kpi-cell">
          <span className="kpi-label">Saved flood reports</span>
          <div className="kpi-value num">
            {consolidation ? consolidation.active_consolidated_incidents : 0}
            <span className="kpi-unit">/ {consolidation ? consolidation.total_saved_incidents : 0} active</span>
          </div>
          <span className="kpi-subtext num">
            {consolidation?.overlapping_clusters_count > 0
              ? `${consolidation.overlapping_clusters_count} overlapping cluster(s) · ${consolidation.overlap_pairs?.length || 0} intersecting pair(s)`
              : "No overlapping polygons detected"}
          </span>
        </div>

        <div className="kpi-cell">
          <span className="kpi-label">Consolidated flood extent</span>
          <div className="kpi-value num">
            {consHa}
            <span className="kpi-unit">ha</span>
          </div>
          <span className="kpi-subtext num" style={{ color: Number(elimHa) > 0 ? "var(--positive)" : "var(--muted)", fontWeight: 500 }}>
            Raw sum {rawHa} ha · {elimHa} ha overlap eliminated
          </span>
        </div>

        <div className="kpi-cell">
          <span className="kpi-label">De-duplicated structures</span>
          <div className="kpi-value num">
            {consolidation ? consolidation.consolidated_affected_structures : 0}
            <span className="kpi-unit">bldgs</span>
          </div>
          <span className="kpi-subtext num" style={{ color: (consolidation?.duplicate_structures_eliminated || 0) > 0 ? "var(--positive)" : "var(--muted)", fontWeight: 500 }}>
            Raw sum {consolidation?.raw_sum_affected_structures || 0} · {consolidation?.duplicate_structures_eliminated || 0} double-counts removed
          </span>
        </div>

        <div className="kpi-cell">
          <span className="kpi-label">Critical depth (&gt;1.5 m)</span>
          <div className="kpi-value num" style={{ color: structSummary.critical_depth_count > 0 ? "var(--negative)" : "var(--text)" }}>
            {structSummary.critical_depth_count}
            <span className="kpi-unit">bldgs</span>
          </div>
          <span className="kpi-subtext num">
            {structSummary.medium_depth_count} med (0.5–1.5 m) · {structSummary.low_depth_count} low (&lt;0.5 m)
          </span>
        </div>

        <div className="kpi-cell">
          <span className="kpi-label">WSE discrepancy alerts</span>
          <div className="kpi-value num" style={{ color: discrepancyCount > 0 ? "var(--negative)" : "var(--positive)" }}>
            {discrepancyCount}
            <span className="kpi-unit">pair(s)</span>
          </div>
          <span className="kpi-subtext num">
            {discrepancyCount > 0
              ? "ΔWSE exceeds DEM uncertainty band — review outlier below"
              : "All overlapping gauges agree within DEM uncertainty"}
          </span>
        </div>
      </section>

      {/* Main Split: Consolidated 3D Map (Left) + Overlap Clusters & Pairwise Matrix (Right) */}
      <div className="workbench-split" style={{ alignItems: "stretch" }}>
        {/* Left Card: Unified 3D Consolidation & Overlap Map */}
        <section className="panel-card" aria-label="Consolidated 3D flood extent and overlap map">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <div>
              <h3 style={{ fontSize: "15px", fontWeight: 600, margin: 0, color: "var(--text)" }}>
                Unified 3D Flood Surface & Overlap Inspection Map
              </h3>
              <p style={{ margin: "2px 0 0 0", fontSize: "12px", color: "var(--muted)" }}>
                Click any purple/red intersection zone or camera pin to inspect overlapping predictions
              </p>
            </div>

            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
              <button
                type="button"
                className={`cardinal-btn ${showConsolidatedFill ? "active" : ""}`}
                onClick={() => setShowConsolidatedFill((v) => !v)}
                style={{ padding: "0 8px", height: "24px" }}
              >
                Consolidated Fill
              </button>
              <button
                type="button"
                className={`cardinal-btn ${showIndividualOutlines ? "active" : ""}`}
                onClick={() => setShowIndividualOutlines((v) => !v)}
                style={{ padding: "0 8px", height: "24px" }}
              >
                Report Outlines (Dashed)
              </button>
              <button
                type="button"
                className={`cardinal-btn ${showOverlapZones ? "active" : ""}`}
                onClick={() => setShowOverlapZones((v) => !v)}
                style={{ padding: "0 8px", height: "24px" }}
              >
                Overlap Zones
              </button>
              <button
                type="button"
                className={`cardinal-btn ${showBuildings3D ? "active" : ""}`}
                onClick={() => setShowBuildings3D((v) => !v)}
                style={{ padding: "0 8px", height: "24px" }}
              >
                3D Buildings
              </button>
            </div>
          </div>

          <div
            ref={mapContainerRef}
            style={{
              width: "100%",
              height: "460px",
              borderRadius: "6px",
              border: "1px solid var(--border)",
              overflow: "hidden",
              position: "relative",
            }}
          />

          <div style={{ display: "flex", gap: "14px", flexWrap: "wrap", fontSize: "11.5px", color: "var(--muted)" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
              <span style={{ width: "12px", height: "12px", borderRadius: "3px", backgroundColor: "#c4242a", display: "inline-block" }} />
              Critical (&gt;1.5 m)
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
              <span style={{ width: "12px", height: "12px", borderRadius: "3px", backgroundColor: "#d97706", display: "inline-block" }} />
              Medium (0.5–1.5 m)
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
              <span style={{ width: "12px", height: "12px", borderRadius: "3px", backgroundColor: "#1e7b4f", display: "inline-block" }} />
              Low (&lt;0.5 m)
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
              <span style={{ width: "18px", height: "0", borderTop: "2.5px dashed #0284c7", display: "inline-block" }} />
              Individual photo prediction outline
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
              <span style={{ width: "12px", height: "12px", borderRadius: "3px", backgroundColor: "rgba(124, 58, 237, 0.35)", border: "1.5px solid #7c3aed", display: "inline-block" }} />
              Overlap zone (consistent)
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
              <span style={{ width: "12px", height: "12px", borderRadius: "3px", backgroundColor: "rgba(185, 28, 28, 0.35)", border: "1.5px solid #b91c1c", display: "inline-block" }} />
              Overlap zone (WSE discrepancy)
            </span>
          </div>
        </section>

        {/* Right Card: Basin Cluster Consolidation & Overlap Resolution Matrix */}
        <section className="panel-card" aria-label="Overlapping flood clusters and WSE resolution">
          <div>
            <h3 style={{ fontSize: "15px", fontWeight: 600, margin: 0, color: "var(--text)" }}>
              Hydro-Spatial Overlap Clusters & WSE Reconciliation
            </h3>
            <p style={{ margin: "2px 0 0 0", fontSize: "12px", color: "var(--muted)" }}>
              {consolidation?.synthesis_headline || "Awaiting saved flood incidents"}
            </p>
          </div>

          {consolidation?.synthesis_reasoning && (
            <div
              style={{
                padding: "10px 12px",
                borderRadius: "6px",
                backgroundColor: "var(--raised)",
                border: "1px solid var(--border)",
                fontSize: "12.5px",
                color: "var(--text)",
                lineHeight: 1.45,
              }}
            >
              {consolidation.synthesis_reasoning}
            </div>
          )}

          {/* Cluster List */}
          {(consolidation?.clusters || []).length === 0 ? (
            <div className="agent-empty">
              No active flood clusters. Click <strong>Seed 5 Overlapping Demo Reports</strong> above or save a projection from the Operator Workbench.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "10px", maxHeight: "420px", overflowY: "auto" }}>
              {consolidation.clusters.map((c) => (
                <div
                  key={c.cluster_id}
                  style={{
                    padding: "12px",
                    borderRadius: "6px",
                    border: c.discrepancy_flagged ? "1px solid var(--negative-border)" : "1px solid var(--border)",
                    backgroundColor: c.discrepancy_flagged ? "var(--negative-soft)" : "var(--surface)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "6px",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                      <span className="mono-id" style={{ fontSize: "11.5px", fontWeight: 600, color: "var(--text)" }}>
                        {c.cluster_id.toUpperCase()}
                      </span>
                      <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--text)" }}>
                        · Brgy. {c.barangay} ({c.incident_count} {c.incident_count === 1 ? "report" : "overlapping reports"})
                      </span>
                    </div>
                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                      {c.discrepancy_flagged ? (
                        <span className="status-pill critical num" style={{ fontSize: "11px" }}>
                          <ShieldAlert size={11} />
                          <span>ΔWSE {c.wse_spread_m.toFixed(2)} m discrepancy</span>
                        </span>
                      ) : c.is_overlapping ? (
                        <span className="status-pill positive num" style={{ fontSize: "11px" }}>
                          <CheckCircle2 size={11} />
                          <span>Overlap fused (ΔWSE {c.wse_spread_m.toFixed(2)} m)</span>
                        </span>
                      ) : (
                        <span className="status-pill neutral" style={{ fontSize: "11px" }}>
                          Standalone basin
                        </span>
                      )}
                    </div>
                  </div>

                  <div
                    className="num"
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                      gap: "8px",
                      fontSize: "12px",
                      padding: "6px 8px",
                      borderRadius: "4px",
                      backgroundColor: "var(--surface)",
                      border: "1px solid var(--border)",
                    }}
                  >
                    <div>
                      <span style={{ color: "var(--muted)", display: "block", fontSize: "11px" }}>Reconciled WSE</span>
                      <strong style={{ color: "var(--text)", fontSize: "13px" }}>{c.reconciled_wse_m.toFixed(2)} m MSL</strong>
                      {c.is_overlapping && (
                        <span style={{ color: "var(--muted)", fontSize: "11px", display: "block" }}>
                          Range: {c.wse_min_m.toFixed(2)}–{c.wse_max_m.toFixed(2)} m
                        </span>
                      )}
                    </div>
                    <div>
                      <span style={{ color: "var(--muted)", display: "block", fontSize: "11px" }}>De-duplicated Area</span>
                      <strong style={{ color: "var(--text)", fontSize: "13px" }}>
                        {(c.consolidated_area_sqm / 10000).toFixed(2)} ha
                      </strong>
                      {c.overlap_eliminated_sqm > 0 && (
                        <span style={{ color: "var(--positive)", fontSize: "11px", display: "block" }}>
                          −{Math.round(c.overlap_eliminated_sqm).toLocaleString()} m² overlap
                        </span>
                      )}
                    </div>
                    <div>
                      <span style={{ color: "var(--muted)", display: "block", fontSize: "11px" }}>Safe Staging & Corridor</span>
                      <strong style={{ color: "var(--text)", fontSize: "12px" }}>
                        {Math.round(c.route_distance_m)} m ({c.eta_minutes.toFixed(1)} min)
                      </strong>
                      <span style={{ color: "var(--muted)", fontSize: "11px", display: "block" }}>
                        {c.vehicle_selected.replace(/_/g, " ")}
                      </span>
                    </div>
                  </div>

                  <p style={{ margin: 0, fontSize: "12px", color: "var(--muted)", lineHeight: 1.4 }}>
                    {c.resolution_explanation}
                  </p>

                  {c.discrepancy_flagged && c.outlier_incident_id && (
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap", marginTop: "2px" }}>
                      <span style={{ fontSize: "11.5px", color: "var(--negative)", fontWeight: 500 }}>
                        Outlier gauge flagged: <code className="mono-id">{c.outlier_incident_id}</code>
                      </span>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => onUpdateIncidentStatus(c.outlier_incident_id, "excluded")}
                        style={{ height: "26px", fontSize: "11.5px", padding: "0 10px" }}
                      >
                        Exclude outlier & re-consolidate
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Saved Flood Photos & Predictions Registry Table + Selected Photo Inspector */}
      <section className="panel-card" aria-label="Saved flood photos and predictions registry">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          <div>
            <h3 style={{ fontSize: "15px", fontWeight: 600, margin: 0, color: "var(--text)" }}>
              Saved Street Photos & Flood Predictions Registry ({incidents.length})
            </h3>
            <p style={{ margin: "2px 0 0 0", fontSize: "12px", color: "var(--muted)" }}>
              Every uploaded or calibrated street flood photo is persisted here with its SAM 3.1 masks, WSE, and shapefile. Toggle status to include or exclude from consolidation.
            </p>
          </div>
        </div>

        {incidents.length === 0 ? (
          <div className="agent-empty">
            No flood photos saved in the registry yet. Upload a photo in the <strong>Operator Workbench</strong> or click <strong>Seed 5 Overlapping Demo Reports</strong> above.
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: "74px" }}>Photo</th>
                  <th style={{ width: "22%" }}>Report & Reference Object</th>
                  <th style={{ width: "11%" }}>Barangay</th>
                  <th className="num" style={{ width: "9%" }}>Depth</th>
                  <th className="num" style={{ width: "12%" }}>WSE (MSL)</th>
                  <th className="num" style={{ width: "10%" }}>Area / Bldgs</th>
                  <th style={{ width: "14%" }}>Overlap Cluster</th>
                  <th style={{ width: "10%" }}>Status</th>
                  <th style={{ width: "150px", textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {incidents.map((inc) => {
                  const cluster = clusterByIncident[inc.incident_id];
                  const isOutlier = outlierIncidents.has(inc.incident_id);
                  const conf = inc.visual_gauge?.confidence_score ?? 0.85;
                  const isSelected = selectedIncident?.incident_id === inc.incident_id;

                  return (
                    <tr
                      key={inc.incident_id}
                      onClick={() => handleFlyToIncident(inc)}
                      style={{
                        cursor: "pointer",
                        backgroundColor: isSelected ? "var(--raised)" : "transparent",
                        opacity: inc.status === "excluded" ? 0.58 : 1,
                      }}
                    >
                      <td>
                        <div
                          style={{
                            width: "56px",
                            height: "38px",
                            borderRadius: "4px",
                            overflow: "hidden",
                            border: "1px solid var(--border)",
                            backgroundColor: "var(--raised)",
                          }}
                        >
                          <img
                            src={inc.photo_url}
                            alt={inc.label}
                            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                          />
                        </div>
                      </td>
                      <td>
                        <div style={{ fontWeight: 600, color: "var(--text)", fontSize: "12.5px" }}>{inc.label}</div>
                        <div style={{ fontSize: "11.5px", color: "var(--muted)" }}>
                          <span className="mono-id">{inc.incident_id}</span> ·{" "}
                          {inc.visual_gauge?.reference_object_detected || "Field waterline"} ({Math.round(conf * 100)}% conf)
                        </div>
                      </td>
                      <td>
                        <span style={{ fontWeight: 500, fontSize: "12.5px" }}>{inc.barangay}</span>
                        <div className="num" style={{ fontSize: "11px", color: "var(--muted)" }}>
                          {inc.cam_lat.toFixed(4)}, {inc.cam_lon.toFixed(4)}
                        </div>
                      </td>
                      <td className="num">
                        <strong style={{ color: "var(--text)" }}>{inc.water_depth_m.toFixed(2)} m</strong>
                        <div style={{ fontSize: "11px", color: "var(--muted)" }}>Az {Math.round(inc.azimuth_deg)}°</div>
                      </td>
                      <td className="num">
                        <strong style={{ color: "var(--text)" }}>{inc.water_surface_elev_m.toFixed(2)} m</strong>
                        <div style={{ fontSize: "11px", color: "var(--muted)" }}>
                          ±{(inc.dem_uncertainty_m || 0.5).toFixed(2)} m DEM
                        </div>
                      </td>
                      <td className="num">
                        <div>{(inc.flood_area_sqm / 10000).toFixed(2)} ha</div>
                        <div style={{ fontSize: "11px", color: "var(--muted)" }}>
                          {inc.inundated_structures?.affected_structures || 0} bldgs
                        </div>
                      </td>
                      <td>
                        {inc.status === "excluded" ? (
                          <span className="status-pill neutral" style={{ fontSize: "11px" }}>
                            Excluded from fusion
                          </span>
                        ) : isOutlier ? (
                          <span className="status-pill critical" style={{ fontSize: "11px" }}>
                            Outlier in {cluster?.cluster_id}
                          </span>
                        ) : cluster?.is_overlapping ? (
                          <span className="status-pill warning" style={{ fontSize: "11px" }}>
                            Overlaps ({cluster.cluster_id} · {cluster.incident_count})
                          </span>
                        ) : (
                          <span className="status-pill neutral" style={{ fontSize: "11px" }}>
                            Standalone ({cluster?.cluster_id || "single"})
                          </span>
                        )}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <select
                          aria-label={`Status for ${inc.label}`}
                          value={inc.status}
                          onChange={(e) => onUpdateIncidentStatus(inc.incident_id, e.target.value)}
                          style={{
                            height: "28px",
                            fontSize: "12px",
                            padding: "0 6px",
                            borderRadius: "4px",
                            border: "1px solid var(--border)",
                            backgroundColor: "var(--surface)",
                            color: "var(--text)",
                          }}
                        >
                          <option value="verified">Verified</option>
                          <option value="active">Active</option>
                          <option value="excluded">Excluded</option>
                        </select>
                      </td>
                      <td onClick={(e) => e.stopPropagation()} style={{ textAlign: "right" }}>
                        <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={() => onLoadIncidentIntoWorkbench(inc)}
                            title="Open this photo and its 3D projection in the Operator Workbench"
                            style={{ height: "28px", padding: "0 8px", fontSize: "11.5px" }}
                          >
                            <ExternalLink size={12} />
                            <span>Inspect</span>
                          </button>
                          <a
                            href={inc.download_shp_url}
                            download={`rodriguez_flood_${inc.incident_id}.zip`}
                            className="btn-secondary"
                            title="Download individual report Shapefile (.zip)"
                            style={{ height: "28px", padding: "0 8px", fontSize: "11.5px", textDecoration: "none" }}
                          >
                            <Download size={12} />
                          </a>
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={() => onDeleteIncident(inc.incident_id)}
                            title="Delete report from registry"
                            style={{
                              height: "28px",
                              padding: "0 7px",
                              fontSize: "11.5px",
                              color: "var(--negative)",
                              borderColor: "var(--negative-border)",
                            }}
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Selected Incident Photo & SAM 3.1 Gauge Preview Strip */}
        {selectedIncident && (
          <div
            style={{
              marginTop: "8px",
              padding: "12px",
              borderRadius: "6px",
              backgroundColor: "var(--raised)",
              border: "1px solid var(--border)",
              display: "grid",
              gridTemplateColumns: "220px minmax(0, 1fr)",
              gap: "14px",
              alignItems: "center",
            }}
          >
            <div
              style={{
                width: "220px",
                height: "132px",
                borderRadius: "6px",
                overflow: "hidden",
                border: "1px solid var(--border)",
                position: "relative",
                backgroundColor: "#0f172a",
              }}
            >
              <img
                src={selectedIncident.photo_url}
                alt={selectedIncident.label}
                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
              />
              <span
                className="mono-id"
                style={{
                  position: "absolute",
                  bottom: "6px",
                  left: "6px",
                  backgroundColor: "rgba(15, 23, 42, 0.82)",
                  color: "#fff",
                  padding: "2px 6px",
                  borderRadius: "4px",
                  fontSize: "10.5px",
                }}
              >
                {selectedIncident.masks?.length || 0} SAM 3.1 masks
              </span>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "6px", minWidth: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                <div>
                  <strong style={{ fontSize: "14px", color: "var(--text)" }}>{selectedIncident.label}</strong>
                  <span style={{ fontSize: "12px", color: "var(--muted)", marginLeft: "8px" }}>
                    (<span className="mono-id">{selectedIncident.incident_id}</span> · Brgy. {selectedIncident.barangay})
                  </span>
                </div>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => onLoadIncidentIntoWorkbench(selectedIncident)}
                  style={{ height: "28px", fontSize: "12px", padding: "0 12px" }}
                >
                  <Eye size={12} />
                  <span>Load into 3-Step Operator Workbench</span>
                </button>
              </div>

              <p style={{ margin: 0, fontSize: "12.5px", color: "var(--muted)", lineHeight: 1.45 }}>
                <strong style={{ color: "var(--text)" }}>SAM 3.1 + Muse Spark 1.3 Gauge: </strong>
                {selectedIncident.visual_gauge?.hydrological_reasoning ||
                  `Measured ${selectedIncident.water_depth_m.toFixed(2)} m standing flood depth at ${selectedIncident.est_distance_m.toFixed(0)} m forward range.`}
              </p>

              <div className="num" style={{ display: "flex", gap: "16px", flexWrap: "wrap", fontSize: "12px", color: "var(--muted)" }}>
                <span>
                  Camera: <strong style={{ color: "var(--text)" }}>{selectedIncident.cam_lat.toFixed(5)}, {selectedIncident.cam_lon.toFixed(5)}</strong>
                </span>
                <span>
                  Target DEM ground: <strong style={{ color: "var(--text)" }}>{selectedIncident.ground_dem_m.toFixed(2)} m</strong>
                </span>
                <span>
                  Measured depth: <strong style={{ color: "var(--text)" }}>{selectedIncident.water_depth_m.toFixed(2)} m</strong>
                </span>
                <span>
                  Individual WSE: <strong style={{ color: "var(--text)" }}>{selectedIncident.water_surface_elev_m.toFixed(2)} m MSL</strong>
                </span>
                {clusterByIncident[selectedIncident.incident_id]?.is_overlapping && (
                  <span style={{ color: "var(--accent)", fontWeight: 600 }}>
                    Reconciled Cluster WSE: {clusterByIncident[selectedIncident.incident_id].reconciled_wse_m.toFixed(2)} m MSL
                  </span>
                )}
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
