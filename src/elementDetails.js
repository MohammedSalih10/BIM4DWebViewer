// Fetches everything the "element details" dialog shows for ONE clicked element: its
// own name (same field the Contents panel groups elements by -- see ifcElements.js)
// and, via the schedule already in memory (no extra IFC reads needed), the single
// task that builds it, with its full set of dates (current, baseline, actual).
//
// Deliberately a THIRD, on-demand pass, separate from ifcMaterials.js's collectElements
// (drives colour, reads every element up front) and ifcElements.js's
// collectBuildingElements (drives the Contents tree, also reads every element up
// front). This one only ever runs for a single id at a time, right after a click.
export async function fetchElementDetails(loader, modelID, id, schedule) {
  const mgr = loader.ifcManager;

  let props = null;
  try { props = await mgr.getItemProperties(modelID, id); } catch (e) { /* no properties */ }

  const name = props?.Name?.value || props?.ObjectType?.value || `Element #${id}`;

  const taskId = schedule?.taskOfElement?.get(id);
  const task = taskId != null ? schedule.tasks.get(taskId) : null;

  return { id, name, task, hasBaseline: !!schedule?.hasBaseline };
}
