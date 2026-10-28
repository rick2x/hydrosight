// Display helpers for values that may be absent while a step is still pending.

export function formatNumber(value, digits = 2, fallback = "--") {
  if (value === null || value === undefined || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : fallback;
}

// DEM uncertainty band for the measured depth only: derived from fields the
// project-flood response already returns. Null until a complete projection
// exists, so the UI never invents a band (or a hypothetical surge delta).
export function uncertaintyBand(projection) {
  if (!projection) return null;
  const nums = [
    projection.dem_uncertainty_m,
    projection.wse_low_m,
    projection.wse_high_m,
    projection.flood_area_low_sqm,
    projection.flood_area_high_sqm,
    projection.flood_area_sqm,
    projection.water_surface_elev_m,
  ];
  if (!nums.every((v) => Number.isFinite(v))) return null;
  return {
    uncertaintyM: projection.dem_uncertainty_m,
    wseM: projection.water_surface_elev_m,
    wseLowM: projection.wse_low_m,
    wseHighM: projection.wse_high_m,
    areaHa: projection.flood_area_sqm / 10000,
    areaLowHa: projection.flood_area_low_sqm / 10000,
    areaHighHa: projection.flood_area_high_sqm / 10000,
  };
}
