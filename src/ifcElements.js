// Builds the "Contents" tree for the side panel: the model listed as BUILDING
// ELEMENTS, the way Synchro's Contents panel lists it -- storey, then element
// category, then type.
//
// This is a different question from the one ./ifcMaterials.js answers. That file
// asks "what is this made of" (concrete, timber, glass) to pick a colour. This file
// asks "what building element is it" (a wall, a slab, a door). Same elements, two
// independent passes, because the answers come from different places in the file.
//
// Where each answer comes from, best source first:
//   1. the IFC entity class -- IfcWall, IfcSlab, IfcDoor. Authoritative. A Revit
//      export has these.
//   2. the element / type name -- the only thing left in a Synchro export, which
//      flattens every element to IfcBuildingElementProxy. Heuristic, so it can be
//      wrong; anything unrecognised lands in "Generic Models" rather than guessing.
//   3. IfcRelContainedInSpatialStructure for the storey, falling back to the "Level"
//      property Synchro copies out of Revit when the spatial structure is flattened.

const UNASSIGNED = "Unassigned";

/**
 * Element categories, roughly Revit's category list.
 *
 * `ifc` lists the entity classes that ARE this category -- an exact, trusted match.
 * `re` is the name fallback. ORDER MATTERS for `re`: the first match wins, so
 * specific patterns must sit above generic ones ("150mm Foundation Slab" has to
 * reach `foundations` before `floors` claims it for the word "slab").
 *
 * `not` is an escape hatch for the cases where one word belongs to two categories
 * and reordering the whole table would be worse: a "Roof Window" is a window, not a
 * roof, so `roofs` declines it and lets `windows` have it.
 */
export const ELEMENT_CATEGORIES = [
  { key: "planting", label: "Planting",
    ifc: ["IFCGEOGRAPHICELEMENT"],
    re: /poplar|locust|\bash\b|\boak\b|maple|birch|\btree\b|shrub|hedge|planting|\bgrass\b|lawn/i },

  { key: "site", label: "Site & Topography",
    ifc: [],
    re: /^surface|topo|terrain|\bsite\b|paving|\bpath\b|kerb|\bcurb\b/i },

  { key: "stairs", label: "Stairs & Ramps",
    ifc: ["IFCSTAIR", "IFCSTAIRFLIGHT", "IFCRAMP", "IFCRAMPFLIGHT"],
    re: /stair|\bramp\b|\btread\b|riser/i },

  { key: "railings", label: "Railings",
    ifc: ["IFCRAILING"],
    re: /railing|balustrade|handrail|guardrail/i },

  { key: "roofs", label: "Roofs",
    ifc: ["IFCROOF"],
    re: /\broof\b|shingle|fascia|soffit|gutter/i,
    not: /roof ?(window|light)|skylight/i },

  { key: "foundations", label: "Foundations & Piles",
    ifc: ["IFCFOOTING", "IFCPILE"],
    re: /foundation|footing|\bpile\b|\bpad\b|substructure|\braft\b|\d+mm diameter/i },

  { key: "curtainwall", label: "Curtain Walls & Glazing",
    ifc: ["IFCCURTAINWALL", "IFCPLATE"],
    // "64 x 128 rectangular" and "Rectangular - 50x50mm" are curtain wall mullion
    // profiles -- the only trace of them left once the IfcMember class is gone.
    re: /curtain|mullion|\bglazed\b|\d+\s*x\s*\d+.*rectangular|rectangular.*\d+\s*x\s*\d+/i },

  { key: "windows", label: "Windows",
    ifc: ["IFCWINDOW"],
    re: /window|roof ?light|skylight|\bglazing\b|\bcl_w\d|casement|\bfixed\b/i },

  { key: "doors", label: "Doors",
    ifc: ["IFCDOOR"],
    re: /\bdoor\b|\d{3,4}\s*x\s*2[01]\d{2}/i },

  { key: "walls", label: "Walls",
    ifc: ["IFCWALL", "IFCWALLSTANDARDCASE", "IFCWALLELEMENTEDCASE"],
    re: /wall|partition|\bsip\b|retaining|cavity|generic\s*\d|plaster|render|masonry|brick/i },

  { key: "floors", label: "Floors & Slabs",
    ifc: ["IFCSLAB"],
    re: /floor|\bslab\b|\bdeck\b|screed|insitu concrete|suspended/i },

  { key: "ceilings", label: "Ceilings & Finishes",
    ifc: ["IFCCOVERING"],
    re: /ceiling|\bgrid\b|bulkhead|covering|skirting/i },

  { key: "columns", label: "Columns",
    ifc: ["IFCCOLUMN"],
    re: /column|\bpier\b|\bpost\b/i },

  { key: "framing", label: "Structural Framing",
    ifc: ["IFCBEAM", "IFCMEMBER"],
    re: /beam|joist|truss|brace|\brsa\b|angle|^l\d+x\d+|purlin|rafter|lintel|stud|batten|framing/i },

  { key: "lighting", label: "Lighting Fixtures",
    ifc: ["IFCLIGHTFIXTURE"],
    re: /light|\blamp\b|luminaire|trck|track|downlight|fluoresc|cooper|^p-d-/i },

  { key: "plumbing", label: "Plumbing Fixtures",
    ifc: ["IFCSANITARYTERMINAL"],
    re: /basin|\bwc\b|toilet|sink|bath|shower|lavator|sanitar|urinal|walvit|cistern|plumbing/i },

  { key: "mep", label: "Mechanical & Electrical",
    ifc: ["IFCDUCTSEGMENT", "IFCPIPESEGMENT", "IFCAIRTERMINAL", "IFCSPACEHEATER",
          "IFCELECTRICAPPLIANCE", "IFCENERGYCONVERSIONDEVICE", "IFCFLOWSEGMENT",
          "IFCFLOWFITTING", "IFCELECTRICDISTRIBUTIONPOINT"],
    re: /duct|pipe|\bhvac\b|boiler|radiator|\bfan\b|pump|valve|solar|sunmodule|photovolt|generator|meters high|\btank\b|\d+l \d+x|rangehood|\bhood\b|fridge|freezer|dishwasher|washing machine|tumble dryer|\boven\b|microwave|cooktop|induction|appliance|electric|socket/i },

  { key: "furniture", label: "Furniture & Casework",
    ifc: ["IFCFURNISHINGELEMENT", "IFCFURNITURE", "IFCSYSTEMFURNITUREELEMENT"],
    re: /chair|sofa|seat|\bbed\b|table|desk|wardrobe|cabinet|shelf|counter|worktop|island|casework|vase|bottle|plate|glass|china|cushion|cotton|stool|bench|kitchen|^w\d+xd\d+/i },

  { key: "specialty", label: "Specialty Equipment",
    ifc: [],
    re: /entourage|\brpc\b|fire ?place|beetle/i },

  { key: "spaces", label: "Spaces & Rooms",
    ifc: ["IFCSPACE", "IFCZONE"],
    re: /^room\b|^space\b/i },
];

export const GENERIC_CATEGORY = { key: "generic", label: "Generic Models" };

// class name -> category key, built once from the table above.
const CATEGORY_OF_CLASS = {};
for (const c of ELEMENT_CATEGORIES) {
  for (const cls of c.ifc) CATEGORY_OF_CLASS[cls] = c.key;
}

const LABEL_OF_CATEGORY = { [GENERIC_CATEGORY.key]: GENERIC_CATEGORY.label };
for (const c of ELEMENT_CATEGORIES) LABEL_OF_CATEGORY[c.key] = c.label;

// Classes that say nothing useful on their own, so the name gets first say.
// IfcBuildingElementProxy is the big one -- it is what Synchro writes for
// everything. IfcFlowTerminal covers both a downlight and a washbasin in a Revit
// export, so the name has to break the tie. IfcSite gets in here because Revit
// puts site-hosted equipment (wind turbines) under it alongside the topography.
const AMBIGUOUS_CLASSES = new Set([
  "IFCBUILDINGELEMENTPROXY", "IFCELEMENTASSEMBLY", "IFCBUILDINGELEMENTPART",
  "IFCFLOWTERMINAL", "IFCDISTRIBUTIONELEMENT", "IFCDISTRIBUTIONFLOWELEMENT",
  "IFCDISCRETEACCESSORY", "IFCMECHANICALFASTENER", "IFCSITE", "IFCPRODUCT",
  "IFCELEMENT", "IFCBUILDINGELEMENT", "IFCBUILDINGELEMENTCOMPONENT", "",
]);

/** Resolves one element to a category key. `text` is its name + object type. */
export function categoryOf(ifcClass, text) {
  const cls = (ifcClass || "").toUpperCase();

  if (!AMBIGUOUS_CLASSES.has(cls) && CATEGORY_OF_CLASS[cls]) {
    return CATEGORY_OF_CLASS[cls];
  }
  if (text) {
    const hit = ELEMENT_CATEGORIES.find(c => c.re.test(text) && !c.not?.test(text));
    if (hit) return hit.key;
  }
  // Nothing in the name matched, so fall back on whatever the class knew.
  return CATEGORY_OF_CLASS[cls] || GENERIC_CATEGORY.key;
}

/**
 * Revit writes element names as "Family:Type:123456" and repeats "Family:Type" in
 * ObjectType. Prefer ObjectType; otherwise drop the trailing element id, which is
 * unique per element and would give every element its own row in the tree.
 */
function typeNameFrom(name, objectType) {
  if (objectType) return objectType;
  if (!name) return "";
  const parts = name.split(":");
  if (parts.length >= 3 && /^\d+$/.test(parts[parts.length - 1])) {
    return parts.slice(0, -1).join(":");
  }
  return name;
}

/** Express IDs of every line of one class. Returns [] instead of throwing. */
async function idsOfClass(loader, modelID, ifcClass) {
  try {
    const vec = await loader.ifcManager.idsByType(modelID, ifcClass);
    const out = [];
    if (vec) for (let i = 0; i < vec.size(); i++) out.push(vec.get(i));
    return out;
  } catch (e) {
    console.warn(`idsByType(${ifcClass}) failed:`, e);
    return [];
  }
}

// Property names that answer "which storey", best first.
const LEVEL_PROPS = ["Level", "Reference Level", "Base Level", "Schedule Level"];

// Property names that say what KIND of element this is. Revit's Uniformat assembly
// description and OmniClass title survive a Synchro export even though the entity
// class does not: "Pile Caps", "Interior Doors", "Lavatories - Single", "Planting".
// Real data from the file, so it beats guessing from a type name like "600mm
// Diameter".
const CLASS_HINT_PROPS = [
  "Family Parameter: Assembly Description",
  "Type Parameter: Assembly Description",
  "Family Parameter: OmniClass Title",
  "Type Parameter: OmniClass Title",
];

/**
 * Works out which storey each element sits on, and picks up any classification hint
 * on the way past.
 *
 * Returns { levelOf, elevations, hintOf }. `elevations` only exists to sort the
 * storeys bottom-to-top.
 */
async function readLevels(loader, api, modelID, ids) {
  const levelOf = new Map();
  const elevations = new Map();
  const hintOf = new Map();
  if (!api) return { levelOf, elevations, hintOf };

  // 1. Real spatial containment. A Revit export resolves almost everything here.
  const labelOfStructure = new Map();
  for (const relId of await idsOfClass(loader, modelID, "IfcRelContainedInSpatialStructure")) {
    const rel = api.GetLine(modelID, relId);
    const structId = rel?.RelatingStructure?.value;
    if (structId == null) continue;

    if (!labelOfStructure.has(structId)) {
      const s = api.GetLine(modelID, structId);
      labelOfStructure.set(
        structId,
        s?.Name?.value || s?.LongName?.value || `Storey ${structId}`
      );
    }
    const label = labelOfStructure.get(structId);
    for (const ref of rel.RelatedElements || []) {
      if (ids.has(ref.value)) levelOf.set(ref.value, label);
    }
  }

  for (const storeyId of await idsOfClass(loader, modelID, "IfcBuildingStorey")) {
    const s = api.GetLine(modelID, storeyId);
    const label = s?.Name?.value || s?.LongName?.value;
    const elev = s?.Elevation?.value;
    if (label && typeof elev === "number") elevations.set(label, elev);
  }

  // 2. Aggregated children (a stair's flights, a curtain wall's panels) are
  //    contained via their parent, not directly. Inherit the parent's storey.
  //    Two passes cover the nesting depth real files use.
  const aggregateRels = await idsOfClass(loader, modelID, "IfcRelAggregates");
  for (let pass = 0; pass < 2; pass++) {
    for (const relId of aggregateRels) {
      const rel = api.GetLine(modelID, relId);
      const parent = rel?.RelatingObject?.value;
      const label = parent != null ? levelOf.get(parent) : undefined;
      if (!label) continue;
      for (const ref of rel.RelatedObjects || []) {
        if (ids.has(ref.value) && !levelOf.has(ref.value)) levelOf.set(ref.value, label);
      }
    }
  }

  // 3. Read the property sets, for two reasons.
  //
  //    Synchro's exporter DOES write a spatial structure -- it just puts the entire
  //    building into a single invented storey called "Storey-1". So the check here
  //    cannot be "did anything fail to resolve"; nothing fails, the answer is just
  //    useless. It has to be "did the spatial structure tell us anything at all",
  //    which means more than one storey. When it didn't, Revit's real Level is still
  //    sitting in a SynchroResourceProperty property set, and it OVERRIDES the
  //    invented storey.
  //
  //    The same pass picks up the classification hints, which only files that lost
  //    their entity classes need. A Revit export resolves its storeys properly and
  //    so never pays for any of this.
  const flattened = new Set(levelOf.values()).size <= 1;
  const unresolved = [...ids].filter(id => !levelOf.has(id));
  if (!flattened && unresolved.length === 0) return { levelOf, elevations, hintOf };

  // The invented storey name is worse than no answer -- "Storey-1" means nothing to
  // anyone. Drop it, so elements whose property set has no Level end up under
  // "Unassigned" and the panel says so plainly.
  if (flattened) { levelOf.clear(); elevations.clear(); }

  const want = flattened ? new Set(ids) : new Set(unresolved);
  for (const relId of await idsOfClass(loader, modelID, "IfcRelDefinesByProperties")) {
    const rel = api.GetLine(modelID, relId);
    const targets = (rel?.RelatedObjects || [])
      .map(r => r.value)
      .filter(id => want.has(id));
    if (targets.length === 0) continue;

    const psetId = rel?.RelatingPropertyDefinition?.value;
    if (psetId == null) continue;
    const pset = api.GetLine(modelID, psetId);

    let level = "";
    let hint = "";
    let levelRank = LEVEL_PROPS.length;
    let hintRank = CLASS_HINT_PROPS.length;

    for (const propRef of pset?.HasProperties || []) {
      const prop = api.GetLine(modelID, propRef.value);
      const propName = prop?.Name?.value;
      if (!propName) continue;
      const value = prop?.NominalValue?.value;
      if (!value || typeof value !== "string") continue;

      // Take the best-ranked name we see, not the first, since property sets are
      // not written in any particular order.
      const li = LEVEL_PROPS.indexOf(propName);
      if (li !== -1 && li < levelRank) { levelRank = li; level = value; }
      const hi = CLASS_HINT_PROPS.indexOf(propName);
      if (hi !== -1 && hi < hintRank) { hintRank = hi; hint = value; }
    }

    for (const id of targets) {
      if (level && (flattened || !levelOf.has(id))) levelOf.set(id, level);
      if (hint) hintOf.set(id, hint);
    }
  }

  return { levelOf, elevations, hintOf };
}

/** count/ids roll up from the children, so no node can disagree with its subtree. */
function makeNode(key, label, children) {
  const ids = children.flatMap(c => c.ids);
  return { key, label, count: ids.length, ids, children };
}

function sortByCount(nodes) {
  return nodes.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * Reads every element and returns two views of the same data, ready to render:
 *
 *   categoryTree: category -> type
 *   levelTree:    storey -> category -> type
 *
 * Both are arrays of { key, label, count, ids, children }, so one recursive
 * renderer draws either.
 */
export async function collectBuildingElements(loader, model, modelID) {
  const api = loader.ifcManager.state?.api;
  const idAttr = model.geometry?.attributes?.expressID;
  if (!idAttr) throw new Error("Model geometry has no expressID attribute");

  const ids = new Set();
  for (let i = 0; i < idAttr.count; i++) ids.add(idAttr.getX(i));

  const { levelOf, elevations, hintOf } = await readLevels(loader, api, modelID, ids);

  // level -> category -> type -> ids[]
  const grouped = new Map();
  let classified = 0;

  for (const id of ids) {
    let ifcClass = "";
    let name = "";
    let objectType = "";
    try {
      ifcClass = loader.ifcManager.getIfcType(modelID, id) || "";
    } catch (e) { /* class unknown -> the name decides */ }
    try {
      const line = api?.GetLine(modelID, id);
      name = line?.Name?.value || "";
      objectType = line?.ObjectType?.value || "";
    } catch (e) { /* unnamed -> Generic Models */ }

    // Only fall back on the property-set hint when the class and the name both came
    // up empty, so a hint can never override something we already know.
    let cat = categoryOf(ifcClass, `${name} ${objectType}`);
    if (cat === GENERIC_CATEGORY.key && hintOf.has(id)) {
      cat = categoryOf(ifcClass, hintOf.get(id));
    }
    if (cat !== GENERIC_CATEGORY.key) classified++;
    const type = typeNameFrom(name, objectType) || "(unnamed)";
    const level = levelOf.get(id) || UNASSIGNED;

    if (!grouped.has(level)) grouped.set(level, new Map());
    const cats = grouped.get(level);
    if (!cats.has(cat)) cats.set(cat, new Map());
    const types = cats.get(cat);
    if (!types.has(type)) types.set(type, []);
    types.get(type).push(id);
  }

  // Storeys bottom-to-top where the file gave elevations, alphabetical otherwise,
  // and anything we could not place always last.
  const levelNames = [...grouped.keys()].sort((a, b) => {
    if (a === UNASSIGNED) return 1;
    if (b === UNASSIGNED) return -1;
    const ea = elevations.get(a);
    const eb = elevations.get(b);
    if (ea != null && eb != null) return ea - eb;
    if (ea != null) return -1;
    if (eb != null) return 1;
    return a.localeCompare(b);
  });

  const levelTree = levelNames.map(level => {
    const cats = sortByCount([...grouped.get(level).entries()].map(([cat, types]) =>
      makeNode(
        `${level}/${cat}`,
        LABEL_OF_CATEGORY[cat] || cat,
        sortByCount([...types.entries()].map(([type, typeIds]) => ({
          key: `${level}/${cat}/${type}`, label: type,
          count: typeIds.length, ids: typeIds, children: [],
        })))
      )
    ));
    return makeNode(level, level, cats);
  });

  // Same elements, collapsed across storeys.
  const flat = new Map(); // cat -> type -> ids[]
  for (const cats of grouped.values()) {
    for (const [cat, types] of cats) {
      if (!flat.has(cat)) flat.set(cat, new Map());
      const into = flat.get(cat);
      for (const [type, typeIds] of types) {
        if (!into.has(type)) into.set(type, []);
        into.get(type).push(...typeIds);
      }
    }
  }

  const categoryTree = sortByCount([...flat.entries()].map(([cat, types]) =>
    makeNode(
      cat,
      LABEL_OF_CATEGORY[cat] || cat,
      sortByCount([...types.entries()].map(([type, typeIds]) => ({
        key: `${cat}/${type}`, label: type,
        count: typeIds.length, ids: typeIds, children: [],
      })))
    )
  ));

  return {
    total: ids.size,
    classified,                      // how many landed somewhere other than Generic
    levelCount: levelNames.filter(n => n !== UNASSIGNED).length,
    categoryTree,
    levelTree,
  };
}
