import tempfile
import unittest
from pathlib import Path
from fastapi.testclient import TestClient

import backend.incidents_store as incidents_store
from backend.main import app


class AdminConsolidationTest(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self._orig_db_path = incidents_store.INCIDENTS_DB_PATH
        incidents_store.INCIDENTS_DB_PATH = Path(self._tmpdir.name) / "test_incidents_db.json"
        self.client = TestClient(app)

    def tearDown(self):
        incidents_store.INCIDENTS_DB_PATH = self._orig_db_path
        self._tmpdir.cleanup()

    def test_seed_and_consolidate_overlapping_incidents(self):
        # 1. Seed 5 realistic overlapping flood reports across Brgy. San Jose and Brgy. Burgos
        seed_res = self.client.post("/api/v1/admin/incidents/seed")
        self.assertEqual(seed_res.status_code, 200, seed_res.text[:400])
        incidents = seed_res.json()
        self.assertEqual(len(incidents), 5)

        # 2. Consolidate with confidence_weighted mode
        cons_res = self.client.post(
            "/api/v1/admin/consolidate",
            json={"reconciliation_mode": "confidence_weighted"},
        )
        self.assertEqual(cons_res.status_code, 200, cons_res.text[:400])
        cons = cons_res.json()

        self.assertEqual(cons["total_saved_incidents"], 5)
        self.assertEqual(cons["active_consolidated_incidents"], 5)
        self.assertGreaterEqual(cons["overlapping_clusters_count"], 2)
        self.assertGreater(len(cons["overlap_pairs"]), 0)

        # Verify that overlap area and duplicate building counts are eliminated
        self.assertGreater(cons["raw_sum_flood_area_sqm"], cons["consolidated_flood_area_sqm"])
        self.assertGreater(cons["overlap_area_eliminated_sqm"], 0.0)
        self.assertGreaterEqual(cons["raw_sum_affected_structures"], cons["consolidated_affected_structures"])
        self.assertGreater(cons["duplicate_structures_eliminated"], 0)

        # Verify that the Kasiglahan cluster flagged the high-WSE low-confidence outlier
        kv_clusters = [c for c in cons["clusters"] if c["barangay"] == "SAN JOSE"]
        self.assertTrue(kv_clusters)
        kv = kv_clusters[0]
        self.assertTrue(kv["is_overlapping"])
        self.assertEqual(kv["incident_count"], 3)
        self.assertTrue(kv["discrepancy_flagged"])
        self.assertEqual(kv["outlier_incident_id"], "inc_kv_south_alley")
        self.assertGreater(kv["reconciled_wse_m"], kv["wse_min_m"])
        self.assertLess(kv["reconciled_wse_m"], kv["wse_max_m"])

        # 3. Compare max_envelope mode (must yield higher or equal WSE than confidence_weighted)
        max_res = self.client.post(
            "/api/v1/admin/consolidate",
            json={"reconciliation_mode": "max_envelope"},
        )
        self.assertEqual(max_res.status_code, 200)
        max_cons = max_res.json()
        kv_max = [c for c in max_cons["clusters"] if c["barangay"] == "SAN JOSE"][0]
        self.assertEqual(kv_max["reconciled_wse_m"], kv_max["wse_max_m"])
        self.assertGreaterEqual(kv_max["reconciled_wse_m"], kv["reconciled_wse_m"])

        # 4. Exclude the outlier incident and verify discrepancy is resolved
        patch_res = self.client.patch(
            "/api/v1/admin/incidents/inc_kv_south_alley",
            json={"status": "excluded"},
        )
        self.assertEqual(patch_res.status_code, 200)
        self.assertEqual(patch_res.json()["status"], "excluded")

        cons_after = self.client.post(
            "/api/v1/admin/consolidate",
            json={"reconciliation_mode": "confidence_weighted"},
        ).json()
        self.assertEqual(cons_after["active_consolidated_incidents"], 4)
        kv_after = [c for c in cons_after["clusters"] if c["barangay"] == "SAN JOSE"][0]
        self.assertEqual(kv_after["incident_count"], 2)
        self.assertFalse(kv_after["discrepancy_flagged"])


if __name__ == "__main__":
    unittest.main()
