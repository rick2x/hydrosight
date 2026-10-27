import time
from pathlib import Path
import geopandas as gpd
import pandas as pd
import numpy as np
from shapely.geometry import Point
import rasterio

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "backend" / "data"
shp_path = DATA_DIR / "Buildings.shp"
out_parquet = DATA_DIR / "rodriguez_buildings_enriched.parquet"
dem_path = DATA_DIR / "rodriguez_dem.tif"
brgy_path = ROOT_DIR / "boundary" / "political_boundary_rodriguez.shp"
ec_path = DATA_DIR / "evacuationcenters.csv"

t0 = time.time()
print("Reading Buildings.shp...")
gdf = gpd.read_file(shp_path)
if gdf.crs is None or gdf.crs.to_epsg() != 32651:
    gdf = gdf.set_crs("EPSG:32651", allow_override=True) if gdf.crs is None else gdf.to_crs("EPSG:32651")
gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty].copy()

osm_ids = gdf["osm_id"].astype(str) if "osm_id" in gdf.columns else pd.Series(gdf.index.astype(str), index=gdf.index)
gdf["building_id"] = "OSM-" + osm_ids

raw_type = gdf["type"].fillna("").astype(str).str.lower() if "type" in gdf.columns else pd.Series([""] * len(gdf), index=gdf.index)
raw_name = gdf["name"].fillna("").astype(str) if "name" in gdf.columns else pd.Series([""] * len(gdf), index=gdf.index)
name_lower = raw_name.str.lower()

gdf["building_name"] = raw_name

# Barangay spatial join
print("Joining barangay boundaries...")
if brgy_path.exists():
    brgy = gpd.read_file(brgy_path)
    if brgy.crs != gdf.crs:
        brgy = brgy.to_crs(gdf.crs)
    joined_brgy = gpd.sjoin(gdf, brgy[["Barangay", "geometry"]], how="left", predicate="intersects")
    joined_brgy = joined_brgy[~joined_brgy.index.duplicated(keep="first")]
    gdf["barangay"] = joined_brgy["Barangay"].fillna("SAN JOSE").astype(str).str.upper()
else:
    gdf["barangay"] = "SAN JOSE"

# Evacuation centers match
print("Matching evacuation centers...")
gdf["evac_center_name"] = ""
gdf["is_evac_center"] = False
if ec_path.exists():
    ec_df = pd.read_csv(ec_path)
    ec_pts = gpd.GeoDataFrame(
        ec_df,
        geometry=[Point(xy) for xy in zip(ec_df["x"], ec_df["y"])],
        crs="EPSG:4326"
    ).to_crs(gdf.crs)
    ec_match = gpd.sjoin_nearest(gdf, ec_pts, max_distance=35, how="left", distance_col="ec_dist_m")
    ec_match = ec_match[~ec_match.index.duplicated(keep="first")]
    gdf["evac_center_name"] = ec_match["ec"].fillna("").astype(str)
    gdf["is_evac_center"] = gdf["evac_center_name"] != ""

# Infrastructure categorization
print("Categorizing infrastructures...")
infra_cat = pd.Series("residential", index=gdf.index)

# Healthcare
is_health = (
    raw_type.isin(["hospital", "clinic"]) |
    name_lower.str.contains("hospital|clinic|health center|rural health|rhu|medical", regex=True)
)
infra_cat[is_health] = "healthcare"

# Education
is_edu = (
    raw_type.isin(["school", "university", "college", "kindergarten"]) |
    name_lower.str.contains("school|elementary|high school|college|university|academy|learning center", regex=True)
)
infra_cat[is_edu] = "education"

# Emergency & Civic / Government
is_civic = (
    raw_type.isin(["public", "civic"]) |
    name_lower.str.contains("barangay hall|brgy hall|municipal hall|municipal gym|police|pnp|fire|bfp|mdrrmo|disaster|covered court|gymnasium|court|tourism office|hall|guard house|guardhouse", regex=True)
)
infra_cat[is_civic] = "emergency_civic"

# Religious
is_religion = (
    raw_type.isin(["church", "chapel", "mosque"]) |
    name_lower.str.contains("church|parish|chapel|kapilya|mosque|iglesia|cathedral", regex=True)
)
infra_cat[is_religion] = "religious"

# Commercial / Logistics / Industrial
is_comm = (
    raw_type.isin(["commercial", "retail", "supermarket", "warehouse", "industrial"]) |
    name_lower.str.contains("market|supermarket|mall|center|commercial|gasoline|caltex|seaoil|petron|shell|store|warehouse|terminal", regex=True)
)
infra_cat[is_comm] = "commercial_logistics"

# Evacuation centers are critical emergency infra
infra_cat[gdf["is_evac_center"] & ~is_health & ~is_edu & ~is_civic] = "emergency_civic"

gdf["infra_category"] = infra_cat

# Human-readable building type
type_labels = {
    "healthcare": "Hospital / Clinic",
    "education": "School / Educational",
    "emergency_civic": "Civic / Emergency Center",
    "religious": "Place of Worship",
    "commercial_logistics": "Commercial / Logistics Hub",
    "residential": "Residential Building",
}
clean_raw_type = raw_type.replace({"": np.nan})
gdf["building_type"] = clean_raw_type.fillna(gdf["infra_category"].map(type_labels))

# Display heights
_TYPE_HEIGHTS = {
    "school": 9.0, "university": 9.0, "college": 9.0, "hospital": 10.0, "church": 10.0,
    "commercial": 8.0, "retail": 7.0, "industrial": 8.0, "warehouse": 8.0, "apartments": 10.0,
    "garage": 3.0, "shed": 3.0, "roof": 3.5,
    "education": 9.0, "healthcare": 10.0, "emergency_civic": 8.0, "religious": 10.0,
    "commercial_logistics": 8.0, "residential": 5.0
}
gdf["height_m"] = raw_type.map(_TYPE_HEIGHTS).fillna(gdf["infra_category"].map(_TYPE_HEIGHTS)).fillna(5.0)
gdf["footprint_sqm"] = gdf.geometry.area.round(1)

# DEM bare-earth sampling
print("Sampling DEM ground elevation...")
cents = gdf.geometry.centroid
with rasterio.open(dem_path) as src:
    dem = src.read(1).astype(np.float32)
    nodata = src.nodata if src.nodata is not None else -9999.0
    dem = np.where((dem == nodata) | (dem < -100), np.nan, dem)
    inv = ~src.transform
    cols_f, rows_f = inv * (cents.x.to_numpy(), cents.y.to_numpy())
    rows = np.clip(np.floor(rows_f).astype(int), 1, src.height - 2)
    cols = np.clip(np.floor(cols_f).astype(int), 1, src.width - 2)

stack = np.stack(
    [dem[rows + dr, cols + dc] for dr in (-1, 0, 1) for dc in (-1, 0, 1)],
    axis=0,
)
with np.errstate(all="ignore"):
    ground = np.nanmin(stack, axis=0)
fallback = np.nanmedian(dem) if np.isfinite(np.nanmedian(dem)) else 30.0
gdf["ground_elev_m"] = np.round(np.where(np.isfinite(ground), ground, fallback), 2).astype(np.float32)

keep = [
    "building_id", "building_name", "building_type", "infra_category",
    "is_evac_center", "evac_center_name", "barangay", "footprint_sqm",
    "height_m", "ground_elev_m", "geometry"
]
gdf = gdf[keep].reset_index(drop=True)
print(f"Saving to {out_parquet}...")
gdf.to_parquet(out_parquet)
print(f"Successfully generated enriched buildings parquet in {time.time()-t0:.2f}s! Rows: {len(gdf)}")
