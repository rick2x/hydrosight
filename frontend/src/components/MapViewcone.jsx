import React, { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { sector, point, lineString } from "@turf/turf";
import { Compass, Navigation, Globe, Lock, MapPin, Info, RefreshCw } from "lucide-react";
import { pickClickTarget, evacPopupHtml } from "../utils/mapClick.js";

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
  onUpdateCameraParams,
  cameraPinPlaced = true,
  onConfirmPin,
  activeStep = 2,
  projectionLoading = false,
  triageLoading = false,
}) {
  const isMapComputing = projectionLoading || triageLoading;
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const cameraMarkerRef = useRef(null);
  const evacMarkerRef = useRef(null);
  const onUpdateCoordsRef = useRef(onUpdateCameraCoords);
  const [mapReady, setMapReady] = useState(false);
  const [isCameraLocked, setIsCameraLocked] = useState(cameraPinPlaced);
  const isCameraLockedRef = useRef(cameraPinPlaced);
  const buildingClickHandledRef = useRef(false);
  const popupRef = useRef(null);
  const showEvacPopup = (lngLat, feature, fallbackName) => {
    const map = mapRef.current;
    if (!map) return;
    if (!popupRef.current) popupRef.current = new maplibregl.Popup({ closeButton: true, closeOnClick: false, maxWidth: "320px" });
    popupRef.current.setLngLat(lngLat).setHTML(evacPopupHtml(feature, fallbackName)).addTo(map);
  };
  const hasInitialFlownRef = useRef(false);
  const hasRouteFlownRef = useRef(false);
  const lastCameraCenterRef = useRef(null);

  useEffect(() => {
    // Keep the lock in sync with placement decided outside this panel (e.g.
    // an EXIF geotag pre-places the pin in App): placed = anchored, not
    // placed = draggable. The header toggle can still unlock it manually.
    setIsCameraLocked(Boolean(cameraPinPlaced));
    isCameraLockedRef.current = Boolean(cameraPinPlaced);
    if (cameraMarkerRef.current) {
      cameraMarkerRef.current.setDraggable(!cameraPinPlaced);
    }
  }, [cameraPinPlaced]);

  useEffect(() => {
    if (activeStep === 2 && mapRef.current) {
      const timer = setTimeout(() => {
        try {
          mapRef.current.resize();
        } catch {}
      }, 60);
      return () => clearTimeout(timer);
    }
  }, [activeStep]);

  const routeFeatures = triageData?.route_geojson?.features;
  const routeCoords = useMemo(() => {
    return routeFeatures?.[0]?.geometry?.coordinates || [];
  }, [routeFeatures]);

  const waypointsGeojson = useMemo(() => {
    if (!routeCoords || routeCoords.length < 2) {
      return { type: "FeatureCollection", features: [] };
    }
    const pts = routeCoords.slice(1, -1).filter((_, idx) => idx % 2 === 0);
    return {
      type: "FeatureCollection",
      features: pts.map((pt, i) => ({
        type: "Feature",
        properties: { id: i },
        geometry: { type: "Point", coordinates: pt },
      })),
    };
  }, [routeCoords]);

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

    let targetLon = floodProjection?.target_lon;
    let targetLat = floodProjection?.target_lat;
    if (targetLon == null || targetLat == null) {
      const angleOffset = (cameraParams.click_u - 0.5) * cameraParams.fov_deg;
      const targetBearingRad = ((cameraParams.azimuth_deg + angleOffset) * Math.PI) / 180.0;
      const distDeg = (cameraParams.est_distance_m || 38.0) / 111320.0;
      targetLon = cameraParams.cam_lon + (distDeg * Math.sin(targetBearingRad)) / Math.cos((cameraParams.cam_lat * Math.PI) / 180.0);
      targetLat = cameraParams.cam_lat + distDeg * Math.cos(targetBearingRad);
    }
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
    cameraParams.click_u,
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
      markerEl.style.backgroundColor = "#0f172a";
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

      map.on("click", (e) => {
        if (!e.lngLat) return;
        if (buildingClickHandledRef.current) {
          buildingClickHandledRef.current = false;
          return;
        }
        if (isCameraLockedRef.current) {
          return;
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
            "fill-color": "#0e7490",
            "fill-opacity": 0.04,
          },
        });
        map.addLayer({
          id: "rodriguez-boundary-line",
          type: "line",
          source: "rodriguez-boundary",
          paint: {
            "line-color": "#475569",
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
            "fill-color": ["coalesce", ["get", "fill_color"], "#15803d"],
            "fill-opacity": 0.42,
          },
        });
        map.addLayer({
          id: "flood-extent-outline",
          type: "line",
          source: "flood-extent",
          paint: {
            "line-color": ["coalesce", ["get", "line_color"], ["get", "fill_color"], "#166534"],
            "line-width": 1.6,
          },
        });

        // Observation corridor: a separate layer, NOT flood extent
        map.addSource("observation-corridor", {
          type: "geojson",
          data: floodProjection?.corridor_geojson || { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "observation-corridor-fill",
          type: "fill",
          source: "observation-corridor",
          paint: {
            "fill-color": "#7c3aed",
            "fill-opacity": 0.12,
          },
        });
        map.addLayer({
          id: "observation-corridor-outline",
          type: "line",
          source: "observation-corridor",
          paint: {
            "line-color": "#7c3aed",
            "line-width": 1.2,
            "line-dasharray": [3, 3],
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
            "fill-extrusion-opacity": 0.52,
          },
        });

        const bldgPopup = new maplibregl.Popup({
          closeButton: true,
          closeOnClick: false,
          maxWidth: "320px",
        });
        popupRef.current = bldgPopup;

        map.on("mouseenter", "buildings-3d", () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", "buildings-3d", () => {
          map.getCanvas().style.cursor = "";
        });

        map.on("click", "buildings-3d", (e) => {
          buildingClickHandledRef.current = true;
          if (!e.features || e.features.length === 0) return;
          // An evac centre at this point (its label/circle sits over the
          // footprints) wins: describe the labelled centre, not the building.
          let evacFeatures = [];
          try { evacFeatures = map.queryRenderedFeatures(e.point, { layers: ["evacuation-centers-circle", "evacuation-centers-halo"] }); } catch {}
          const picked = pickClickTarget({ buildingFeatures: e.features, evacFeatures });
          if (picked?.kind === "evac") { showEvacPopup(e.lngLat, picked.feature); return; }
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
          const catLabel = isEvac ? "Designated Evac Center" : iconMap[cat] || "Building";
          const tierColor =
            tier === "critical"
              ? "#b91c1c"
              : tier === "medium"
              ? "#b45309"
              : tier === "low"
              ? "#15803d"
              : "#64748b";
          const tierLabel = tier === "safe" ? "Dry / Safe" : `${tier.toUpperCase()} (${depth.toFixed(2)}m)`;

          const html = `
            <div style="font-family: inherit; font-size: 12.5px; color: #0f172a; padding: 4px;">
              <div style="font-weight: 600; font-size: 13.5px; margin-bottom: 4px; color: #0f172a;">${bName}</div>
              <div style="display: flex; gap: 6px; align-items: center; margin-bottom: 8px; flex-wrap: wrap;">
                <span style="display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 500; background: ${isEvac ? "#fef2f2" : "#f1f5f9"}; color: ${isEvac ? "#991b1b" : "#475569"};">
                  ${catLabel}
                </span>
                <span style="display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 500; background: ${tierColor}18; color: ${tierColor};">
                  ${tierLabel}
                </span>
                <span style="font-size: 11px; color: #64748b;">Brgy. ${props.barangay || "SAN JOSE"}</span>
              </div>
              <div style="border-top: 1px solid #e2e8f0; /* taste-skill-ignore */ padding-top: 6px; display: grid; grid-template-columns: 1fr 1fr; gap: 5px; font-size: 11.5px;">
                <div><span style="color:#64748b;">Flood Depth:</span> <strong style="color: ${tierColor};">${depth > 0 ? depth.toFixed(2) + " m" : "Dry"}</strong></div>
                <div><span style="color:#64748b;">Ground DEM:</span> <strong>${Number(props.ground_elev_m || 0).toFixed(1)} m</strong></div>
                <div><span style="color:#64748b;">Footprint:</span> <strong>${Number(props.footprint_sqm || 0).toFixed(0)} m²</strong></div>
                <div><span style="color:#64748b;">Height:</span> <strong>${Number(props.height_m || 5).toFixed(1)} m</strong></div>
              </div>
              ${isEvac ? `<div style="margin-top: 6px; padding: 5px 8px; background: #fef2f2; border: 1px solid #fecaca; border-radius: 4px; font-size: 11px; color: #991b1b; font-weight: 500;">ALERT: Evacuation center within active flood zone.</div>` : ""}
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
            "fill-color": "#0f172a",
            "fill-opacity": 0.08,
          },
        });
        map.addLayer({
          id: "fov-viewcone-line",
          type: "line",
          source: "fov-viewcone",
          paint: {
            "line-color": "#0f172a",
            "line-width": 1.4,
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
            "line-color": "#b91c1c",
            "line-width": 2.2,
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
            "line-color": "#b91c1c",
            "line-width": 2,
            "line-opacity": 0.65,
          },
        });

        map.addSource("rescue-route", {
          type: "geojson",
          data: triageData?.route_geojson || { type: "FeatureCollection", features: [] },
        });
        // High-contrast outer casing: separates route cleanly from green water, grass, and buildings
        map.addLayer({
          id: "rescue-route-casing",
          type: "line",
          source: "rescue-route",
          paint: {
            "line-color": "#ffffff",
            "line-width": 9.5,
            "line-opacity": 0.95,
          },
        });
        // High-visibility electric blue primary corridor
        map.addLayer({
          id: "rescue-route-line",
          type: "line",
          source: "rescue-route",
          paint: {
            "line-color": "#0284c7",
            "line-width": 5.5,
            "line-opacity": 1.0,
          },
        });
        // Center white dashed navigation guide
        map.addLayer({
          id: "rescue-route-center",
          type: "line",
          source: "rescue-route",
          paint: {
            "line-color": "#ffffff",
            "line-width": 2.0,
            "line-dasharray": [3, 2],
            "line-opacity": 0.95,
          },
        });

        // Intermediate corridor waypoints for visual orientation
        map.addSource("rescue-route-waypoints", {
          type: "geojson",
          data: waypointsGeojson,
        });
        map.addLayer({
          id: "rescue-route-waypoints-circle",
          type: "circle",
          source: "rescue-route-waypoints",
          paint: {
            "circle-radius": 4.5,
            "circle-color": "#ffffff",
            "circle-stroke-color": "#0284c7",
            "circle-stroke-width": 2.5,
          },
        });

        map.addSource("evacuation-centers", {
          type: "geojson",
          data: evacCentersGeojson || { type: "FeatureCollection", features: [] },
        });
        // Evacuation Center destination beacon halo
        map.addLayer({
          id: "evacuation-centers-halo",
          type: "circle",
          source: "evacuation-centers",
          paint: {
            "circle-radius": 13,
            "circle-color": "#0284c7",
            "circle-opacity": 0.22,
          },
        });
        // Evacuation Center destination core marker
        map.addLayer({
          id: "evacuation-centers-circle",
          type: "circle",
          source: "evacuation-centers",
          paint: {
            "circle-radius": 7.5,
            "circle-color": "#0284c7",
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 2.5,
          },
        });

        map.on("mouseenter", "evacuation-centers-circle", () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", "evacuation-centers-circle", () => {
          map.getCanvas().style.cursor = "";
        });
        map.on("click", "evacuation-centers-circle", (e) => {
          buildingClickHandledRef.current = true;
          if (!e.features || e.features.length === 0) return;
          showEvacPopup(e.lngLat, e.features[0]);
        });

        setMapReady(true);
      });

      mapRef.current = map;
      window.__hydrosight_map = map;
    } catch {
      setMapReady(false);
    }

    return () => {
      delete window.__hydrosight_map;
      if (evacMarkerRef.current) {
        evacMarkerRef.current.remove();
        evacMarkerRef.current = null;
      }
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  // Sync high-visibility HTML DOM destination marker for the active evacuation center
  useEffect(() => {
    if (!mapRef.current || !mapReady) return;
    const map = mapRef.current;
    if (routeCoords && routeCoords.length >= 2) {
      const [startLon, startLat] = routeCoords[0];
      const evacName = triageData?.evacuation_center_name || "Designated Safe Shelter";
      const markerLabel = `<span style="display:inline-block; width:6px; height:6px; background:#ffffff; border-radius:50%;"></span><span>${evacName} (Safe Shelter)</span>`;
      if (!evacMarkerRef.current) {
        const el = document.createElement("div");
        el.className = "evac-dest-marker";
        el.style.cssText =
          "display: inline-flex; align-items: center; gap: 5px; background-color: #0284c7; color: #ffffff; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; border: 1.5px solid #ffffff; white-space: nowrap; pointer-events: auto; cursor: pointer; margin-top: 10px;";
        el.innerHTML = markerLabel;
        el.title = evacName;
        el.dataset.evacName = evacName;
        el.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const marker = evacMarkerRef.current;
          showEvacPopup(marker ? marker.getLngLat() : [startLon, startLat], { properties: { name: el.dataset.evacName || evacName, is_selected: true } }, el.dataset.evacName || evacName);
        });
        evacMarkerRef.current = new maplibregl.Marker({ element: el, anchor: "top" })
          .setLngLat([startLon, startLat])
          .addTo(map);
      } else {
        evacMarkerRef.current.setLngLat([startLon, startLat]);
        const el = evacMarkerRef.current.getElement();
        el.innerHTML = markerLabel;
        el.title = evacName;
        el.dataset.evacName = evacName;
      }
    } else if (evacMarkerRef.current) {
      evacMarkerRef.current.remove();
      evacMarkerRef.current = null;
    }
  }, [mapReady, routeCoords, triageData?.evacuation_center_name]);

  // Auto-frame rescue corridor on initial calculation or camera location change
  useEffect(() => {
    if (!mapRef.current || !mapReady) return;
    if (routeCoords && routeCoords.length >= 2 && !hasRouteFlownRef.current) {
      const bounds = new maplibregl.LngLatBounds();
      bounds.extend([cameraParams.cam_lon, cameraParams.cam_lat]);
      routeCoords.forEach((pt) => bounds.extend(pt));
      mapRef.current.fitBounds(bounds, {
        padding: { top: 60, bottom: 50, left: 60, right: 60 },
        pitch: 32,
        maxZoom: 16.0,
        duration: 350,
      });
      hasRouteFlownRef.current = true;
      mapRef.current.triggerRepaint();
    } else if (!hasInitialFlownRef.current) {
      mapRef.current.flyTo({
        center: [cameraParams.cam_lon, cameraParams.cam_lat],
        zoom: 15.5,
        pitch: 50,
        duration: 400,
      });
      hasInitialFlownRef.current = true;
    }
  }, [mapReady, routeCoords]);

  useEffect(() => {
    if (!mapRef.current || !mapReady) return;
    const key = `${cameraParams.cam_lon},${cameraParams.cam_lat}`;
    if (lastCameraCenterRef.current === null) {
      lastCameraCenterRef.current = key; // first ready: initial fly handles it
      return;
    }
    if (lastCameraCenterRef.current === key) return;
    lastCameraCenterRef.current = key;
    try {
      mapRef.current.flyTo({
        center: [cameraParams.cam_lon, cameraParams.cam_lat],
        zoom: Math.max(mapRef.current.getZoom(), 15.5),
        pitch: 50,
        duration: 650,
      });
    } catch {}
  }, [mapReady, cameraParams.cam_lon, cameraParams.cam_lat]);

  useEffect(() => {
    if (cameraMarkerRef.current) {
      cameraMarkerRef.current.setLngLat([cameraParams.cam_lon, cameraParams.cam_lat]);
    }
    if (!mapRef.current || !mapReady) return;
    const map = mapRef.current;

    map.getSource("fov-viewcone")?.setData(viewconeGeojson);
    map.getSource("target-ray")?.setData(rayLineGeojson);
    map.getSource("flood-extent")?.setData(floodProjection?.flood_geojson || { type: "FeatureCollection", features: [] });
    map.getSource("observation-corridor")?.setData(floodProjection?.corridor_geojson || { type: "FeatureCollection", features: [] });
    map.getSource("buildings-source")?.setData(floodProjection?.buildings_geojson || { type: "FeatureCollection", features: [] });
    map.getSource("rescue-route")?.setData(triageData?.route_geojson || { type: "FeatureCollection", features: [] });
    map.getSource("rescue-route-waypoints")?.setData(waypointsGeojson);
    map.getSource("severed-roads")?.setData(triageData?.severed_roads_geojson || { type: "FeatureCollection", features: [] });
    if (boundaryGeojson) {
      map.getSource("rodriguez-boundary")?.setData(boundaryGeojson);
    }
    if (evacCentersGeojson) {
      map.getSource("evacuation-centers")?.setData(evacCentersGeojson);
    }
    map.triggerRepaint();
  }, [
    mapReady,
    viewconeGeojson,
    rayLineGeojson,
    floodProjection,
    triageData,
    waypointsGeojson,
    boundaryGeojson,
    evacCentersGeojson,
    cameraParams.cam_lon,
    cameraParams.cam_lat,
  ]);

  const handleFocusRoute = () => {
    if (!mapRef.current) return;
    if (routeCoords && routeCoords.length >= 2) {
      const bounds = new maplibregl.LngLatBounds();
      bounds.extend([cameraParams.cam_lon, cameraParams.cam_lat]);
      routeCoords.forEach((pt) => bounds.extend(pt));
      mapRef.current.fitBounds(bounds, {
        padding: { top: 60, bottom: 50, left: 60, right: 60 },
        pitch: 32,
        maxZoom: 16.0,
        duration: 400,
      });
      mapRef.current.triggerRepaint();
    } else {
      handleRecenter();
    }
  };
  window.__hydrosight_focus_route = handleFocusRoute;

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

  const groundDem = floodProjection?.cam_ground_dem_m ?? floodProjection?.ground_dem_m ?? 34.54;
  const waterDepth = floodProjection?.measured_depth_m ?? cameraParams.water_depth_m ?? 1.35;
  const wse = floodProjection?.water_surface_elev_m ?? Number((groundDem + waterDepth).toFixed(2));
  const targetLat = floodProjection?.target_lat ?? 14.74964;
  const targetLon = floodProjection?.target_lon ?? 121.13751;
  const clickU = cameraParams.click_u ?? 0.5;
  const targetBearingDeg = (
    ((cameraParams.azimuth_deg ?? 118) + (clickU - 0.5) * (cameraParams.fov_deg ?? 65) + 360) %
    360
  ).toFixed(1);
  const summary = floodProjection?.inundated_structures || {
    barangay: cameraParams.barangay || "SAN JOSE",
    total_structures: 2797,
    affected_structures: 838,
    low_depth_count: 14,
    medium_depth_count: 44,
    critical_depth_count: 780,
    safe_count: 1959,
    affected_evac_centers_count: 14,
    affected_schools_count: 12,
    affected_healthcare_count: 0,
    affected_civic_count: 12,
    affected_residential_count: 810,
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
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <h2 style={{ fontSize: "15px", fontWeight: 600, margin: 0, color: "var(--text)" }}>
              Step 2 · 3D hydro-spatial terrain & rescue corridor
            </h2>
            {isMapComputing && (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                  padding: "1px 6px",
                  borderRadius: "4px",
                  fontSize: "11px",
                  fontWeight: 500,
                  backgroundColor: "rgba(2, 132, 199, 0.08)",
                  color: "var(--accent-strong)",
                }}
              >
                <RefreshCw size={10} className="spin" />
                <span>Recalculating...</span>
              </span>
            )}
          </div>
          <p style={{ margin: "2px 0 0 0", fontSize: "12.5px", color: "var(--muted)" }}>
            Cam <span className="mono-id">{cameraParams.cam_lat.toFixed(4)}, {cameraParams.cam_lon.toFixed(4)}</span> → Target{" "}
            <span className="mono-id">{targetLat.toFixed(4)}, {targetLon.toFixed(4)}</span>
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setIsCameraLocked((prev) => !prev)}
            style={{ fontSize: "12px", padding: "0 10px" }}
            title={
              isCameraLocked
                ? "Camera pin is anchored. Click to allow dragging pin."
                : "Camera pin is mobile. Click anywhere on map to relocate."
            }
          >
            {isCameraLocked ? <Lock size={12} color="var(--positive)" /> : <MapPin size={12} color="var(--accent)" />}
            <span>{isCameraLocked ? "Pin anchored" : "Pin mobile"}</span>
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={handleFocusRoute}
            style={{ fontSize: "12px", padding: "0 10px" }}
            title="Focus and frame entire safe escape route corridor"
          >
            <Navigation size={12} color="var(--accent)" />
            <span>Corridor</span>
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={handleRecenter}
            style={{ fontSize: "12px", padding: "0 10px" }}
            title="Center map on street camera pin"
          >
            <Compass size={12} />
            <span>Camera</span>
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={handleViewWholeMontalban}
            style={{ fontSize: "12px", padding: "0 10px" }}
            title="Zoom out to whole Municipality of Rodriguez"
          >
            <Globe size={12} />
            <span>Overview</span>
          </button>
        </div>
      </div>

      {/* Step 2: Camera Station & Viewcone Frustum Calibration Deck */}
      <div className="camera-station-bar">
        {/* Azimuth Bearing Control */}
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "12px", flexWrap: "wrap", gap: "4px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <label htmlFor="map-slider-azimuth" style={{ fontWeight: 600, color: "var(--text)" }}>
                Azimuth heading (α)
              </label>
              <span className="num" style={{ fontWeight: 700, color: "var(--text)" }}>
                {cameraParams.azimuth_deg}°
              </span>
              <span style={{ fontSize: "11px", color: "var(--muted)" }}>
                (Ray θ = <span className="num">{targetBearingDeg}°</span>)
              </span>
            </div>

            {/* Quick Cardinal Snaps */}
            <div style={{ display: "flex", alignItems: "center", gap: "3px" }}>
              {[
                { label: "N", deg: 0 },
                { label: "E", deg: 90 },
                { label: "S", deg: 180 },
                { label: "W", deg: 270 },
              ].map((c) => (
                <button
                  key={c.label}
                  type="button"
                  className={`cardinal-btn ${Math.abs(cameraParams.azimuth_deg - c.deg) < 5 ? "active" : ""}`}
                  onClick={() => onUpdateCameraParams && onUpdateCameraParams({ azimuth_deg: c.deg })}
                  title={`Snap camera heading ${c.label} (${c.deg}°)`}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          <input
            id="map-slider-azimuth"
            type="range"
            min="0"
            max="360"
            step="1"
            value={cameraParams.azimuth_deg}
            onChange={(e) => onUpdateCameraParams && onUpdateCameraParams({ azimuth_deg: Number(e.target.value) })}
          />
        </div>

        {/* Horizontal FOV Aperture Control */}
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "12px", flexWrap: "wrap", gap: "4px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <label htmlFor="map-slider-fov" style={{ fontWeight: 600, color: "var(--text)" }}>
                Horizontal FOV aperture
              </label>
              <span className="num" style={{ fontWeight: 700, color: "var(--text)" }}>
                {cameraParams.fov_deg}°
              </span>
            </div>

            {/* Quick FOV Presets */}
            <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
              {[
                { label: "50° Narrow", fov: 50 },
                { label: "65° Standard", fov: 65 },
                { label: "80° Wide", fov: 80 },
              ].map((p) => (
                <button
                  key={p.fov}
                  type="button"
                  className={`cardinal-btn ${cameraParams.fov_deg === p.fov ? "active" : ""}`}
                  onClick={() => onUpdateCameraParams && onUpdateCameraParams({ fov_deg: p.fov })}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <input
            id="map-slider-fov"
            type="range"
            min="40"
            max="90"
            step="1"
            value={cameraParams.fov_deg}
            onChange={(e) => onUpdateCameraParams && onUpdateCameraParams({ fov_deg: Number(e.target.value) })}
          />
        </div>

        {/* Flood Water Depth Control (Migrated to Step 2) */}
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "12px", flexWrap: "wrap", gap: "4px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <label htmlFor="map-slider-depth" style={{ fontWeight: 600, color: "var(--text)" }}>
                Flood water depth (h_w)
              </label>
              <span className="num" style={{ fontWeight: 700, color: "var(--text)" }}>
                {cameraParams.water_depth_m.toFixed(2)} m
              </span>
            </div>

            {/* Quick Depth Presets */}
            <div style={{ display: "flex", alignItems: "center", gap: "3px" }}>
              {[
                { label: "0.5m", val: 0.5 },
                { label: "0.85m", val: 0.85 },
                { label: "1.35m", val: 1.35 },
                { label: "2.1m", val: 2.1 },
              ].map((p) => (
                <button
                  key={p.val}
                  type="button"
                  className={`cardinal-btn ${Math.abs(cameraParams.water_depth_m - p.val) < 0.04 ? "active" : ""}`}
                  onClick={() => onUpdateCameraParams && onUpdateCameraParams({ water_depth_m: p.val })}
                  title={`Set water depth to ${p.val}m`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <input
            id="map-slider-depth"
            type="range"
            min="0.2"
            max="3.5"
            step="0.05"
            value={cameraParams.water_depth_m}
            onChange={(e) => onUpdateCameraParams && onUpdateCameraParams({ water_depth_m: Number(e.target.value) })}
          />
        </div>
      </div>

      {/* Camera Pin Location Directive Banner */}
      {!cameraPinPlaced && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
            padding: "9px 14px",
            borderRadius: "6px",
            backgroundColor: "var(--accent-soft)",
            border: "1px solid var(--border)",
            color: "var(--text)",
            fontSize: "12.5px",
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <MapPin size={16} color="var(--accent)" />
            <span>
              <strong>Point photo location:</strong> Click anywhere on the map or drag the camera pin to set where this street flood photo was taken.
            </span>
          </div>
          <button
            type="button"
            className="btn-primary"
            onClick={() => onConfirmPin && onConfirmPin(cameraParams.cam_lat, cameraParams.cam_lon)}
            style={{ height: "26px", fontSize: "12px", padding: "0 10px" }}
          >
            Confirm Pin & Project 3D Flood
          </button>
        </div>
      )}

      {/* Streamlined Infrastructure Impact Strip (No wrapping clutter) */}
      <div
        style={{
          display: "flex",
          gap: "10px",
          alignItems: "center",
          flexWrap: "wrap",
          padding: "7px 12px",
          backgroundColor: "var(--raised)",
          border: "1px solid var(--border)",
          borderRadius: "6px",
          fontSize: "12px",
        }}
      >
        <span style={{ fontWeight: 600, color: "var(--text)" }}>Inundated:</span>
        <span className="num" style={{ fontWeight: 600, color: "var(--text)" }}>
          {summary.affected_structures} structures
        </span>
        <span style={{ color: "var(--border-strong)" }}>·</span>
        {summary.affected_evac_centers_count > 0 && (
          <span style={{ color: "var(--negative)", fontWeight: 600 }}>
            {summary.affected_evac_centers_count} evac center{summary.affected_evac_centers_count > 1 ? "s" : ""}
          </span>
        )}
        {summary.affected_schools_count > 0 && (
          <span style={{ color: "var(--warning)", fontWeight: 500 }}>
            {summary.affected_schools_count} school{summary.affected_schools_count > 1 ? "s" : ""}
          </span>
        )}
        {summary.affected_healthcare_count > 0 && (
          <span style={{ color: "var(--negative)", fontWeight: 500 }}>
            {summary.affected_healthcare_count} clinic{summary.affected_healthcare_count > 1 ? "s" : ""}
          </span>
        )}
        {summary.affected_civic_count > 0 && (
          <span style={{ color: "var(--muted)" }}>
            {summary.affected_civic_count} civic
          </span>
        )}
        <span style={{ color: "var(--muted)" }}>
          {summary.affected_residential_count || 0} residential
        </span>
        <span style={{ marginLeft: "auto", fontSize: "11px", color: "var(--muted)", display: "inline-flex", alignItems: "center", gap: "4px" }}>
          <Info size={11} />
          <span>Click 3D footprints to inspect</span>
        </span>
      </div>

      {/* MapLibre 3D Canvas */}
      <div
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: "16 / 9",
          maxHeight: "480px",
          borderRadius: "6px",
          overflow: "hidden",
          border: "1px solid var(--border)",
          backgroundColor: "#eef2f5",
        }}
      >
        {/* Animated Loading Progress Stripe */}
        {isMapComputing && (
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              height: "3px",
              backgroundColor: "rgba(2, 132, 199, 0.18)",
              zIndex: 20,
              overflow: "hidden",
            }}
          >
            <div
              className="map-load-bar"
              style={{
                width: "40%",
                height: "100%",
                backgroundColor: "var(--accent)",
              }}
            />
          </div>
        )}

        {/* Floating live calculation HUD pill */}
        {isMapComputing && (
          <div
            style={{
              position: "absolute",
              top: "10px",
              right: "10px",
              zIndex: 20,
              backgroundColor: "rgba(255, 255, 255, 0.95)",
              border: "1px solid var(--border)",
              borderRadius: "4px",
              padding: "5px 10px",
              display: "flex",
              alignItems: "center",
              gap: "7px",
              fontSize: "12px",
              fontWeight: 500,
              color: "var(--text)",
              pointerEvents: "none",
            }}
          >
            <RefreshCw size={12} className="spin" color="var(--accent)" />
            <span>
              {projectionLoading ? "Recalculating DEM flood surface..." : "Routing safe escape corridor..."}
            </span>
          </div>
        )}

        <div
          ref={mapContainerRef}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            opacity: isMapComputing ? 0.8 : 1,
            transition: "opacity 0.2s ease-out",
          }}
        />

        {/* Quiet In-Map Depth & Route Legend */}
        <div
          style={{
            position: "absolute",
            top: "8px",
            left: "8px",
            backgroundColor: "rgba(255, 255, 255, 0.94)",
            border: "1px solid var(--border)",
            borderRadius: "4px",
            padding: "4px 8px",
            fontSize: "11.5px",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            pointerEvents: "none",
            zIndex: 5,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontWeight: 600, color: "var(--text)" }}>Legend:</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", color: "var(--accent-strong)", fontWeight: 600 }}>
            <span
              style={{
                width: "14px",
                height: "5px",
                backgroundColor: "#0284c7",
                border: "1px solid #ffffff",
                borderRadius: "2px",
                display: "inline-block",
              }}
            />
            Escape route
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", color: "var(--muted)" }}>
            <span style={{ width: "8px", height: "8px", backgroundColor: "#15803d", borderRadius: "1px", display: "inline-block" }} />
            &lt;0.5m ({summary.low_depth_count})
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", color: "var(--muted)" }}>
            <span style={{ width: "8px", height: "8px", backgroundColor: "#b45309", borderRadius: "1px", display: "inline-block" }} />
            0.5–1.5m ({summary.medium_depth_count})
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", color: "var(--negative)", fontWeight: 500 }}>
            <span style={{ width: "8px", height: "8px", backgroundColor: "#b91c1c", borderRadius: "1px", display: "inline-block" }} />
            &gt;1.5m ({summary.critical_depth_count})
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", color: "var(--muted)" }}>
            <span style={{ width: "8px", height: "8px", backgroundColor: "#94a3b8", borderRadius: "1px", display: "inline-block" }} />
            Dry ({summary.safe_count ?? 0})
          </span>
        </div>
      </div>

      {/* Hydrological Raycast & WSE Cross-Section Profile (Signature Craft Element) */}
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: "6px",
          padding: "10px 12px",
          backgroundColor: "var(--surface)",
          display: "flex",
          flexDirection: "column",
          gap: "8px",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "12.5px", flexWrap: "wrap", gap: "6px" }}>
          <strong style={{ color: "var(--text)", fontWeight: 600 }}>
            Hydrological elevation profile (WSE = Z_DEM + h_w)
          </strong>
          <span className="mono-id" style={{ color: "var(--muted)", fontSize: "12px" }}>
            {wse.toFixed(2)} m MSL = {groundDem.toFixed(2)} m ground + {waterDepth.toFixed(2)} m depth
          </span>
        </div>

        <svg
          viewBox="0 0 640 100"
          style={{
            width: "100%",
            height: "100px",
            display: "block",
            backgroundColor: "var(--raised)",
            border: "1px solid var(--border)",
            borderRadius: "4px",
          }}
          role="img"
          aria-label="Topographic cross section profile showing camera ray, DEM ground, and water surface elevation"
        >
          <line x1="44" y1="20" x2="620" y2="20" stroke="#e2e8f0" strokeWidth="1" />
          <line x1="44" y1="50" x2="620" y2="50" stroke="#e2e8f0" strokeWidth="1" />
          <line x1="44" y1="80" x2="620" y2="80" stroke="#e2e8f0" strokeWidth="1" />

          <text x="6" y="24" fontSize="11" fill="var(--muted)" fontFamily="var(--font)">
            {(groundDem + 3.0).toFixed(1)}m
          </text>
          <text x="6" y="54" fontSize="11" fill="var(--muted)" fontFamily="var(--font)">
            {wse.toFixed(1)}m
          </text>
          <text x="6" y="84" fontSize="11" fill="var(--muted)" fontFamily="var(--font)">
            {groundDem.toFixed(1)}m
          </text>

          {/* Connected Water Basin Profile */}
          <polygon
            points="44,50 585,50 558,78 415,80 220,80 88,77 44,76"
            fill="rgba(14, 116, 144, 0.22)"
          />
          <line x1="44" y1="50" x2="585" y2="50" stroke="#0e7490" strokeWidth="2" />

          {/* Submerged Bare-Earth Street DEM Profile */}
          <polyline
            points="44,76 88,77 220,80 355,80 465,79 558,78 585,50 620,38"
            fill="none"
            stroke="#0f172a"
            strokeWidth="2.2"
          />

          {/* Vertical Camera Plumb Line */}
          <line x1="88" y1="22" x2="88" y2="77" stroke="#0f172a" strokeWidth="1.4" strokeDasharray="2,2" />
          <circle cx="88" cy="77" r="3" fill="#0f172a" />
          <circle cx="88" cy="50" r="3" fill="#0e7490" />
          <circle cx="88" cy="22" r="4" fill="#0f172a" />

          {/* Camera Optical Raycast to Waterline */}
          <line x1="88" y1="22" x2="355" y2="50" stroke="#b91c1c" strokeWidth="1.6" strokeDasharray="4,3" />
          <line x1="355" y1="50" x2="355" y2="80" stroke="#b91c1c" strokeWidth="1.4" strokeDasharray="2,2" />
          <circle cx="355" cy="50" r="4" fill="#b91c1c" />

          <text x="96" y="19" fontSize="11" fill="var(--text)" fontFamily="var(--font)" fontWeight="500">
            Camera @ 0m (in {waterDepth.toFixed(2)}m water)
          </text>
          <text x="364" y="46" fontSize="11" fill="#0e7490" fontFamily="var(--font)" fontWeight="600">
            Target @ ~{cameraParams.est_distance_m}m (model est.) · WSE {wse.toFixed(2)}m
          </text>
        </svg>

        {/* Rescue Corridor Summary Subline */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: "12px",
            color: "var(--muted)",
            flexWrap: "wrap",
            gap: "8px",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
            <Navigation size={13} color="#0284c7" />
            <span style={{ color: "var(--text)", fontWeight: 500 }}>Escape corridor:</span>{" "}
            <strong style={{ color: "var(--text)" }}>
              {triageData?.evacuation_center_name || "Designated evacuation centre"}
            </strong>
          </span>
          <span className="num">
            Distance: <strong style={{ color: "var(--accent-strong)" }}>{Math.round(triageData?.route_distance_m ?? 578)} m</strong> · ETA{" "}
            <strong style={{ color: "var(--text)" }}>{(triageData?.eta_minutes ?? 3.6).toFixed(1)} min</strong>
          </span>
        </div>
      </div>
    </section>
  );
}
