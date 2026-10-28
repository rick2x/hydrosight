import test from "node:test";
import assert from "node:assert/strict";

import { formatNumber, uncertaintyBand } from "./format.js";

test("formatNumber renders finite numbers and falls back for missing ones", () => {
  assert.equal(formatNumber(33.094, 2), "33.09");
  assert.equal(formatNumber(0, 1), "0.0");
  assert.equal(formatNumber(undefined, 2), "--");
  assert.equal(formatNumber(null, 1), "--");
  assert.equal(formatNumber(Number.NaN, 2), "--");
});

// Replacement for the removed +1.5 m surge simulation: the band is derived
// only from fields the DEM projection already returns for the measured depth.
test("uncertaintyBand is null without a complete projection", () => {
  assert.equal(uncertaintyBand(null), null);
  assert.equal(uncertaintyBand(undefined), null);
  assert.equal(uncertaintyBand({ dem_uncertainty_m: 0.6 }), null);
});

test("uncertaintyBand converts the DEM band to hectares without inventing a delta", () => {
  const band = uncertaintyBand({
    dem_uncertainty_m: 0.62,
    water_surface_elev_m: 33.09,
    wse_low_m: 32.47,
    wse_high_m: 33.71,
    flood_area_sqm: 12000,
    flood_area_low_sqm: 9000,
    flood_area_high_sqm: 15500,
  });
  assert.equal(band.uncertaintyM, 0.62);
  assert.equal(band.wseLowM, 32.47);
  assert.equal(band.wseHighM, 33.71);
  assert.equal(band.areaHa, 1.2);
  assert.equal(band.areaLowHa, 0.9);
  assert.equal(band.areaHighHa, 1.55);
});
