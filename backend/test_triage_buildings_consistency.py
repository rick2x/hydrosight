import unittest
from collections import Counter

from fastapi.testclient import TestClient

from backend.main import app


class TriageBuildingsConsistencyTest(unittest.TestCase):
    """Step 3 map popups and advisory counts must be the same computation.

    Regression for: map showed a CRITICAL (red) building while the advisory
    aggregation reported 0 critical, because TriageMap rendered the Step 2
    projection buildings while the advisory counted a separate Step 3 run.
    """

    def test_triage_building_tiers_match_summary_counts(self):
        client = TestClient(app)
        # Camera at the Manggahan/Burgos boundary building OSM-871965308
        # (ground ~20.8 m); a 2.23 m depth there produced the red popup.
        proj_res = client.post(
            "/api/v1/project-flood",
            json={
                "cam_lat": 14.7217465,
                "cam_lon": 121.1452902,
                "azimuth_deg": 90.0,
                "fov_deg": 65.0,
                "click_u": 0.5,
                "est_distance_m": 38.0,
                "water_depth_m": 2.23,
                "search_radius_m": 450.0,
                "scenario_id": "consistency_probe",
                "barangay": "BURGOS",
            },
        )
        self.assertEqual(proj_res.status_code, 200, proj_res.text[:400])
        proj = proj_res.json()

        tri_res = client.post(
            "/api/v1/triage-route",
            json={
                "scenario_id": "consistency_probe",
                "cam_lat": 14.7217465,
                "cam_lon": 121.1452902,
                "target_lat": proj["target_lat"],
                "target_lon": proj["target_lon"],
                "water_depth_m": proj["measured_depth_m"],
                "wse_m": proj["water_surface_elev_m"],
                "barangay": "BURGOS",
                "max_passable_depth_m": 0.5,
                "confidence_score": 0.91,
                "flood_geojson": proj["flood_geojson"],
            },
        )
        self.assertEqual(tri_res.status_code, 200, tri_res.text[:400])
        tri = tri_res.json()

        self.assertIn("buildings_geojson", tri)
        tiers = Counter(
            f["properties"].get("risk_tier")
            for f in tri["buildings_geojson"]["features"]
        )
        summary = tri["inundated_structures"]
        self.assertEqual(tiers.get("critical", 0), summary["critical_depth_count"])
        self.assertEqual(tiers.get("medium", 0), summary["medium_depth_count"])
        self.assertEqual(tiers.get("low", 0), summary["low_depth_count"])
        affected = sum(tiers.get(t, 0) for t in ("critical", "medium", "low"))
        self.assertEqual(affected, summary["affected_structures"])
        # One evacuation centre everywhere: advisory text, staging point,
        # response centre (and therefore the map marker) must be identical.
        # Regression: advisory said "Manggahan Covered Court" while the map
        # labelled "Manggahan Elementary School" (two centres 45 m apart).
        statuses = tri["evacuation_centers_status"]
        self.assertTrue(statuses, "nearest evacuation centre status list must be returned")
        self.assertEqual([c["distance_m"] for c in statuses], sorted(c["distance_m"] for c in statuses))
        selected = [c for c in statuses if c["is_selected"]]
        self.assertLessEqual(len(selected), 1)
        if selected:
            self.assertEqual(selected[0]["name"], tri["evacuation_center_name"])
            self.assertFalse(selected[0]["flooded"], "selected centre must be dry at the counted WSE")
        self.assertEqual(tri["area_advisory"]["evacuation_center_name"], tri["evacuation_center_name"])
        self.assertEqual(tri["area_advisory"]["staging_point"], tri["evacuation_center_name"])
        advisory = tri["area_advisory"]
        self.assertEqual(advisory["critical_depth_count"], summary["critical_depth_count"])
        self.assertEqual(advisory["affected_structures"], summary["affected_structures"])
        # The scenario is built to contain critical buildings; the advisory
        # must never again say 0 while the map paints red buildings.
        if tiers.get("critical", 0) > 0:
            self.assertGreater(advisory["critical_depth_count"], 0)


if __name__ == "__main__":
    unittest.main()
