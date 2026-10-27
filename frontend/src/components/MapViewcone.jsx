import React, { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { sector, point, lineString } from "@turf/turf";
import { Compass, Navigation, Globe, Lock, MapPin, AlertTriangle, School, HeartPulse, Landmark, Building2, Home, Info } from "lucide-react";

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

export default function MapViewcone({
  cameraParams,
  floodProjection,
  triageData,
  boundaryGeojson,
  evacCentersGeojson,
  onUpdateCameraCoords,
}) {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const cameraMarkerRef = useRef(null);
  const onUpdateCoordsRef = useRef(onUpdateCameraCoords);
  const [mapReady, setMapReady] = useState(false);
  const [isCameraLocked, setIsCameraLocked] = useState(true);
  const isCameraLockedRef = useRef(true);
  const buildingClickHandledRef = useRef(false);
  const hasInitialFlownRef = useRef(false);

  useEffect(() => {
    isCameraLockedRef.current = isCameraLocked;
    if (cameraMarkerRef.current) {
      cameraMarkerRef.current.setDraggable(!isCameraLocked);
    }
  }, [isCameraLocked]);

  useEffect(() => {
    onUpdateCoordsRef.current = onUpdateCameraCoords;
  }, [onUpdateCameraCoords]);

  // Compute live FOV viewcone polygon and ray line via @turf/turf
  const { viewconeGeojson, rayLineGeojson } = useMemo(() => {
    const camPt = point([cameraParams.cam_lon, cameraParams.cam_lat]);
    const halfFov = cameraParams.fov_deg / 2.0;
    const bearing1 = cameraParams.azimuth_deg - halfFov;
    const bearing2 = cameraParams.azimuth_deg + halfFov;
    const radiusKm = Math.max(0.08, (cameraParams.est_distance_m * 2.2) / 1000.0);

    const coneFeature = sector(camPt, radiusKm, bearing1, bearing2, {
      steps: 32,
      units: "kilometers",
    });

    const targetLon = floodProjection?.target_lon ?? cameraParams.cam_lon + 0.00032;
    const targetLat = floodProjection?.target_lat ?? cameraParams.cam_lat - 0.00018;
    const rayFeature = lineString([
      [cameraParams.cam_lon, cameraParams.cam_lat],
      [targetLon, targetLat],
    ]);

    return {
      viewconeGeojson: {
        type: "FeatureCollection",
        features: [coneFeature],
      },
      rayLineGeojson: {
        type: "FeatureCollection",
        features: [rayFeature],
      },
    };
  }, [
    cameraParams.cam_lon,
    cameraParams.cam_lat,
    cameraParams.azimuth_deg,
    cameraParams.fov_deg,
    cameraParams.est_distance_m,
    floodProjection?.target_lon,
    floodProjection?.target_lat,
  ]);

  // Initialize MapLibre GL JS 3D Map
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    try {
      const map = new maplibregl.Map({
        container: mapContainerRef.current,
        style: LIGHT_MAP_STYLE,
        center: [cameraParams.cam_lon || 121.1372, cameraParams.cam_lat || 14.7498],
        zoom: 15.5,
        pitch: 50,
        bearing: -15,
        attributionControl: true,
      });

      map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");

      const markerEl = document.createElement("div");
      markerEl.style.width = "18px";
      markerEl.style.height = "18px";
      markerEl.style.borderRadius = "999px";
      markerEl.style.backgroundColor = "#131416";
      markerEl.style.border = "3px solid #ffffff";
      markerEl.style.cursor = "grab";
      markerEl.title = "Draggable Camera Pin — Drag or click anywhere in Montalban";

      const isLocked = isCameraLockedRef.current;
      const marker = new maplibregl.Marker({ element: markerEl, draggable: !isLocked })
        .setLngLat([cameraParams.cam_lon, cameraParams.cam_lat])
        .addTo(map);

      marker.on("dragend", () => {
        if (isCameraLockedRef.current) return;
        const lngLat = marker.getLngLat();
        onUpdateCoordsRef.current(Number(lngLat.lat.toFixed(6)), Number(lngLat.lng.toFixed(6)));
      });

      // Clicking anywhere on map relocates camera ONLY if camera is unlocked AND no building was clicked
      map.on("click", (e) => {
        if (!e.lngLat) return;
        if (buildingClickHandledRef.current) {
          buildingClickHandledRef.current = false;
          return;
        }
        if (isCameraLockedRef.current) {
          return; // Camera pin is locked; do not relocate
        }
        const clickedLat = Number(e.lngLat.lat.toFixed(6));
        const clickedLon = Number(e.lngLat.lng.toFixed(6));
        marker.setLngLat([clickedLon, clickedLat]);
        onUpdateCoordsRef.current(clickedLat, clickedLon);
      });

      cameraMarkerRef.current = marker;

      map.on("load", () => {
        map.addSource("rodriguez-boundary", {
          type: "geojson",
          data: boundaryGeojson || { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "rodriguez-boundary-fill",
          type: "fill",
          source: "rodriguez-boundary",
          paint: {
            "fill-color": "#1b6c80",
            "fill-opacity": 0.04,
          },
        });
        map.addLayer({
          id: "rodriguez-boundary-line",
          type: "line",
          source: "rodriguez-boundary",
          paint: {
            "line-color": "#525659",
            "line-width": 1.4,
            "line-dasharray": [4, 3],
          },
        });

        map.addSource("flood-extent", {
          type: "geojson",
          data: floodProjection?.flood_geojson || { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "flood-extent-fill",
          type: "fill",
          source: "flood-extent",
          paint: {
            "fill-color": ["coalesce", ["get", "fill_color"], "#1e7b4f"],
            "fill-opacity": 0.42,
          },
        });
        map.addLayer({
          id: "flood-extent-outline",
          type: "line",
          source: "flood-extent",
          paint: {
            "line-color": ["coalesce", ["get", "line_color"], ["get", "fill_color"], "#155e3b"],
            "line-width": 1.6,
          },
        });

        map.addSource("buildings-source", {
          type: "geojson",
          data: floodProjection?.buildings_geojson || { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "buildings-3d",
          type: "fill-extrusion",
          source: "buildings-source",
          paint: {
            "fill-extrusion-color": ["coalesce", ["get", "extrusion_color"], "#94a3b8"],
            "fill-extrusion-height": ["coalesce", ["get", "height_m"], 6.0],
            "fill-extrusion-base": 0,
            "fill-extrusion-opacity": 0.86,
          },
        });

        const bldgPopup = new maplibregl.Popup({
          closeButton: true,
          closeOnClick: false,
          maxWidth: "340px",
        });

        map.on("mouseenter", "buildings-3d", () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", "buildings-3d", () => {
          map.getCanvas().style.cursor = "";
        });

        map.on("click", "buildings-3d", (e) => {
          buildingClickHandledRef.current = true;
          if (!e.features || e.features.length === 0) return;
          const props = e.features[0].properties;
          const isEvac = props.is_evac_center === true || props.is_evac_center === "true";
          const bName =
            props.building_name ||
            (isEvac ? props.evac_center_name : "") ||
            `${props.building_type || "Building"} (${props.building_id})`;
          const depth = Number(props.flood_depth_m || 0);
          const tier = props.risk_tier || "safe";
          const cat = props.infra_category || "residential";

          const iconMap = {
            education: "School / Educational",
            healthcare: "Hospital / Clinic",
            emergency_civic: "Civic / Emergency",
            religious: "Place of Worship",
            commercial_logistics: "Commercial / Logistics",
            residential: "Residential",
          };
          const catLabel = isEvac
            ? "Designated Evac Center"
            : iconMap[cat] || "Building";
          const tierColor =
            tier === "critical"
              ? "#c4242a"
              : tier === "medium"
                ? "#d97706"
                : tier === "low"
                  ? "#1e7b4f"
                  : "#64748b";
          const tierLabel =
            tier === "safe"
              ? "Dry / Safe"
              : `${tier.toUpperCase()} (${depth.toFixed(2)}m)`;

          const html = `
            <div style="font-family: inherit; font-size: 13px; color: #1e293b; padding: 4px;">
              <div style="font-weight: 700; font-size: 14px; margin-bottom: 4px; color: #0f172a;">${bName}</div>
              <div style="display: flex; gap: 6px; align-items: center; margin-bottom: 8px; flex-wrap: wrap;">
                <span style="display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: 600; background: ${isEvac ? "#fee2e2" : "#f1f5f9"}; color: ${isEvac ? "#991b1b" : "#334155"};">
                  ${catLabel}
                </span>
                <span style="display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: 600; background: ${tierColor}20; color: ${tierColor};">
                  ${tierLabel}
                </span>
                <span style="font-size: 11px; color: #64748b;">Brgy. ${props.barangay || "SAN JOSE"}</span>
              </div>
              <div style="border-top: 1px solid #e2e8f0; /* taste-skill-ignore */ padding-top: 6px; display: grid; grid-template-columns: 1fr 1fr; gap: 6px; font-size: 12px;">
                <div><span style="color:#64748b;">Flood Depth:</span> <strong style="color: ${tierColor};">${depth > 0 ? depth.toFixed(2) + " m" : "Dry"}</strong></div>
                <div><span style="color:#64748b;">Ground DEM:</span> <strong>${Number(props.ground_elev_m || 0).toFixed(1)} m</strong></div>
                <div><span style="color:#64748b;">Footprint:</span> <strong>${Number(props.footprint_sqm || 0).toFixed(0)} m²</strong></div>
                <div><span style="color:#64748b;">Extrusion:</span> <strong>${Number(props.height_m || 5).toFixed(1)} m</strong></div>
              </div>
              ${isEvac ? `<div style="margin-top: 8px; padding: 6px; background: #fef2f2; border: 1px solid #fecaca; border-radius: 4px; font-size: 11px; color: #991b1b; font-weight: 600;">ALERT: Evacuation center at risk — floodwaters detected in compound.</div>` : ""}
            </div>
          `;
          bldgPopup.setLngLat(e.lngLat).setHTML(html).addTo(map);
        });

        map.addSource("fov-viewcone", {
          type: "geojson",
          data: viewconeGeojson,
        });
        map.addLayer({
          id: "fov-viewcone-fill",
          type: "fill",
          source: "fov-viewcone",
          paint: {
            "fill-color": "#131416",
            "fill-opacity": 0.1,
          },
        });
        map.addLayer({
          id: "fov-viewcone-line",
          type: "line",
          source: "fov-viewcone",
          paint: {
            "line-color": "#131416",
            "line-width": 1.5,
            "line-dasharray": [3, 2],
          },
        });

        map.addSource("target-ray", {
          type: "geojson",
          data: rayLineGeojson,
        });
        map.addLayer({
          id: "target-ray-line",
          type: "line",
          source: "target-ray",
          paint: {
            "line-color": "#c4242a",
            "line-width": 2.5,
          },
        });

        map.addSource("severed-roads", {
          type: "geojson",
          data: triageData?.severed_roads_geojson || { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "severed-roads-line",
          type: "line",
          source: "severed-roads",
          paint: {
            "line-color": "#c4242a",
            "line-width": 2,
            "line-opacity": 0.65,
          },
        });

        map.addSource("rescue-route", {
          type: "geojson",
          data: triageData?.route_geojson || { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "rescue-route-line",
          type: "line",
          source: "rescue-route",
          paint: {
            "line-color": "#1e7b4f",
            "line-width": 4,
            "line-dasharray": [2, 1],
          },
        });

        map.addSource("evacuation-centers", {
          type: "geojson",
          data: evacCentersGeojson || { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "evacuation-centers-circle",
          type: "circle",
          source: "evacuation-centers",
          paint: {
            "circle-radius": 6.5,
            "circle-color": "#1e7b4f",
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 2,
          },
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

  // Fly to camera position only once on initial map load
  useEffect(() => {
    if (!mapRef.current || !mapReady || hasInitialFlownRef.current) return;
    mapRef.current.flyTo({
      center: [cameraParams.cam_lon, cameraParams.cam_lat],
      zoom: 15.5,
      pitch: 50,
      duration: 650,
    });
    hasInitialFlownRef.current = true;
  }, [mapReady]);

  useEffect(() => {
    if (cameraMarkerRef.current) {
      cameraMarkerRef.current.setLngLat([cameraParams.cam_lon, cameraParams.cam_lat]);
    }
    if (!mapRef.current || !mapReady) return;
    const map = mapRef.current;

    map.getSource("fov-viewcone")?.setData(viewconeGeojson);
    map.getSource("target-ray")?.setData(rayLineGeojson);
    if (floodProjection?.flood_geojson) {
      map.getSource("flood-extent")?.setData(floodProjection.flood_geojson);
    }
    if (floodProjection?.buildings_geojson) {
      map.getSource("buildings-source")?.setData(floodProjection.buildings_geojson);
    }
    if (triageData?.route_geojson) {
      map.getSource("rescue-route")?.setData(triageData.route_geojson);
    }
    if (triageData?.severed_roads_geojson) {
      map.getSource("severed-roads")?.setData(triageData.severed_roads_geojson);
    }
    if (boundaryGeojson) {
      map.getSource("rodriguez-boundary")?.setData(boundaryGeojson);
    }
    if (evacCentersGeojson) {
      map.getSource("evacuation-centers")?.setData(evacCentersGeojson);
    }
  }, [
    mapReady,
    viewconeGeojson,
    rayLineGeojson,
    floodProjection,
    triageData,
    boundaryGeojson,
    evacCentersGeojson,
    cameraParams.cam_lon,
    cameraParams.cam_lat,
  ]);

  const handleRecenter = () => {
    if (mapRef.current) {
      mapRef.current.flyTo({
        center: [cameraParams.cam_lon, cameraParams.cam_lat],
        zoom: 15.6,
        pitch: 50,
        duration: 600,
      });
    }
  };

  const handleViewWholeMontalban = () => {
    if (mapRef.current) {
      mapRef.current.flyTo({
        center: [121.162, 14.756],
        zoom: 11.8,
        pitch: 25,
        bearing: 0,
        duration: 700,
      });
    }
  };

  const groundDem = floodProjection?.ground_dem_m ?? 34.54;
  const waterDepth = floodProjection?.measured_depth_m ?? cameraParams.water_depth_m ?? 1.35;
  const wse = floodProjection?.water_surface_elev_m ?? Number((groundDem + waterDepth).toFixed(2));
  const targetLat = floodProjection?.target_lat ?? 14.74964;
  const targetLon = floodProjection?.target_lon ?? 121.13751;
  const summary = floodProjection?.inundated_structures || {
    barangay: cameraParams.barangay || "SAN JOSE",
    low_depth_count: 39,
    medium_depth_count: 53,
    critical_depth_count: 216,
  };

  return (
    <section className="panel-card" aria-label="3D DEM viewcone and flood extent map">
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
            3D DEM catchment & viewcone — Brgy. {summary.barangay || cameraParams.barangay}
          </h2>
          <p style={{ margin: "2px 0 0 0", fontSize: "13px", color: "var(--muted)" }}>
            Click anywhere on map or drag pin · Cam{" "}
            <span className="mono-id">{cameraParams.cam_lat.toFixed(4)}, {cameraParams.cam_lon.toFixed(4)}</span> → Target{" "}
            <span className="mono-id">{targetLat.toFixed(4)}, {targetLon.toFixed(4)}</span>
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <button
            type="button"
            className={isCameraLocked ? "btn-primary" : "btn-secondary"}
            onClick={() => setIsCameraLocked((prev) => !prev)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              backgroundColor: isCameraLocked ? "#155e3b" : undefined,
              borderColor: isCameraLocked ? "#155e3b" : undefined,
              color: isCameraLocked ? "#ffffff" : undefined,
            }}
            title={
              isCameraLocked
                ? "Incident pin is anchored. Click to allow repositioning pin."
                : "Incident pin is mobile. Click anywhere on map to relocate."
            }
          >
            {isCameraLocked ? <Lock size={14} /> : <MapPin size={14} />}
            <span>{isCameraLocked ? "Pin Anchored" : "Pin Mobile"}</span>
          </button>
          <button type="button" className="btn-secondary" onClick={handleViewWholeMontalban}>
            <Globe size={14} />
            Whole Montalban
          </button>
          <button type="button" className="btn-secondary" onClick={handleRecenter}>
            <Compass size={14} />
            Zoom to pin
          </button>
        </div>
      </div>

      {/* Infrastructure Impact Strip */}
      <div
        style={{
          display: "flex",
          gap: "8px",
          alignItems: "center",
          flexWrap: "wrap",
          padding: "6px 10px",
          backgroundColor: "var(--raised)",
          border: "1px solid var(--border)",
          borderRadius: "6px",
          fontSize: "12px",
        }}
      >
        <span style={{ fontWeight: 600, color: "var(--text)" }}>
          Infras at risk:
        </span>
        {summary.affected_evac_centers_count > 0 && (
          <span className="status-pill critical" style={{ fontWeight: 600, display: "inline-flex", alignItems: "center", gap: "4px" }}>
            <AlertTriangle size={12} />
            <span>{summary.affected_evac_centers_count} Evac Center{summary.affected_evac_centers_count > 1 ? "s" : ""} Compromised</span>
          </span>
        )}
        {summary.affected_schools_count > 0 && (
          <span className="status-pill warning" style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
            <School size={12} />
            <span>{summary.affected_schools_count} School{summary.affected_schools_count > 1 ? "s" : ""}</span>
          </span>
        )}
        {summary.affected_healthcare_count > 0 && (
          <span className="status-pill critical" style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
            <HeartPulse size={12} />
            <span>{summary.affected_healthcare_count} Clinic / Health Unit</span>
          </span>
        )}
        {summary.affected_civic_count > 0 && (
          <span className="status-pill neutral" style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
            <Landmark size={12} />
            <span>{summary.affected_civic_count} Civic Facility</span>
          </span>
        )}
        {summary.affected_commercial_count > 0 && (
          <span className="status-pill neutral" style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
            <Building2 size={12} />
            <span>{summary.affected_commercial_count} Commercial</span>
          </span>
        )}
        {summary.affected_residential_count > 0 && (
          <span className="status-pill neutral" style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
            <Home size={12} />
            <span>{summary.affected_residential_count} Homes</span>
          </span>
        )}
        {summary.affected_structures === 0 && (
          <span style={{ color: "var(--muted)" }}>No structures within simulated flood zone.</span>
        )}
        <span style={{ marginLeft: "auto", fontSize: "11px", color: "var(--muted)", display: "inline-flex", alignItems: "center", gap: "4px" }}>
          <Info size={12} />
          <span>Click any 3D footprint for depth & facility data</span>
        </span>
      </div>

      {/* MapLibre 3D Canvas */}
      <div
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: "16 / 9",
          borderRadius: "6px",
          overflow: "hidden",
          border: "1px solid var(--border)",
          backgroundColor: "#eef2f5",
        }}
      >
        <div
          ref={mapContainerRef}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
          }}
        />

        {/* Top-Left Legend inside Map Frame */}
        <div
          style={{
            position: "absolute",
            top: "10px",
            left: "10px",
            backgroundColor: "rgba(255, 255, 255, 0.94)",
            border: "1px solid var(--border)",
            borderRadius: "4px",
            padding: "6px 10px",
            fontSize: "13px",
            display: "flex",
            flexWrap: "wrap",
            gap: "10px",
            pointerEvents: "none",
          }}
        >
          <strong style={{ color: "var(--text)", fontWeight: 600 }}>DEM depth:</strong>
          <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
            <span style={{ width: "9px", height: "9px", backgroundColor: "#1e7b4f", display: "inline-block" }} />
            &lt;0.5 m ({summary.low_depth_count})
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
            <span style={{ width: "9px", height: "9px", backgroundColor: "#d97706", display: "inline-block" }} />
            0.5–1.5 m ({summary.medium_depth_count})
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
            <span style={{ width: "9px", height: "9px", backgroundColor: "#c4242a", display: "inline-block" }} />
            &gt;1.5 m ({summary.critical_depth_count})
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", color: "var(--muted)" }}>
            <span style={{ width: "9px", height: "9px", backgroundColor: "#94a3b8", display: "inline-block" }} />
            Dry ({summary.safe_count ?? 0})
          </span>
        </div>
      </div>

      {/* Hydro-Spatial Raycast & WSE Cross-Section Profile (Signature Element) */}
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: "6px",
          padding: "12px",
          backgroundColor: "var(--raised)",
          display: "flex",
          flexDirection: "column",
          gap: "8px",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "13px", flexWrap: "wrap", gap: "6px" }}>
          <strong style={{ color: "var(--text)", fontWeight: 600 }}>
            Raycast-to-DEM hydrological profile (WSE = Z_DEM + h_w)
          </strong>
          <span className="mono-id" style={{ color: "var(--muted)" }}>
            {wse.toFixed(2)} m MSL = {groundDem.toFixed(2)} m + {waterDepth.toFixed(2)} m
          </span>
        </div>

        <svg
          viewBox="0 0 640 108"
          style={{
            width: "100%",
            height: "108px",
            display: "block",
            backgroundColor: "#ffffff",
            border: "1px solid var(--border)",
            borderRadius: "4px",
          }}
          role="img"
          aria-label="Topographic elevation cross section showing camera ray, DEM ground profile, and water surface elevation"
        >
          <line x1="48" y1="22" x2="620" y2="22" stroke="#e5e8eb" strokeWidth="1" />
          <line x1="48" y1="54" x2="620" y2="54" stroke="#e5e8eb" strokeWidth="1" />
          <line x1="48" y1="86" x2="620" y2="86" stroke="#e5e8eb" strokeWidth="1" />

          <text x="8" y="26" fontSize="12" fill="#525659" fontFamily="IBM Plex Sans, sans-serif">
            {(groundDem + 3.0).toFixed(1)}m
          </text>
          <text x="8" y="58" fontSize="12" fill="#525659" fontFamily="IBM Plex Sans, sans-serif">
            {wse.toFixed(1)}m
          </text>
          <text x="8" y="90" fontSize="12" fill="#525659" fontFamily="IBM Plex Sans, sans-serif">
            {groundDem.toFixed(1)}m
          </text>

          {/* Continuous Water Volume from Camera Operator (0 m) across Target Flooded Street Basin */}
          <polygon
            points="48,54 585,54 558,84 415,86 220,86 88,83 48,82"
            fill="rgba(27, 108, 128, 0.24)"
          />
          <line x1="48" y1="54" x2="585" y2="54" stroke="#1b6c80" strokeWidth="2.2" />

          {/* Submerged Bare-Earth Street DEM Profile (Camera Operator at x=88 is standing IN the water) */}
          <polyline
            points="48,82 88,83 220,86 355,86 465,85 558,84 585,54 620,40"
            fill="none"
            stroke="#131416"
            strokeWidth="2.5"
          />

          {/* Vertical Plumb Line at Camera (x=88, 0 m): Submerged Feet on DEM (y=83) -> Waterline (y=54) -> Handheld Camera Lens (y=24) */}
          <line x1="88" y1="24" x2="88" y2="83" stroke="#131416" strokeWidth="1.5" strokeDasharray="2,2" />
          <circle cx="88" cy="83" r="3.5" fill="#131416" />
          <circle cx="88" cy="54" r="3.5" fill="#1b6c80" />
          <circle cx="88" cy="24" r="4.5" fill="#131416" />

          {/* Optical Ray from Handheld Camera Lens (88,24) to Target Reference Waterline (355,54) */}
          <line x1="88" y1="24" x2="355" y2="54" stroke="#c4242a" strokeWidth="1.8" strokeDasharray="4,3" />
          <line x1="355" y1="54" x2="355" y2="86" stroke="#c4242a" strokeWidth="1.5" strokeDasharray="2,2" />
          <circle cx="355" cy="54" r="4.5" fill="#c4242a" />

          <text x="98" y="21" fontSize="12" fill="#131416" fontFamily="IBM Plex Sans, sans-serif" fontWeight="500">
            Cam @ 0 m (in {waterDepth.toFixed(2)} m water, lens +1.6 m)
          </text>
          <text x="364" y="48" fontSize="12" fill="#1b6c80" fontFamily="IBM Plex Sans, sans-serif" fontWeight="600">
            Target @ {cameraParams.est_distance_m} m · WSE {wse.toFixed(2)} m
          </text>
        </svg>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: "13px",
            color: "var(--muted)",
            flexWrap: "wrap",
            gap: "8px",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
            <Navigation size={13} />
            Active rescue route:{" "}
            <strong style={{ color: "var(--text)" }}>
              {triageData?.evacuation_center_name || "Kasiglahan Village Elementary School"}
            </strong>
          </span>
          <span className="num">
            Corridor: <strong style={{ color: "var(--positive)" }}>{Math.round(triageData?.route_distance_m ?? 774)} m</strong> · ETA{" "}
            <strong style={{ color: "var(--text)" }}>{(triageData?.eta_minutes ?? 6.5).toFixed(1)} min</strong>
          </span>
        </div>
      </div>
    </section>
  );
}
