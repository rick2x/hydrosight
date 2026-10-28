// Click arbitration between the evac-centre markers/circles and the 3D
// building footprints beneath them. An evac label sits directly over
// nearby footprints, so a click on the label must describe the labelled
// centre, not whichever building happens to be under that screen point.

function truthy(value) {
  return value === true || value === "true";
}

export function pickClickTarget({ buildingFeatures = [], evacFeatures = [] } = {}) {
  if (evacFeatures && evacFeatures.length > 0) return { kind: "evac", feature: evacFeatures[0] };
  if (buildingFeatures && buildingFeatures.length > 0) return { kind: "building", feature: buildingFeatures[0] };
  return null;
}

export function evacPopupHtml(feature, fallbackName = "Evacuation centre") {
  const props = feature?.properties || {};
  const name = props.name || fallbackName || "Evacuation centre";
  const flooded = truthy(props.flooded);
  const selected = truthy(props.is_selected);
  const status = flooded ? "Flooded" : selected ? "Selected shelter" : "Evacuation centre";
  const statusColor = flooded ? "#b91c1c" : selected ? "#15803d" : "#0284c7";
  return `
    <div style="font-family: inherit; font-size: 12.5px; color: #0f172a; padding: 4px;">
      <div style="font-weight: 600; font-size: 13.5px; margin-bottom: 4px; color: #0f172a;">${name}</div>
      <span style="display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 500; background: ${statusColor}18; color: ${statusColor};">${status}</span>
      ${flooded ? `<div style="margin-top: 6px; padding: 5px 8px; background: #fef2f2; border: 1px solid #fecaca; border-radius: 4px; font-size: 11px; color: #991b1b; font-weight: 500;">ALERT: Evacuation center within active flood zone.</div>` : ""}
    </div>`;
}
