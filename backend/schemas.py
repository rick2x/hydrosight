from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field, model_validator


class VisualGaugeResult(BaseModel):
    reference_object_detected: str = Field(..., description="Name of submerged object used as scale reference")
    reference_standard_height_m: float = Field(..., ge=0.1, le=10.0, description="Typical physical height of reference object in meters")
    submerged_ratio: float = Field(..., ge=0.0, le=1.0, description="Fraction of object submerged between 0.0 and 1.0")
    estimated_water_depth_m: float = Field(..., ge=0.0, le=10.0, description="Floodwater depth at the object in meters. Enforced as reference_standard_height_m * submerged_ratio.")
    estimated_distance_from_camera_m: float = Field(..., ge=1.0, le=500.0, description="Estimated forward distance from camera in meters")
    recommended_click_u: float = Field(..., ge=0.0, le=1.0, description="Normalized horizontal X position [0.0-1.0] of reference object")
    recommended_click_v: float = Field(..., ge=0.0, le=1.0, description="Normalized vertical Y position [0.0-1.0] of waterline at object")
    confidence_score: float = Field(..., ge=0.0, le=1.0, description="Confidence from 0.0 to 1.0")
    hydrological_reasoning: str = Field(..., description="Concise explanation of depth calculation")
    depth_was_corrected: bool = Field(False, description="True if estimated_water_depth_m was recomputed as height * ratio because the supplied value disagreed")
    submerged_ratio_source: str = Field("model_estimate", description="sam_mask_geometry if the ratio was measured from rasterized SAM mask pixels, else model_estimate")
    sam_mask_pixel_count: Optional[int] = Field(None, ge=0, description="Pixel count of the reference object's SAM mask when submerged_ratio_source=sam_mask_geometry")

    @model_validator(mode="after")
    def _enforce_depth_equals_height_times_ratio(self):
        # Depth is defined by the reference-object geometry, not a free estimate:
        # depth = standard_height * submerged_ratio. A disagreeing supplied
        # value is replaced and flagged, never silently averaged.
        expected = round(float(self.reference_standard_height_m) * float(self.submerged_ratio), 2)
        if abs(float(self.estimated_water_depth_m) - expected) > 0.01:
            self.depth_was_corrected = True
        self.estimated_water_depth_m = expected
        return self


class SAMMaskObject(BaseModel):
    id: str = Field(..., description="Unique mask identifier")
    concept: str = Field(..., description="Prompted concept name")
    confidence: float = Field(..., ge=0.0, le=1.0, description="Detection score from 0.0 to 1.0")
    bbox_norm: List[float] = Field(..., description="Normalized [x_min, y_min, x_max, y_max] in [0.0, 1.0]")
    polygon_norm: List[List[float]] = Field(..., description="Normalized polygon vertices [[u, v], ...]")
    submerged_ratio: Optional[float] = Field(None, ge=0.0, le=1.0, description="Estimated submerged ratio if reference scale object")
    standard_height_m: Optional[float] = Field(None, ge=0.1, le=10.0, description="Standard height in meters if scale reference")
    mask_area_frac: Optional[float] = Field(None, ge=0.0, le=1.0, description="Rasterized mask area as fraction of image pixels (from mask geometry, not the bbox)")
    pixel_count: Optional[int] = Field(None, ge=0, description="Rasterized mask pixel count at analysis resolution")
    waterline_v: Optional[float] = Field(None, ge=0.0, le=1.0, description="For floodwater: topmost water pixel row as normalized v; per-object waterline v where computed")
    geometry_source: Optional[str] = Field(None, description="sam_polygon (SAM mask polygon), sam_box (SAM box, rasterized), preset (calibrated fallback), or None")


class AnalyzePhotoRequest(BaseModel):
    scenario_id: Optional[str] = Field("kasiglahan_village", description="Pre-configured Rodriguez scenario ID")
    custom_prompts: Optional[List[str]] = Field(None, description="Optional override prompts for SAM 3.1")


class AnalyzePhotoResponse(BaseModel):
    scenario_id: str
    photo_url: str
    masks: List[SAMMaskObject]
    visual_gauge: VisualGaugeResult
    self_check_triggered: bool = False
    initial_confidence_score: Optional[float] = None
    prompts_used: List[str]
    model_chain: List[str]
    cached: bool = False
    fallback_used: bool = False
    execution_mode: str = 'live_inference'
    is_custom_upload: bool = False


class DeletePhotoRequest(BaseModel):
    photo_url: Optional[str] = None


class ProjectFloodRequest(BaseModel):
    cam_lat: float = Field(..., ge=-90.0, le=90.0, description="Camera WGS84 latitude")
    cam_lon: float = Field(..., ge=-180.0, le=180.0, description="Camera WGS84 longitude")
    azimuth_deg: float = Field(..., ge=0.0, le=360.0, description="Camera bearing in degrees [0-360]")
    fov_deg: float = Field(65.0, ge=10.0, le=120.0, description="Camera horizontal field of view in degrees")
    click_u: float = Field(0.5, ge=0.0, le=1.0, description="Normalized horizontal click position [0.0-1.0]")
    est_distance_m: float = Field(38.0, ge=1.0, le=500.0, description="Estimated forward distance from camera in meters")
    water_depth_m: float = Field(1.35, ge=0.05, le=5.0, description="Estimated floodwater depth at target in meters")
    search_radius_m: float = Field(450.0, ge=50.0, le=2000.0, description="DEM catchment flood-fill radius in meters")
    scenario_id: Optional[str] = Field(None, description="Optional scenario ID for naming")
    barangay: Optional[str] = Field("SAN JOSE", description="Target Barangay name")


class InundatedStructureSummary(BaseModel):
    barangay: str
    wse_m: float
    total_structures: int
    low_depth_count: int = Field(..., description="Buildings with < 0.5m flood depth")
    medium_depth_count: int = Field(..., description="Buildings with 0.5m - 1.5m flood depth")
    critical_depth_count: int = Field(..., description="Buildings with > 1.5m flood depth")
    safe_count: int = Field(0, description="Dry buildings outside the DEM flood extent")
    low_area_sqm: float = Field(0.0, description="DEM flood zone area (< 0.5m) in sq meters")
    medium_area_sqm: float = Field(0.0, description="DEM flood zone area (0.5m - 1.5m) in sq meters")
    critical_area_sqm: float = Field(0.0, description="DEM flood zone area (> 1.5m) in sq meters")
    affected_structures: int = Field(0, description="OSM footprints inside any DEM flood zone")
    affected_footprint_sqm: float = Field(0.0, description="Total roof footprint area of affected structures")
    building_source: str = Field("OSM Buildings.shp", description="Building footprint dataset used")
    affected_schools_count: int = Field(0, description="Number of educational institutions affected")
    affected_healthcare_count: int = Field(0, description="Number of hospitals/clinics/health units affected")
    affected_civic_count: int = Field(0, description="Number of government/barangay/civic centers affected")
    affected_evac_centers_count: int = Field(0, description="Number of designated evacuation centers compromised")
    affected_commercial_count: int = Field(0, description="Number of commercial/market/retail hubs affected")
    affected_religious_count: int = Field(0, description="Number of churches/chapels/places of worship affected")
    affected_residential_count: int = Field(0, description="Number of residential buildings affected")
    compromised_evac_centers: List[str] = Field(default_factory=list, description="Names of flooded evacuation centers")
    critical_infras: List[Dict[str, Any]] = Field(default_factory=list, description="List of key affected critical infrastructure facilities")


class ProjectFloodResponse(BaseModel):
    run_id: str
    target_lat: float
    target_lon: float
    ground_dem_m: float
    cam_ground_dem_m: Optional[float] = None
    camera_in_water: bool = True
    profile_points: Optional[List[Dict[str, float]]] = None
    measured_depth_m: float
    water_surface_elev_m: float
    wse_camera_anchored_m: Optional[float] = Field(None, description="Diagnostic only: WSE if anchored at camera ground (cam_ground + depth). NOT used for the flood extent; water_surface_elev_m follows SPEC (target ground + depth).")
    wse_method: str = Field("spec_target_anchored", description="WSE used for the flood extent: WSE = DEM at target + water_depth_m")
    dem_uncertainty_m: Optional[float] = Field(None, description="Plus/minus DEM vertical uncertainty band in meters (local 30 m window std-dev combined with a 0.5 m resampled-DSM floor)")
    wse_low_m: Optional[float] = Field(None, description="water_surface_elev_m - dem_uncertainty_m")
    wse_high_m: Optional[float] = Field(None, description="water_surface_elev_m + dem_uncertainty_m")
    flood_area_low_sqm: Optional[float] = Field(None, description="Connected flood area recomputed at wse_low_m")
    flood_area_high_sqm: Optional[float] = Field(None, description="Connected flood area recomputed at wse_high_m")
    corridor_geojson: Optional[Dict[str, Any]] = Field(None, description="Observation corridor (camera-to-target buffer) as a separate layer. NOT part of the flood extent.")
    flood_area_sqm: float
    flood_geojson: Dict[str, Any]
    buildings_geojson: Dict[str, Any]
    ray_geojson: Dict[str, Any]
    inundated_structures: InundatedStructureSummary
    zip_shapefile_path: str
    download_shp_url: str


class TriageRouteRequest(BaseModel):
    scenario_id: str = Field("kasiglahan_village", description="Scenario identifier")
    cam_lat: float = Field(..., ge=-90.0, le=90.0, description="Incident camera latitude")
    cam_lon: float = Field(..., ge=-180.0, le=180.0, description="Incident camera longitude")
    target_lat: float = Field(..., ge=-90.0, le=90.0, description="Projected flood point latitude")
    target_lon: float = Field(..., ge=-180.0, le=180.0, description="Projected flood point longitude")
    water_depth_m: float = Field(..., ge=0.05, le=5.0, description="Measured flood depth in meters")
    wse_m: float = Field(..., ge=-100.0, le=9000.0, description="Water surface elevation in meters")
    barangay: str = Field("SAN JOSE", description="Barangay name")
    flood_geojson: Optional[Dict[str, Any]] = Field(None, description="Flood extent GeoJSON (EPSG:4326) from /api/v1/project-flood. When supplied, triage reuses this exact polygon for building counts instead of recomputing a bathtub extent.")
    max_passable_depth_m: float = Field(0.5, ge=0.0, le=5.0, description="Maximum passable depth for rescue vehicle")
    confidence_score: float = Field(0.91, ge=0.0, le=1.0, description="Visual gauge confidence score")


class AgentStepLog(BaseModel):
    step_number: int
    phase: str
    agent_model: str
    tool_called: str
    input_summary: str
    output_summary: str
    status: str = "completed"
    latency_ms: int


class DispatchTicket(BaseModel):
    ticket_id: str
    priority: str = Field(..., description="CRITICAL, HIGH, or MEDIUM")
    barangay: str
    cluster_name: str
    building_id: str
    building_name: Optional[str] = None
    building_type: Optional[str] = None
    infra_category: Optional[str] = None
    is_evac_center: Optional[bool] = False
    evac_center_name: Optional[str] = None
    footprint_sqm: Optional[float] = None
    building_lat: Optional[float] = Field(None, ge=-90.0, le=90.0, description="Building centroid latitude (WGS84)")
    building_lon: Optional[float] = Field(None, ge=-180.0, le=180.0, description="Building centroid longitude (WGS84)")
    depth_band: Optional[str] = Field(None, description="Rounded depth band for responders, e.g. '~2.6 m (critical, >1.5 m)' - never an exact depth")
    map_url: Optional[str] = Field(None, description="OpenStreetMap link to the building location")
    flood_depth_m: float
    wse_m: float
    stranded_residents_est: Optional[int] = Field(
        None, description="Unknown until a population/occupancy dataset is linked; never synthesized"
    )
    assigned_unit: str
    vehicle_type: str
    evacuation_center: str
    eta_minutes: int
    tactical_directive: str
    generated_by_model: str = "muse-spark-1.1 (Meta API)"


class DispatchTelemetry(BaseModel):
    model_id: str
    provider: str
    endpoint: str
    latency_ms: int
    tokens_used: int
    verification_log_path: str
    status: str


class TriageRouteResponse(BaseModel):
    run_id: str
    barangay: str
    evacuation_center_name: str
    evacuation_center_lat: float
    evacuation_center_lon: float
    vehicle_selected: str
    max_passable_depth_m: float
    primary_route_severed: bool
    route_distance_m: float
    eta_minutes: float
    severed_segments_count: int
    route_geojson: Dict[str, Any]
    severed_roads_geojson: Dict[str, Any]
    inundated_structures: InundatedStructureSummary
    agent_steps: List[AgentStepLog]
    dispatch_tickets: List[DispatchTicket]
    dispatch_telemetry: DispatchTelemetry


class SurgeSimulationRequest(BaseModel):
    scenario_id: str = Field("kasiglahan_village", description="Scenario ID")
    current_depth_m: float = Field(1.35, ge=0.05, le=5.0, description="Current measured depth in meters")
    surge_delta_m: float = Field(1.5, ge=0.0, le=5.0, description="Additional typhoon surge in meters (+1.5m)")
    barangay: str = Field("SAN JOSE", description="Barangay name")
    cam_lat: float = Field(14.7498, ge=-90.0, le=90.0, description="Camera latitude")
    cam_lon: float = Field(121.1372, ge=-180.0, le=180.0, description="Camera longitude")
    azimuth_deg: float = Field(118.0, ge=0.0, le=360.0, description="Camera azimuth")
    fov_deg: float = Field(65.0, ge=10.0, le=120.0, description="Camera FOV")
    click_u: float = Field(0.52, ge=0.0, le=1.0, description="Horizontal click u")
    est_distance_m: float = Field(38.0, ge=1.0, le=500.0, description="Distance from camera")


class SurgeSimulationResponse(BaseModel):
    scenario_id: str
    barangay: str
    current_depth_m: float
    projected_surge_depth_m: float
    current_wse_m: float
    surge_wse_m: float
    current_photo_url: str
    surge_forecast_image_url: str
    alert_headline: str
    sms_broadcast_text: str
    additional_buildings_at_risk: int
    model_used: str
    surge_flood_geojson: Dict[str, Any]
    cached: bool = False
    fallback_used: bool = False
    execution_mode: str = 'live_inference'


class ScenarioPreset(BaseModel):
    id: str
    name: str
    barangay: str
    subtitle: str
    cam_lat: float
    cam_lon: float
    azimuth_deg: float
    fov_deg: float
    default_click_u: float
    default_click_v: float
    est_distance_m: float
    water_depth_m: float
    photo_url: str
    evacuation_center_name: str
    evacuation_center_lat: float
    evacuation_center_lon: float
    river_basin: str
    alert_level: str
    visual_gauge: VisualGaugeResult
    sam_masks: List[SAMMaskObject]
