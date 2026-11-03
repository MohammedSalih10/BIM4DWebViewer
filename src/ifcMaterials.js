// Shared material + element-reading helpers for every IFC viewer in this app.
//
// Background: Synchro's IFC export strips all IfcSurfaceStyle data and flattens
// every element to IfcBuildingElementProxy, so those files carry no colors and no
// element types -- only names. These rules infer a plausible material from the
// name. It's a heuristic and won't match Revit/Synchro exactly; it exists to make
// the model readable.
//
// Order matters: the FIRST matching rule wins, so specific rules must come before
// generic ones ("Wall - Timber Clad" has to reach timber before the wall rule).
import * as THREE from "three";

export const RULES = [
  { key: "glass",     label: "Glass",     re: /glaz|glass|window|curtain|mirror/i,
    color: 0x9fc4d6, roughness: 0.05, metalness: 0.0, opacity: 0.3 },
  { key: "foliage",   label: "Planting",  re: /poplar|locust|\bash\b|oak|maple|birch|tree|shrub|plant|hedge/i,
    color: 0x4f7a3a, roughness: 0.9 },
  { key: "solar",     label: "Solar PV",  re: /solar|sunmodule|photovolt/i,
    color: 0x1b2a4a, roughness: 0.15, metalness: 0.6 },
  { key: "concrete",  label: "Concrete",  re: /concrete|insitu|retaining|foundation|footing|\bpad\b|screed|slab|precast|stair/i,
    color: 0xa8a49e, roughness: 0.92 },
  { key: "timber",    label: "Timber",    re: /timber|wood|clad|plywood|joist|stud|batten|deck|64 x 128/i,
    color: 0x9a6b41, roughness: 0.75 },
  { key: "steel",     label: "Metal",     re: /steel|metal|\brsa\b|angle|\bl\d{2,}|beam|column|rail|track|trck|hood|duct|pipe|rectangular|^p-d-/i,
    color: 0x8d9299, roughness: 0.35, metalness: 0.85 },
  { key: "brick",     label: "Brick",     re: /brick|masonry/i,
    color: 0x9c5a44, roughness: 0.9 },
  { key: "roof",      label: "Roof",      re: /roof|tile|shingle/i,
    color: 0x5b4a42, roughness: 0.8 },
  { key: "door",      label: "Door",      re: /door|800 x 2100/i,
    color: 0xb08a5e, roughness: 0.6 },
  { key: "wall",      label: "Wall",      re: /wall|partition|\bsip\b|plaster|gypsum|render/i,
    color: 0xded8cd, roughness: 0.9 },
  { key: "ceramic",   label: "Ceramic",   re: /china|plate|sanitary|basin|\bwc\b|toilet|sink|bath/i,
    color: 0xf2f2ef, roughness: 0.2 },
  { key: "fabric",    label: "Seating",   re: /chair|sofa|seat|\bbed\b|cushion/i,
    color: 0x6b6f76, roughness: 0.95 },
  { key: "furniture", label: "Furniture", re: /table|wardrobe|desk|cabinet|shelf|counter|worktop/i,
    color: 0x7d5a3c, roughness: 0.7 },
  { key: "site",      label: "Site",      re: /surface|site|topo|ground|terrain|paving|path|grass|lawn/i,
    color: 0x7d7a6d, roughness: 0.95 },
];

export const DEFAULT_RULE = {
  key: "other", label: "Other", color: 0xc8c4bc, roughness: 0.85, metalness: 0.0,
};

// Teal, a distinctly different shade from TASK_STATUS.inProgress's 0x3498db
// (ifcSchedule.js) so a selected element never reads as "in progress" by accident.
// This is only the starting default -- SimpleViewer lets the user repick it.
// User-picked value, baked in as the new default 2026-08-11 (RGB 51,91,92).
export const HIGHLIGHT = { color: 0x335b5c, roughness: 0.5, metalness: 0.0 };
export const PROGRESS  = { color: 0xf39c12, roughness: 0.6, opacity: 0.55 };

/** Builds a physically-shaded material from a rule or plain spec object. */
export function makeMaterial(spec, overrides = {}) {
  const opacity = overrides.opacity ?? spec.opacity;
  const m = new THREE.MeshStandardMaterial({
    color: new THREE.Color(overrides.color ?? spec.color),
    roughness: overrides.roughness ?? spec.roughness ?? 0.85,
    metalness: overrides.metalness ?? spec.metalness ?? 0.0,
    side: THREE.DoubleSide,
    transparent: opacity != null,
    opacity: opacity ?? 1,
    envMapIntensity: 1.0,
  });
  // Transparent surfaces that write depth make glazing occlude what's behind it.
  if (m.transparent) m.depthWrite = false;
  return m;
}

/**
 * A traffic-light material for 4D planned-vs-actual colouring.
 *
 * Two non-obvious settings, both arrived at by screenshotting the running app:
 *
 *  - `toneMapped = false`. ACES answers overexposure by desaturating toward white, and
 *    a 2.2-intensity sun drives a saturated colour well past 1.0, so #e74c3c arrived
 *    on screen as pink and #f1c40f as cream. That is fatal for a traffic light.
 *  - Because an un-tone-mapped material CLAMPS instead, and clamping one channel of a
 *    saturated colour shifts its hue (green clamped its way to mint, red to salmon),
 *    the scene showing these must also be lit at roughly STATUS_LIGHTING below so that
 *    total illumination stays near 1.0 and the albedo passes through intact.
 *
 * Use both together or neither; either one alone still gives the wrong colour.
 */
export function makeStatusMaterial(color, opacity = 1) {
  const m = makeMaterial({ color, roughness: 0.85, metalness: 0.0,
                           opacity: opacity < 1 ? opacity : undefined });
  m.emissive = new THREE.Color(color);
  m.emissiveIntensity = 0.28;
  m.envMapIntensity = 0.25;
  m.toneMapped = false;
  return m;
}

/**
 * How the 4D simulation shades the model at the playhead date. There is no ghosting or
 * transparency anywhere in it any more -- every element is fully opaque, always.
 *
 * STATUS_TINT is how far a started/finished element's own colour is pulled towards its
 * traffic-light colour. NOT transparency: a half-transparent status material made the
 * building see-through (blending needs depth writing off, so you looked straight through
 * walls into the interior), and a faded "not built yet" pass was tried and rejected too
 * -- the ask is to see every element's real colour, always, and let the tint alone say
 * which of them are done, in progress, or untouched. Mixing the two colours keeps the
 * geometry solid while leaving the material readable -- pale concrete and dark timber
 * still look different from each other under the same green.
 *
 * Work with no recorded start, and elements no task is assigned to, are drawn exactly
 * the same way: their own material, full opacity, no tint.
 */
export const STATUS_TINT = 0.6;

/**
 * An element's own material pulled towards a traffic-light colour, staying opaque.
 *
 * Keeps the source material's transparency settings rather than forcing opacity, so
 * glass stays glass and only its hue shifts. A little emissive lifts the status colour
 * clear of the shading without washing the base tone out.
 */
export function makeTintMaterial(baseMat, statusColor, weight = STATUS_TINT) {
  const m = baseMat.clone();
  m.color = new THREE.Color(baseMat.color.getHex())
    .lerp(new THREE.Color(statusColor), weight);
  m.emissive = new THREE.Color(statusColor);
  m.emissiveIntensity = 0.1;
  m.envMapIntensity = 0.4;
  m.toneMapped = false;          // matches makeStatusMaterial, so hues read true
  return m;
}

/** A THREE colour (numeric or string) as "#rrggbb", for an <input type="color">. */
export function cssColor(c) {
  return "#" + new THREE.Color(c).getHexString();
}

/** Lighting a scene needs for makeStatusMaterial colours to read true. */
export const STATUS_LIGHTING = { sunIntensity: 0.9, hemiIntensity: 0.25 };

/** The bright, photographic lighting used when colour accuracy is not the point. */
export const REALISTIC_LIGHTING = { sunIntensity: 2.2, hemiIntensity: 0.35 };

/**
 * web-ifc-three gives every element a MeshLambertMaterial, which ignores the
 * environment map entirely and therefore renders flat no matter how good the
 * lighting is. This keeps the file's own color/alpha and only changes the shading
 * model, so files that DO carry real colors keep them exactly.
 */
export function toRealistic(src) {
  const isGlass = src.transparent === true && src.opacity < 0.95;
  const std = new THREE.MeshStandardMaterial({
    color: src.color,
    side: THREE.DoubleSide,
    transparent: src.transparent,
    opacity: src.opacity,
    roughness: isGlass ? 0.12 : 0.85,
    metalness: 0.0,
    envMapIntensity: 1.0,
  });
  if (std.transparent) std.depthWrite = false;
  return std;
}

/**
 * Reads every element in the model, grouping it two ways at once:
 *   - by material category (drives the colors)
 *   - by IFC name within each category (drives the component panel)
 *
 * Element IDs come from `geometry.attributes.expressID` -- a per-vertex buffer
 * web-ifc-three writes so it can still tell elements apart after merging them all
 * into a single mesh. This replaces the old per-mesh `userData.ifc` API, which this
 * library version no longer provides.
 */
export async function collectElements(loader, model, modelID) {
  const api = loader.ifcManager.state?.api;
  const idAttr = model.geometry?.attributes?.expressID;
  if (!idAttr) throw new Error("Model geometry has no expressID attribute");

  const uniqueIds = new Set();
  for (let i = 0; i < idAttr.count; i++) uniqueIds.add(idAttr.getX(i));

  const buckets = new Map();  // catKey -> { rule, ids[], names: Map<name, ids[]> }
  const catOfId = new Map();  // elementID -> catKey

  for (const id of uniqueIds) {
    let name = "";
    try {
      if (api) {
        const line = api.GetLine(modelID, id);
        name = line?.Name?.value || line?.ObjectType?.value || "";
      } else {
        const props = await loader.ifcManager.getItemProperties(modelID, id);
        name = props?.Name?.value || props?.ObjectType?.value || "";
      }
    } catch (e) { /* unnamed -> DEFAULT_RULE */ }

    const rule = RULES.find(r => r.re.test(name)) || DEFAULT_RULE;
    if (!buckets.has(rule.key)) {
      buckets.set(rule.key, { rule, ids: [], names: new Map() });
    }
    const bucket = buckets.get(rule.key);
    bucket.ids.push(id);
    catOfId.set(id, rule.key);

    const key = name || "(unnamed)";
    if (!bucket.names.has(key)) bucket.names.set(key, []);
    bucket.names.get(key).push(id);
  }
  return { allIds: [...uniqueIds], buckets, catOfId };
}

/**
 * Rebuilds the model as one "subset" per material category.
 *
 * Needed because a colorless IFC collapses into a SINGLE merged material -- there
 * is no per-element material to recolor. Subsets reuse the model's existing
 * position/normal buffers, so this costs no extra geometry memory.
 *
 * Returns the created meshes keyed by category, so callers can ghost them later.
 */
export function applyNamePalette(loader, model, modelID, scene, buckets) {
  const meshes = new Map();
  for (const [key, { rule, ids }] of buckets) {
    const subset = loader.ifcManager.createSubset({
      modelID,
      ids,
      material: makeMaterial(rule),
      scene,                 // reparents the subset out of the model, so hiding
      removePrevious: true,  // the original below doesn't hide the subsets too
      customID: key,
    });
    if (subset) {
      subset.castShadow = true;
      subset.receiveShadow = true;
      meshes.set(key, subset);
    }
  }
  model.visible = false; // the uncolored merged original
  return meshes;
}
