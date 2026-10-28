import unittest

from backend.meta_agents import generate_area_advisory
from backend.schemas import InundatedStructureSummary


def _summary(**overrides):
    base = dict(
        barangay="SAN JOSE",
        wse_m=33.0,
        total_structures=100,
        low_depth_count=2,
        medium_depth_count=1,
        critical_depth_count=1,
        affected_structures=4,
    )
    base.update(overrides)
    return InundatedStructureSummary(**base)


class AreaAdvisoryTest(unittest.TestCase):
    def test_critical_counts_give_severe_general_advisory_without_addresses(self):
        advisory, telemetry = generate_area_advisory(
            barangay="SAN JOSE",
            summary=_summary(affected_schools_count=1),
            evacuation_center="Aranzazu Covered Court",
            vehicle_type="6x6 High-Water Rescue Truck",
            eta_minutes=6.0,
            route_distance_m=1200.0,
            severed_segments_count=3,
            primary_route_severed=False,
        )
        self.assertEqual(advisory.advisory_level, "SEVERE")
        self.assertIn("Aranzazu Covered Court", advisory.headline + " " + " ".join(advisory.resident_actions))
        self.assertTrue(any("Do not dispatch to individual house" in a for a in advisory.responder_actions))
        self.assertTrue(any("street by street" in a for a in advisory.responder_actions))
        # No per-house targeting anywhere in the advisory payload.
        dumped = advisory.model_dump_json()
        self.assertNotIn("OSM-", dumped)
        self.assertNotIn("building_id", dumped)
        self.assertEqual(telemetry.tokens_used, 0)

    def test_no_affected_structures_is_low_and_compromised_centre_warns(self):
        low, _ = generate_area_advisory(
            barangay="SAN JOSE",
            summary=_summary(low_depth_count=0, medium_depth_count=0, critical_depth_count=0, affected_structures=0),
            evacuation_center="Aranzazu Covered Court",
            vehicle_type="amphibious_rubber_boat",
            eta_minutes=5.0,
            route_distance_m=800.0,
            severed_segments_count=0,
            primary_route_severed=False,
        )
        self.assertEqual(low.advisory_level, "LOW")

        warned, _ = generate_area_advisory(
            barangay="SAN JOSE",
            summary=_summary(compromised_evac_centers=["Flooded School Gym"], affected_evac_centers_count=1),
            evacuation_center="Aranzazu Covered Court",
            vehicle_type="amphibious_rubber_boat",
            eta_minutes=5.0,
            route_distance_m=800.0,
            severed_segments_count=1,
            primary_route_severed=True,
        )
        self.assertEqual(warned.advisory_level, "SEVERE")
        self.assertIn("Flooded School Gym", warned.copyable_text)
        self.assertTrue(warned.primary_route_severed)


if __name__ == "__main__":
    unittest.main()
