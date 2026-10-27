import os
from pathlib import Path
import numpy as np
import geopandas as gpd
import requests
import rasterio
from rasterio.mask import mask
from rasterio.warp import calculate_default_transform, reproject, Resampling

OPENTOPO_API_URL = "https://portal.opentopography.org/API/globaldem"
DEFAULT_API_KEY = os.environ.get("OPENTOPO_API_KEY", "09f438e0be62b4e380630e1dda12ede1")


def download_and_resample_dem(
    shapefile_path: str = "boundary/political_boundary_rodriguez.shp",
    output_dir: str = "dem",
    dem_type: str = "SRTMGL1",
    target_res: float = 10.0,
    api_key: str = DEFAULT_API_KEY,
) -> Path:
    """
    Download a DEM from OpenTopography covering the input shapefile,
    reproject & resample to the shapefile's CRS at `target_res` meters,
    and clip to the exact polygon boundary.

    Parameters
    ----------
    shapefile_path : str
        Path to the boundary shapefile.
    output_dir : str
        Directory to store raw and processed GeoTIFFs.
    dem_type : str
        OpenTopography global DEM code ('SRTMGL1', 'COP30', 'NASADEM', 'AW3D30').
    target_res : float
        Target pixel resolution in the shapefile's projected CRS units (meters).
    api_key : str
        OpenTopography API key.
    """
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # 1. Read boundary shapefile and compute padded WGS84 bounding box
    gdf = gpd.read_file(shapefile_path)
    target_crs = gdf.crs
    gdf_4326 = gdf.to_crs("EPSG:4326")

    # Add a ~0.01 degree (~1.1 km) buffer around bounds to avoid edge artifacts during cubic resampling
    minx, miny, maxx, maxy = gdf_4326.total_bounds
    pad = 0.01
    params = {
        "demtype": dem_type,
        "south": float(miny - pad),
        "north": float(maxy + pad),
        "west": float(minx - pad),
        "east": float(maxx + pad),
        "outputFormat": "GTiff",
        "API_Key": api_key,
    }

    raw_tif = out_dir / f"rodriguez_{dem_type.lower()}_raw_30m_wgs84.tif"
    resampled_unclipped_tif = out_dir / f"_temp_{dem_type.lower()}_{int(target_res)}m.tif"
    final_tif = out_dir / f"rodriguez_{dem_type.lower()}_{int(target_res)}m_utm51n.tif"

    print(f"[1/3] Requesting {dem_type} from OpenTopography for Rodriguez bbox...")
    response = requests.get(OPENTOPO_API_URL, params=params, stream=True, timeout=120)
    if response.status_code != 200:
        raise RuntimeError(
            f"OpenTopography API error ({response.status_code}): {response.text}"
        )

    with open(raw_tif, "wb") as f:
        for chunk in response.iter_content(chunk_size=8192):
            if chunk:
                f.write(chunk)
    print(f"      Saved raw DEM -> {raw_tif}")

    # 2. Reproject from EPSG:4326 to target CRS (EPSG:32651) and resample to target_res (e.g. 10m)
    print(f"[2/3] Reprojecting to {target_crs} and resampling to {target_res}m (cubic spline)...")
    nodata_val = -9999.0
    with rasterio.open(raw_tif) as src:
        transform, width, height = calculate_default_transform(
            src.crs,
            target_crs,
            src.width,
            src.height,
            *src.bounds,
            resolution=(target_res, target_res),
        )
        profile = src.meta.copy()
        profile.update({
            "crs": target_crs,
            "transform": transform,
            "width": width,
            "height": height,
            "dtype": "float32",
            "nodata": nodata_val,
            "compress": "deflate",
        })

        with rasterio.open(resampled_unclipped_tif, "w", **profile) as dst:
            reproject(
                source=rasterio.band(src, 1),
                destination=rasterio.band(dst, 1),
                src_transform=src.transform,
                src_crs=src.crs,
                src_nodata=src.nodata,
                dst_transform=transform,
                dst_crs=target_crs,
                dst_nodata=nodata_val,
                resampling=Resampling.cubic_spline,
            )

    # 3. Clip to the exact Rodriguez political boundary polygon
    print(f"[3/3] Clipping {target_res}m DEM to {shapefile_path}...")
    with rasterio.open(resampled_unclipped_tif) as src:
        clipped_img, clipped_transform = mask(
            src, gdf.geometry, crop=True, nodata=nodata_val
        )
        clipped_meta = src.meta.copy()
        clipped_meta.update({
            "height": clipped_img.shape[1],
            "width": clipped_img.shape[2],
            "transform": clipped_transform,
            "nodata": nodata_val,
            "compress": "deflate",
        })

        with rasterio.open(final_tif, "w", **clipped_meta) as dst:
            dst.write(clipped_img)

    # Clean up temporary unclipped UTM raster
    if resampled_unclipped_tif.exists():
        resampled_unclipped_tif.unlink()

    valid = clipped_img[clipped_img != nodata_val]
    print(
        f"Done! Saved -> {final_tif}\n"
        f"      Grid size : {clipped_img.shape[2]} x {clipped_img.shape[1]} px @ {target_res}m ({target_crs})\n"
        f"      Elevation : min={valid.min():.2f} m, max={valid.max():.2f} m, mean={valid.mean():.2f} m"
    )
    return final_tif


if __name__ == "__main__":
    # Download USGS SRTMGL1 (and Copernicus COP30) and resample to 10m in EPSG:32651
    download_and_resample_dem(dem_type="SRTMGL1", target_res=10.0)
    download_and_resample_dem(dem_type="COP30", target_res=10.0)
