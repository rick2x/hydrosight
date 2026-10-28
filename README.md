# hydrosight

HydroSight AI converts street-level flood photos into 3D flood-extent shapefiles, building inundation depths, and rescue routes for Rodriguez (Montalban), Rizal, Philippines. See [SPEC.md](SPEC.md) for the full technical specification.

## Honest limitations

- **One municipality, hard-coded.** All coordinates, scenarios, evacuation centers, and the CRS (`EPSG:32651`) are tuned for Rodriguez, Rizal. Other areas need a new DEM, road graph, building footprints, and scenario calibration.
- **Elevation data is resampled, not surveyed.** The 10 m DEM is resampled from a 30 m source. The API returns a `dem_uncertainty_m` band with every projection. Depths are estimates for triage, not surveyed flood depths.
- **Depth comes from a visible reference object.** Water depth is `standard height × submerged ratio` for a detected object (wheel, car, tricycle, person, gate). Photos with no usable reference object give weaker estimates, and low-confidence results trigger a re-prompt with fallback concepts.
- **Fallbacks are labelled, not hidden.** With no `META_API_KEY`, or if the Meta API is unreachable, built-in scenarios use calibrated preset masks and gauges, and custom uploads may reuse them. Responses expose this via `fallback_used` and `execution_mode`. No hypothetical surge preview is generated; projections show only the measured depth with its DEM uncertainty band (`dem_uncertainty_m`, `wse_low_m`/`wse_high_m`, `flood_area_low_sqm`/`flood_area_high_sqm`).
- **Routing is only as good as OpenStreetMap.** Safe routes clip road segments by modelled depth on the OSM graph. They do not see real-time closures, debris, currents, or traffic.
- **Not an operational life-safety system.** Outputs support human MDRRMO decision-making. They must not be used as the sole basis for evacuation or rescue dispatch without local validation.
