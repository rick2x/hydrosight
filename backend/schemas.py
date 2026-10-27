from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class VisualGaugeResult(BaseModel):
    reference_object_detected: str = Field(..., description="Name of submerged object used as scale reference")
    reference_standard_height_m: float = Field(..., description="Typical physical height of reference object in meters")
    submerged_ratio: float = Field(..., description="Fraction of object submerged between 0.0 and 1.0")
    estimated_water_depth_m: float = Field(..., description="Calculated floodwater depth at the object in meters")
    estimated_distance_from_camera_m: float = Field(..., description="Estimated forward distance from camera in meters")
    recommended_click_u: float = Field(..., description="Normalized horizontal X position [0.0-1.0] of reference object")
    recommended_click_v: float = Field(..., description="Normalized vertical Y position [0.0-1.0] of waterline at object")
    confidence_score: float = Field(..., description="Confidence from 0.0 to 1.0")
    hydrological_reasoning: str = Field(..., description="Concise explanation of depth calculation")


class SAMMaskObject(BaseModel):
    id: str = Field(..., description="Unique mask identifier")
    concept: str = Field(..., description="Prompted concept name")
    confidence: float = Field(..., description="Detection score from 0.0 to 1.0")
    bbox_norm: List[float] = Field(..., description="Normalized [x_min, y_min, x_max, y_max] in [0.0, 1.0]")
    polygon_norm: List[List[float]] = Field(..., description="Normalized polygon vertices [[u, v], ...]")
    submerged_ratio: Optional[float] = Field(None, description="Estimated submerged ratio if reference scale object")
    standard_height_m: Optional[float] = Field(None, description="Standard height in meters if scale reference")


class AnalyzePhotoRequest(BaseModel):
    scenario_id: Optional[str] = Field("kasiglahan_village", description="Pre-configured Rodriguez scenario ID")
    custom_prompts: Optional[List[str]] = Field(None, description="Optional override prompts for SAM 3.1")


class AnalyzePhotoResponse(BaseModel):
    scenario_id: str
    photo_url: str
    masks: List[SAMMaskObject]
    visual_gauge: VisualGaugeResult
    self_check_triggered: bool = False
    prompts_used: List[str]
    model_chain: List[str]
    cached: bool = False


class ProjectFloodRequest(BaseModel):
    cam_lat: float = Field(..., description="Camera WGS84 latitude")
    cam_lon: float = Field(..., description="Camera WGS84 longitude")
    azimuth_deg: float = Field(..., description="Camera bearing in degrees [0-360]")
    fov_deg: float = Field(65.0, description="Camera horizontal field of view in degrees")
    click_u: float = Field(0.5, description="Normalized horizontal click position [0.0-1.0]")
    est_distance_m: float = Field(38.0, description="Estimated forward distance from camera in meters")
    water_depth_m: float = Field(1.35, description="Estimated floodwater depth at target in meters")
    search_radius_m: float = Field(450.0, description="DEM catchment flood-fill radius in meters")
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
    flood_area_sqm: float
    flood_geojson: Dict[str, Any]
    buildings_geojson: Dict[str, Any]
    ray_geojson: Dict[str, Any]
    inundated_structures: InundatedStructureSummary
    zip_shapefile_path: str
    download_shp_url: str


class TriageRouteRequest(BaseModel):
    scenario_id: str = Field("kasiglahan_village", description="Scenario identifier")
    cam_lat: float = Field(..., description="Incident camera latitude")
    cam_lon: float = Field(..., description="Incident camera longitude")
    target_lat: float = Field(..., description="Projected flood point latitude")
    target_lon: float = Field(..., description="Projected flood point longitude")
    water_depth_m: float = Field(..., description="Measured flood depth in meters")
    wse_m: float = Field(..., description="Water surface elevation in meters")
    barangay: str = Field("SAN JOSE", description="Barangay name")
    max_passable_depth_m: float = Field(0.5, description="Maximum passable depth for rescue vehicle")
    confidence_score: float = Field(0.88, description="Visual gauge confidence score")


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
    footprint_sqm: Optional[float] = None
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
    generated_by_model: str = "muse-glimmer (Open Weights)"


class OpenWeightTelemetry(BaseModel):
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
    open_weight_telemetry: OpenWeightTelemetry


class SurgeSimulationRequest(BaseModel):
    scenario_id: str = Field("kasiglahan_village", description="Scenario ID")
    current_depth_m: float = Field(1.35, description="Current measured depth in meters")
    surge_delta_m: float = Field(1.5, description="Additional typhoon surge in meters (+1.5m)")
    barangay: str = Field("SAN JOSE", description="Barangay name")
    cam_lat: float = Field(14.7498, description="Camera latitude")
    cam_lon: float = Field(121.1372, description="Camera longitude")
    azimuth_deg: float = Field(118.0, description="Camera azimuth")
    fov_deg: float = Field(65.0, description="Camera FOV")
    click_u: float = Field(0.52, description="Horizontal click u")
    est_distance_m: float = Field(38.0, description="Distance from camera")


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
