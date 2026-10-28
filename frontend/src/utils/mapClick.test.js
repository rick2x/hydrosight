import test from "node:test";
import assert from "node:assert/strict";

import { pickClickTarget, evacPopupHtml } from "./mapClick.js";

// Regression: the "Manggahan Covered Court" label sits over the elementary
// school footprint (OSM-432759056: 116 m2, 9.0 m, DEM 22.5 m). Clicking the
// label used to fall through to the buildings layer and open a
// "Manggahan Elementary School" popup under the Covered Court label.
test("evac centre at the click point wins over the building under it", () => {
  const building = {
    type: "Feature",
    properties: { building_name: "", evac_center_name: "Manggahan Elementary School", footprint_sqm: 115.6 },
  };
  const evac = { type: "Feature", properties: { name: "Manggahan Covered Court" } };
  const target = pickClickTarget({ buildingFeatures: [building], evacFeatures: [evac] });
  assert.equal(target.kind, "evac");
  assert.equal(target.feature, evac);
});

test("building is picked when no evac centre is at the click point", () => {
  const building = { type: "Feature", properties: { building_name: "Manggahan Elementary School" } };
  assert.deepEqual(pickClickTarget({ buildingFeatures: [building], evacFeatures: [] }), {
    kind: "building",
    feature: building,
  });
  assert.equal(pickClickTarget({ buildingFeatures: [], evacFeatures: [] }), null);
  assert.equal(pickClickTarget(), null);
});

test("evac popup names the labelled centre, not the building beneath it", () => {
  const html = evacPopupHtml({ properties: { name: "Manggahan Covered Court", flooded: false, is_selected: true } });
  assert.match(html, /Manggahan Covered Court/);
  assert.doesNotMatch(html, /Elementary School/);
  assert.match(html, /Selected shelter/);
});

test("evac popup flags a flooded centre and falls back when unnamed", () => {
  const flooded = evacPopupHtml({ properties: { name: "Manggahan Elementary School", flooded: true } });
  assert.match(flooded, /Flooded/);
  assert.match(evacPopupHtml(null), /Evacuation centre/);
  assert.match(evacPopupHtml({ properties: {} }, "Fallback Centre"), /Fallback Centre/);
});
