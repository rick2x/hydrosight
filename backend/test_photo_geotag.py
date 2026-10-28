import io
import unittest

from PIL import Image
from PIL.TiffTags import TAGS_V2  # noqa: F401  (ensures Pillow EXIF support is importable)

from backend.meta_agents import extract_exif_geotag


def _jpeg_bytes(with_gps=True, lat_ref="N", lon_ref="E"):
    img = Image.new("RGB", (32, 24), (40, 90, 140))
    buf = io.BytesIO()
    if not with_gps:
        img.save(buf, "JPEG", quality=90)
        return buf.getvalue()
    from fractions import Fraction

    exif = Image.Exif()
    # GPS IFD (tag 34853): N 14 deg 44' 59.28" = 14.7498, E 121 deg 8' 13.92" = 121.1372
    exif[34853] = {
        1: lat_ref,
        2: (Fraction(14), Fraction(44), Fraction(5928, 100)),
        3: lon_ref,
        4: (Fraction(121), Fraction(8), Fraction(1392, 100)),
        16: "T",
        17: Fraction(118),
    }
    img.save(buf, "JPEG", quality=90, exif=exif.tobytes())
    return buf.getvalue()


class PhotoGeotagTest(unittest.TestCase):
    def test_extracts_rodriguez_gps_and_direction(self):
        tag = extract_exif_geotag(_jpeg_bytes())
        self.assertIsNotNone(tag)
        self.assertAlmostEqual(tag.lat, 14.7498, places=4)
        self.assertAlmostEqual(tag.lon, 121.1372, places=4)
        self.assertEqual(tag.direction_deg, 118.0)
        self.assertTrue(tag.within_pilot_area)
        self.assertEqual(tag.source, "exif_gps")

    def test_southern_western_hemisphere_signs_and_outside_pilot(self):
        tag = extract_exif_geotag(_jpeg_bytes(lat_ref="S", lon_ref="W"))
        self.assertIsNotNone(tag)
        self.assertLess(tag.lat, 0)
        self.assertLess(tag.lon, 0)
        self.assertFalse(tag.within_pilot_area)

    def test_no_exif_returns_none(self):
        self.assertIsNone(extract_exif_geotag(_jpeg_bytes(with_gps=False)))
        self.assertIsNone(extract_exif_geotag(b"not an image"))


if __name__ == "__main__":
    unittest.main()
