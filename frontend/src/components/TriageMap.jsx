import React, { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { Navigation, Route, ShieldAlert } from "lucide-react";

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
    node.forEach((child) => collectCoords(child, out));
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

export default function TriageMap({ triageData, floodProjection, boundaryGeojson, evacCentersGeojson, cameraParams, triageLoading, active }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const targetMarkerRef = useRef(null);
  const evacMarkerRef = useRef(null);
  const [mapReady, setMapReady] = useState(false);

  // Init once (may be mounted while Step 3 is hidden; resized when activated)
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    try {
      const map = new maplibregl.Map({
        container: containerRef.current,
        style: LIGHT_MAP_STYLE,
        center: [cameraParams?.cam_lon || 121.1372, cameraParams?.cam_lat || 14.7498],
        zoom: 15,
        pitch: 32,
        attributionControl: true,
      });
      map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");
      map.on("load", () => {
        map.addSource("triage-boundary", { type: "geojson", data: boundaryGeojson || EMPTY_FC });
        map.addLayer({ id: "triage-boundary-line", type: "line", source: "triage-boundary", paint: { "line-color": "#475569", "line-width": 1.2, "line-dasharray": [4, 3] } });

        map.addSource("triage-flood", { type: "geojson", data: floodProjection?.flood_geojson || EMPTY_FC });
        map.addLayer({ id: "triage-flood-fill", type: "fill", source: "triage-flood", paint: { "fill-color": ["coalesce", ["get", "fill_color"], "#0e7490"], "fill-opacity": 0.38 } });
        map.addLayer({ id: "triage-flood-outline", type: "line", source: "triage-flood", paint: { "line-color": ["coalesce", ["get", "line_color"], ["get", "fill_color"], "#0e7490"], "line-width": 1.5 } });

        map.addSource("triage-severed", { type: "geojson", data: triageData?.severed_roads_geojson || EMPTY_FC });
        map.addLayer({ id: "triage-severed-line", type: "line", source: "triage-severed", paint: { "line-color": "#b91c1c", "line-width": 2, "line-opacity": 0.65 } });

        map.addSource("triage-route", { type: "geojson", data: triageData?.route_geojson || EMPTY_FC });
        map.addLayer({ id: "triage-route-casing", type: "line", source: "triage-route", paint: { "line-color": "#ffffff", "line-width": 9.5, "line-opacity": 0.95 } });
        map.addLayer({ id: "triage-route-line", type: "line", source: "triage-route", paint: { "line-color": "#0284c7", "line-width": 5.5 } });
        map.addLayer({ id: "triage-route-center", type: "line", source: "triage-route", paint: { "line-color": "#ffffff", "line-width": 2, "line-dasharray": [3, 2], "line-opacity": 0.95 } });

        map.addSource("triage-evac", { type: "geojson", data: evacCentersGeojson || EMPTY_FC });
        map.addLayer({ id: "triage-evac-halo", type: "circle", source: "triage-evac", paint: { "circle-radius": 12, "circle-color": "#0284c7", "circle-opacity": 0.22 } });
        map.addLayer({ id: "triage-evac-circle", type: "circle", source: "triage-evac", paint: { "circle-radius": 7, "circle-color": "#0284c7", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2.5 } });

        setMapReady(true);
      });
      mapRef.current = map;
    } catch {
      setMapReady(false);
    }
    return () => {
      if (targetMarkerRef.current) targetMarkerRef.current.remove();
      if (evacMarkerRef.current) evacMarkerRef.current.remove();
      if (mapRef.current) mapRef.current.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resize when Step 3 becomes visible
  useEffect(() => {
    if (!active || !mapRef.current) return;
    const id = setTimeout(() => {
      try { mapRef.current.resize(); } catch {}
    }, 60);
    return () => clearTimeout(id);
  }, [active]);

  // Sync data + frame corridor
  useEffect(() => {
    if (!mapRef.current || !mapReady) return;
    const map = mapRef.current;
    map.getSource("triage-boundary")?.setData(boundaryGeojson || EMPTY_FC);
    map.getSource("triage-flood")?.setData(floodProjection?.flood_geojson || EMPTY_FC);
    map.getSource("triage-severed")?.setData(triageData?.severed_roads_geojson || EMPTY_FC);
    map.getSource("triage-route")?.setData(triageData?.route_geojson || EMPTY_FC);
    map.getSource("triage-evac")?.setData(evacCentersGeojson || EMPTY_FC);

    const targetLon = floodProjection?.target_lon ?? cameraParams?.cam_lon;
    const targetLat = floodProjection?.target_lat ?? cameraParams?.cam_lat;
    if (targetLat != null && targetLon != null) {
      if (!targetMarkerRef.current) {
        const el = document.createElement("div");
        el.style.cssText = "width:16px;height:16px;border-radius:999px;background:#b91c1c;border:3px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.35);";
        el.title = "Incident target";
        targetMarkerRef.current = new maplibregl.Marker({ element: el }).setLngLat([targetLon, targetLat]).addTo(map);
      } else {
        targetMarkerRef.current.setLngLat([targetLon, targetLat]);
      }
    }
    if (triageData?.evacuation_center_lat != null && triageData?.evacuation_center_lon != null) {
      const name = triageData.evacuation_center_name || "Evacuation centre";
      if (!evacMarkerRef.current) {
        const el = document.createElement("div");
        el.style.cssText = "display:inline-flex;align-items:center;gap:5px;background:#0284c7;color:#fff;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:600;border:1.5px solid #fff;white-space:nowrap;pointer-events:none;";
        el.textContent = name;
        evacMarkerRef.current = new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat([triageData.evacuation_center_lon, triageData.evacuation_center_lat]).addTo(map);
      } else {
        evacMarkerRef.current.setLngLat([triageData.evacuation_center_lon, triageData.evacuation_center_lat]);
      }
    }

    if (active && triageData?.route_geojson) {
      const coords = [];
      collectCoords(triageData.route_geojson, coords);
      collectCoords(floodProjection?.flood_geojson, coords);
      if (coords.length >= 2) {
        const bounds = new maplibregl.LngLatBounds();
        coords.forEach((pt) => bounds.extend(pt));
        try {
          map.fitBounds(bounds, { padding: { top: 50, bottom: 40, left: 50, right: 50 }, maxZoom: 16, duration: 350 });
        } catch {}
      }
    }
  }, [mapReady, active, triageData, floodProjection, boundaryGeojson, evacCentersGeojson, cameraParams]);

  return (
    <section className="panel-card" aria-label="Step 3 safe corridor map">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
        <div>
          <h2 style={{ fontSize: "15px", fontWeight: 600, margin: 0, color: "var(--text)", display: "flex", alignItems: "center", gap: "7px" }}>
            <Route size={15} color="var(--accent)" />
            Step 3 · Safe corridor map
          </h2>
          <p style={{ margin: "2px 0 0 0", fontSize: "12.5px", color: "var(--muted)" }}>
            {triageData
              ? `${(triageData.vehicle_selected || "Rescue vehicle").replace(/_/g, " ")} corridor to ${triageData.evacuation_center_name || "evacuation centre"}`
              : "Computed rescue corridor, severed roads and flood extent"}
          </p>
        </div>
        {triageData && (
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            <span className="status-pill positive num" style={{ fontSize: "11px" }}>{Math.round(triageData.route_distance_m)} m corridor</span>
            <span className="status-pill neutral num" style={{ fontSize: "11px" }}>ETA {Number(triageData.eta_minutes).toFixed(1)} min</span>
            <span className="status-pill neutral num" style={{ fontSize: "11px" }}>{triageData.severed_segments_count} severed segments</span>
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: "14px", flexWrap: "wrap", fontSize: "11.5px", color: "var(--muted)" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}><span style={{ width: "22px", height: "5px", borderRadius: "2px", backgroundColor: "#0284c7", display: "inline-block" }} /> Safe corridor</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}><span style={{ width: "22px", height: "4px", borderRadius: "2px", backgroundColor: "#b91c1c", display: "inline-block" }} /> Severed roads</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}><span style={{ width: "12px", height: "12px", borderRadius: "3px", backgroundColor: "rgba(14, 116, 144, 0.4)", border: "1px solid #0e7490", display: "inline-block" }} /> Flood extent</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}><span style={{ width: "10px", height: "10px", borderRadius: "50%", backgroundColor: "#b91c1c", display: "inline-block" }} /> Incident target</span>
      </div>

      <div style={{ position: "relative" }}>
        <div ref={containerRef} style={{ width: "100%", height: "440px", borderRadius: "6px", overflow: "hidden", border: "1px solid var(--border)", backgroundColor: "#eef2f5" }} />
        {!triageData && (
          <div style={{ position: "absolute", inset: 0, borderRadius: "6px", backgroundColor: "rgba(248, 250, 252, 0.92)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "8px", padding: "28px 16px", textAlign: "center", zIndex: 2 }}>
            {triageLoading ? <ShieldAlert size={20} color="var(--accent)" /> : <Navigation size={20} color="var(--muted)" />}
            <span style={{ fontSize: "13px", color: "var(--muted)", maxWidth: "460px" }}>
              {triageLoading
                ? "Computing the safe corridor on the Rodriguez road network..."
                : "The safe corridor map appears here once Step 3 triage computes the route."}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
