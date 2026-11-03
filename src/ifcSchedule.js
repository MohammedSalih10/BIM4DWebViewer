// Reads the 4D schedule out of an IFC file: the WBS task tree, planned/actual
// dates, the dependency network, and which building elements each task builds.
// Also runs the critical-path maths. Shared by the Gantt panel and the 4D compare
// view, so there is exactly one schedule reader in the app.
//
// Everything here was checked against the real Synchro export rather than assumed,
// because IFC2X3 scheduling is full of traps:
//
//   * A task's dates are NOT on the IfcTask. They hang off an IfcScheduleTimeControl
//     reached through IfcRelAssignsTasks.TimeForTask. Querying IfcRelAssignsToControl
//     instead finds nothing, because its RelatingControl is the IfcWorkSchedule.
//   * IfcTask.Description holds the WBS outline number ("2.1.1.3") and IfcTask.TaskId
//     holds the activity code ("A1050"). Not the other way round.
//   * IfcRelSequence.TimeLag is in WORKING seconds on an 8-hour day. A lag of 403200
//     is 14 working days, which shows up as a ~20 calendar-day gap once weekends are
//     counted. Reading it as calendar seconds makes every float wrong.
//   * Date entities must be recognised by their fields, not their class name:
//     GetNameFromTypeCode returns "IfcDateAndTime" in web-ifc 0.0.77 but
//     "IFCDATEANDTIME" in the 0.0.39 that web-ifc-three bundles.
//   * Synchro writes progress as THREE date pairs, never all on the same task, and
//     the pattern (measured on synchro_plannedvsactual.ifc) is:
//       - ScheduleStart/ScheduleFinish  -> the baseline. Always present.
//       - ActualStart/ActualFinish      -> only on COMPLETED tasks (Completion=100).
//       - EarlyStart                    -> only on NOT-YET-COMPLETE tasks. This is
//         the current forecast, so it is where a future delay shows up.
//     EarlyFinish, StatusTime, ActualDuration, RemainingTime, TotalFloat and
//     IsCritical are all empty, so the forecast FINISH has to be derived as
//     EarlyStart + ScheduleDuration. That is why `effFinish` exists below.
//   * The export's data date ("today") is IfcWorkSchedule.CreationDate, not the max
//     actual finish -- work can be complete days before the snapshot was taken.

const DAY = 86400000;
const WORK_SECONDS_PER_DAY = 28800;   // 8h day, the unit IfcRelSequence.TimeLag uses
const EPOCH = Date.UTC(2020, 0, 6);   // a Monday, so workday 0 is a Monday

/** Midnight UTC of a date, so day arithmetic can't drift on a DST boundary. */
function utcMidnight(d) {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Turns a date into "how many Mon-Fri days since the epoch". Adding working days is
 * then plain integer arithmetic, and weekends can't be scheduled into by accident.
 */
export function workdayIndex(date) {
  const days = Math.floor((utcMidnight(date) - EPOCH) / DAY);
  const weeks = Math.floor(days / 7);
  const dow = days - weeks * 7;       // 0 = Monday ... 6 = Sunday
  return weeks * 5 + Math.min(dow, 4);
}

export function dateFromWorkday(index) {
  const weeks = Math.floor(index / 5);
  const rem = index - weeks * 5;
  return new Date(EPOCH + (weeks * 7 + rem) * DAY);
}

/** Shifts a date by whole WORKING days, so a forecast can never land on a weekend. */
export function addWorkdays(date, days) {
  return dateFromWorkday(workdayIndex(date) + days);
}

/** Whole calendar days between two dates. Used for the "N days late" readout. */
export function calendarDaysBetween(a, b) {
  return Math.round((utcMidnight(new Date(b)) - utcMidnight(new Date(a))) / DAY);
}

/**
 * `date`'s calendar day carrying `reference`'s time of day.
 *
 * Needed because dateFromWorkday only understands whole days and returns midnight,
 * while the file's dates carry a real clock time -- IFCLOCALTIME(8,0) on some tasks,
 * (0,0) on others. Without this, a one-day task forecast to start at 08:00 gets a
 * derived finish at 00:00 the SAME day, i.e. a finish before its own start, and the
 * "is it done yet" test then fires eight hours early.
 */
function withTimeOf(date, reference) {
  if (!reference) return date;
  return new Date(Date.UTC(
    date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(),
    reference.getUTCHours(), reference.getUTCMinutes(), reference.getUTCSeconds()
  ));
}

/** Express IDs of every line of one class. Returns [] rather than throwing. */
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

/**
 * Resolves an IfcDateTimeSelect handle (IfcDateAndTime or IfcCalendarDate) to a Date.
 * Recognises which one it is from the fields present -- see the header note about
 * class-name casing differing between web-ifc versions.
 */
export function resolveIfcDateTime(api, modelID, attr) {
  if (!attr || attr.value == null) return null;
  try {
    const e = api.GetLine(modelID, attr.value);
    if (!e) return null;

    if (e.DateComponent) {                       // IfcDateAndTime
      const d = api.GetLine(modelID, e.DateComponent.value);
      if (!d || d.YearComponent == null) return null;
      const t = e.TimeComponent ? api.GetLine(modelID, e.TimeComponent.value) : null;
      return new Date(Date.UTC(
        d.YearComponent.value, d.MonthComponent.value - 1, d.DayComponent.value,
        t?.HourComponent?.value ?? 0, t?.MinuteComponent?.value ?? 0, 0
      ));
    }
    if (e.YearComponent != null) {                // IfcCalendarDate
      return new Date(Date.UTC(
        e.YearComponent.value, e.MonthComponent.value - 1, e.DayComponent.value
      ));
    }
  } catch (err) {
    console.warn("Failed to resolve IFC date/time:", attr, err);
  }
  return null;
}

/** "2.1.10" -> [2,1,10], so WBS numbers sort numerically instead of as text. */
function wbsSortKey(wbs) {
  if (!wbs) return [Number.MAX_SAFE_INTEGER];
  const parts = String(wbs).split(".").map(p => {
    const n = parseInt(p, 10);
    return Number.isNaN(n) ? Number.MAX_SAFE_INTEGER : n;
  });
  return parts.length ? parts : [Number.MAX_SAFE_INTEGER];
}

function compareWbs(a, b) {
  const ka = wbsSortKey(a.wbs);
  const kb = wbsSortKey(b.wbs);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const d = (ka[i] ?? -1) - (kb[i] ?? -1);
    if (d) return d;
  }
  return 0;
}

const SEQUENCE_TYPES = {
  FINISH_START: "FS", START_START: "SS", FINISH_FINISH: "FF", START_FINISH: "SF",
};

/**
 * Total float per task, and the driving (critical) path.
 *
 * The imported dates are treated as the early dates -- they are what the planner
 * committed to -- and a backward pass through the dependency network gives the late
 * dates, hence the float.
 *
 * Critical is then the DRIVING PATH, not the set of zero-float tasks. On a real
 * imported schedule the lag values are approximations of the gaps the planner
 * actually left, so almost nothing lands on exactly zero float: this file's main
 * chain runs from 18 down to 2 days of float and only the very last activity hits
 * zero. Selecting on zero float would report a one-task critical path, which is
 * useless. The longest chain by duration-plus-lag, anchored at whatever finishes
 * last, is the chain that actually drives the end date.
 */
function computeCriticalPath(tasks, links) {
  const leaves = [...tasks.values()].filter(t => !t.isSummary && t.start && t.finish);
  for (const t of leaves) {
    t.esWd = workdayIndex(t.start);
    t.efWd = workdayIndex(t.finish);
    t.durationDays = Math.max(0, t.efWd - t.esWd);
  }

  const usable = links.filter(l => {
    const a = tasks.get(l.from);
    const b = tasks.get(l.to);
    return a && b && !a.isSummary && !b.isSummary && a.start && b.start;
  });

  const succ = new Map();
  const pred = new Map();
  for (const l of usable) {
    if (!succ.has(l.from)) succ.set(l.from, []);
    succ.get(l.from).push(l);
    if (!pred.has(l.to)) pred.set(l.to, []);
    pred.get(l.to).push(l);
  }

  // Topological order, sinks first. The `state` map doubles as cycle protection: a
  // schedule with a circular dependency must not hang the viewer.
  const state = new Map();
  const sinksFirst = [];
  let cyclic = false;
  const visit = (id) => {
    const s = state.get(id) || 0;
    if (s === 1) { cyclic = true; return; }
    if (s === 2) return;
    state.set(id, 1);
    for (const l of succ.get(id) || []) visit(l.to);
    state.set(id, 2);
    sinksFirst.push(id);
  };
  for (const t of leaves) visit(t.id);
  if (cyclic) console.warn("Schedule has a circular dependency; float may be wrong.");

  // --- backward pass: latest finish, therefore float ---
  const projectFinishWd = leaves.length ? Math.max(...leaves.map(t => t.efWd)) : 0;
  const lateFinish = new Map();
  for (const id of sinksFirst) {
    const t = tasks.get(id);
    if (!t) continue;
    let lf = projectFinishWd;
    for (const l of succ.get(id) || []) {
      const s = tasks.get(l.to);
      if (!s) continue;
      const sLF = lateFinish.get(l.to) ?? s.efWd;
      const sLS = sLF - s.durationDays;
      switch (l.type) {
        case "SS": lf = Math.min(lf, sLS - l.lagDays + t.durationDays); break;
        case "FF": lf = Math.min(lf, sLF - l.lagDays); break;
        case "SF": lf = Math.min(lf, sLF - l.lagDays + t.durationDays); break;
        default:   lf = Math.min(lf, sLS - l.lagDays); break;   // FS
      }
    }
    lateFinish.set(id, lf);
  }
  for (const t of leaves) t.totalFloat = (lateFinish.get(t.id) ?? t.efWd) - t.efWd;

  // --- longest chain by duration + lag, walking sources first ---
  const chainLength = new Map();
  const drivenBy = new Map();
  for (let i = sinksFirst.length - 1; i >= 0; i--) {
    const id = sinksFirst[i];
    const t = tasks.get(id);
    if (!t) continue;
    let bestLen = t.durationDays;
    let bestFrom = null;
    for (const l of pred.get(id) || []) {
      if (!chainLength.has(l.from)) continue;
      const len = chainLength.get(l.from) + l.lagDays + t.durationDays;
      if (len > bestLen) { bestLen = len; bestFrom = l.from; }
    }
    chainLength.set(id, bestLen);
    drivenBy.set(id, bestFrom);
  }

  // Anchor on whatever finishes last -- that is the date the path has to explain --
  // and break ties on the longer chain.
  let endId = null;
  for (const t of leaves) {
    if (endId == null) { endId = t.id; continue; }
    const cur = tasks.get(endId);
    if (t.efWd > cur.efWd ||
        (t.efWd === cur.efWd && (chainLength.get(t.id) ?? 0) > (chainLength.get(endId) ?? 0))) {
      endId = t.id;
    }
  }

  const criticalIds = new Set();
  const guard = new Set();
  for (let id = endId; id != null && !guard.has(id); id = drivenBy.get(id)) {
    guard.add(id);
    criticalIds.add(id);
  }
  for (const t of leaves) t.critical = criticalIds.has(t.id);

  return { criticalIds, cyclic, projectFinishWd };
}

/**
 * Reads the whole schedule. Returns null-ish (`hasSchedule: false`) rather than
 * throwing when a file simply has no IfcTask in it.
 */
export async function readSchedule(loader, modelID) {
  const api = loader.ifcManager.state?.api;
  const empty = {
    hasSchedule: false, tasks: new Map(), roots: [], rows: [], links: [],
    range: null, criticalIds: new Set(), taskOfElement: new Map(), linkedElements: 0,
  };
  if (!api) return empty;

  // --- tasks ---
  const tasks = new Map();
  for (const id of await idsOfClass(loader, modelID, "IfcTask")) {
    const t = api.GetLine(modelID, id);
    if (!t) continue;
    tasks.set(id, {
      id,
      name: t.Name?.value || `Task ${id}`,
      wbs: t.Description?.value || "",        // outline number, e.g. "2.1.1.3"
      code: t.TaskId?.value || "",            // activity id, e.g. "A1050"
      milestone: t.IsMilestone?.value === true,
      start: null, finish: null, actualStart: null, actualFinish: null,
      // Forecast dates + percent complete, all from IfcScheduleTimeControl. See the
      // header note: Synchro puts the forecast in EarlyStart and leaves EarlyFinish
      // empty, so forecastFinish below is derived, not read.
      forecastStart: null, forecastFinish: null, completion: null,
      scheduleDurationDays: null,
      // Effective (best-known) dates: actual if it happened, else forecast, else plan.
      effStart: null, effFinish: null, varianceDays: 0,
      children: [], parent: null, depth: 0, isSummary: false,
      elementIds: [], durationDays: 0, totalFloat: null, critical: false,
    });
  }
  if (tasks.size === 0) return empty;

  // --- dates, via IfcRelAssignsTasks.TimeForTask ---
  for (const relId of await idsOfClass(loader, modelID, "IfcRelAssignsTasks")) {
    const rel = api.GetLine(modelID, relId);
    if (!rel?.TimeForTask) continue;
    const control = api.GetLine(modelID, rel.TimeForTask.value);
    if (!control) continue;
    for (const ref of rel.RelatedObjects || []) {
      const t = tasks.get(ref.value);
      if (!t) continue;
      t.start = resolveIfcDateTime(api, modelID, control.ScheduleStart);
      t.finish = resolveIfcDateTime(api, modelID, control.ScheduleFinish);
      t.actualStart = resolveIfcDateTime(api, modelID, control.ActualStart);
      t.actualFinish = resolveIfcDateTime(api, modelID, control.ActualFinish);
      t.forecastStart = resolveIfcDateTime(api, modelID, control.EarlyStart);
      t.forecastFinish = resolveIfcDateTime(api, modelID, control.EarlyFinish);
      const secs = control.ScheduleDuration?.value;
      if (secs != null) t.scheduleDurationDays = Math.round(secs / WORK_SECONDS_PER_DAY);
      t.completion = control.Completion?.value ?? null;
    }
  }

  // The snapshot date the file was exported at -- the "today" the progress is stated
  // against. Falls back to the latest actual finish for files that omit it.
  let dataDate = null;
  for (const cls of ["IfcWorkSchedule", "IfcWorkPlan"]) {
    for (const id of await idsOfClass(loader, modelID, cls)) {
      const wc = api.GetLine(modelID, id);
      const d = resolveIfcDateTime(api, modelID, wc?.CreationDate);
      if (d && (!dataDate || d > dataDate)) dataDate = d;
    }
    if (dataDate) break;
  }

  // --- WBS hierarchy, via IfcRelNests ---
  for (const relId of await idsOfClass(loader, modelID, "IfcRelNests")) {
    const rel = api.GetLine(modelID, relId);
    const parent = tasks.get(rel?.RelatingObject?.value);
    if (!parent) continue;
    for (const ref of rel.RelatedObjects || []) {
      const child = tasks.get(ref.value);
      if (!child || child.id === parent.id) continue;
      parent.children.push(child.id);
      child.parent = parent.id;
    }
  }
  for (const t of tasks.values()) t.isSummary = t.children.length > 0;

  // --- which elements each task builds, via IfcRelAssignsToProcess ---
  const taskOfElement = new Map();
  let linkedElements = 0;
  for (const relId of await idsOfClass(loader, modelID, "IfcRelAssignsToProcess")) {
    const rel = api.GetLine(modelID, relId);
    const t = tasks.get(rel?.RelatingProcess?.value);
    if (!t) continue;
    for (const ref of rel.RelatedObjects || []) {
      t.elementIds.push(ref.value);
      taskOfElement.set(ref.value, t.id);
      linkedElements++;
    }
  }

  // --- dependencies, via IfcRelSequence ---
  const links = [];
  for (const relId of await idsOfClass(loader, modelID, "IfcRelSequence")) {
    const rel = api.GetLine(modelID, relId);
    const from = rel?.RelatingProcess?.value;   // predecessor
    const to = rel?.RelatedProcess?.value;      // successor
    if (from == null || to == null || from === to) continue;
    const raw = String(rel.SequenceType?.value || "FINISH_START").replace(/\./g, "");
    links.push({
      from, to,
      type: SEQUENCE_TYPES[raw] || "FS",
      lagDays: Math.round((rel.TimeLag?.value ?? 0) / WORK_SECONDS_PER_DAY),
    });
  }

  // Summary tasks whose own dates are missing get them rolled up from their children,
  // deepest first so a summary of summaries still works.
  const byDepth = [];
  const setDepth = (id, depth, seen) => {
    const t = tasks.get(id);
    if (!t || seen.has(id)) return;
    seen.add(id);
    t.depth = depth;
    byDepth.push(t);
    t.children.sort((a, b) => compareWbs(tasks.get(a), tasks.get(b)));
    for (const c of t.children) setDepth(c, depth + 1, seen);
  };
  const seen = new Set();
  const roots = [...tasks.values()].filter(t => t.parent == null).sort(compareWbs);
  for (const r of roots) setDepth(r.id, 0, seen);
  // Anything the nesting relations orphaned still has to appear somewhere.
  for (const t of tasks.values()) if (!seen.has(t.id)) setDepth(t.id, 0, seen);

  for (let i = byDepth.length - 1; i >= 0; i--) {
    const t = byDepth[i];
    if (!t.isSummary) continue;
    const kids = t.children.map(id => tasks.get(id)).filter(Boolean);
    const starts = kids.map(k => k.start).filter(Boolean);
    const finishes = kids.map(k => k.finish).filter(Boolean);
    if (!t.start && starts.length) t.start = new Date(Math.min(...starts.map(Number)));
    if (!t.finish && finishes.length) t.finish = new Date(Math.max(...finishes.map(Number)));
    // A summary "builds" everything underneath it, so clicking one selects the lot.
    const ids = new Set(t.elementIds);
    for (const k of kids) for (const e of k.elementIds) ids.add(e);
    t.elementIds = [...ids];
    // Progress rolls up too: a summary is only as complete as its children, and it
    // is only "started" once its earliest child started.
    const aStarts = kids.map(k => k.actualStart).filter(Boolean);
    if (!t.actualStart && aStarts.length) t.actualStart = new Date(Math.min(...aStarts.map(Number)));
    const aFins = kids.map(k => k.actualFinish);
    if (!t.actualFinish && aFins.length && aFins.every(Boolean)) {
      t.actualFinish = new Date(Math.max(...aFins.map(Number)));   // every child done
    }
    if (t.completion == null && kids.length) {
      const pcts = kids.map(k => k.completion ?? 0);
      t.completion = Math.round(pcts.reduce((a, b) => a + b, 0) / kids.length);
    }
  }

  // --- effective dates + variance ---
  // "Effective" = the best-known truth for a task: what actually happened if it has,
  // otherwise the current forecast, otherwise the baseline. Everything the traffic
  // lights do is a comparison between these and the baseline.
  for (const t of tasks.values()) {
    // THE FILE'S OWN SCHEDULE, under names that survive a baseline merge.
    //
    // These are the Gantt's "Start"/"Finish" columns: the CURRENT schedule as the
    // updated export left it, already rescheduled along the IfcRelSequence logic, so a
    // slip on an early activity has pushed its successors out. withBaseline overwrites
    // start/finish with the baseline dates, which would otherwise destroy the only copy
    // of them -- the same overwrite Synchro performs on the plan, one level up.
    t.curStart = t.start;
    t.curFinish = t.finish;

    // ScheduleDuration counts working days INCLUSIVELY: A1080 "GF Slab" has a
    // duration of 1 day and a planned start equal to its planned finish, and A1000
    // has 5 days across Thu 11 Jun -> Wed 17 Jun. So the offset to add to a start to
    // reach its finish is duration - 1, never duration. Adding the full duration
    // pushes every derived forecast one day late and invents variance that isn't
    // in the file -- which is exactly what the first version of this did.
    const durOffset = t.scheduleDurationDays != null
      ? Math.max(0, t.scheduleDurationDays - 1)
      : (t.start && t.finish
          ? Math.max(0, workdayIndex(t.finish) - workdayIndex(t.start))
          : 0);

    // Synchro leaves EarlyFinish empty, so a forecast finish has to be built from the
    // forecast start plus the baseline duration, then given a sensible clock time and
    // clamped so a same-day task can never finish before it starts.
    let derivedFinish = null;
    if (t.forecastStart) {
      derivedFinish = withTimeOf(addWorkdays(t.forecastStart, durOffset),
                                 t.finish || t.forecastStart);
      if (+derivedFinish < +t.forecastStart) derivedFinish = t.forecastStart;
    }

    // PRECEDENCE: actual, then THE FILE'S OWN exported dates, then a forecast.
    //
    // The updated export already carries the answer for both cases: finished activities
    // have Actual Start/Finish, and activities still to come have Start/Finish that
    // Synchro has already pushed out if they slipped. Reading those directly is what
    // makes "Var" simple arithmetic the user can check by eye -- BL finish against the
    // finish shown in the same row.
    //
    // The forecast now ranks BELOW them, and derivedFinish is a last resort for files
    // with no ScheduleFinish at all. Previously derivedFinish outranked the exported
    // finish, so wherever EarlyStart was populated the variance was measured against a
    // RECONSTRUCTED date: on newsynchro.ifc that put A1070 Backfilling at 2026-08-20
    // when the file plainly says 2026-08-17, a phantom 3 days that appeared in no
    // column. forecastStart/forecastFinish are still kept on the task, unchanged, for
    // anything that wants to show the forecast in its own right.
    t.effStart = t.actualStart || t.start || t.forecastStart || null;
    t.effFinish =
      t.actualFinish || t.finish || t.forecastFinish || derivedFinish || null;

    t.varianceDays = (t.effFinish && t.finish)
      ? calendarDaysBetween(t.finish, t.effFinish)
      : 0;
    t.startVarianceDays = (t.effStart && t.start)
      ? calendarDaysBetween(t.start, t.effStart)
      : 0;
  }

  if (!dataDate) {
    const acts = [...tasks.values()].map(t => t.actualFinish).filter(Boolean);
    if (acts.length) dataDate = new Date(Math.max(...acts.map(Number)));
  }

  const { criticalIds, cyclic } = computeCriticalPath(tasks, links);

  // The range has to span the forecast too, or a slipped task would finish past the
  // right-hand end of the slider and never be reachable.
  const dated = [...tasks.values()].filter(t => t.start && t.finish);
  const range = dated.length
    ? {
        min: new Date(Math.min(...dated.map(t => Math.min(+t.start, +(t.effStart || t.start))))),
        max: new Date(Math.max(...dated.map(t => Math.max(+t.finish, +(t.effFinish || t.finish))))),
      }
    : null;

  // Flattened display order: exactly the order the Gantt draws rows in.
  const rows = [];
  const pushRow = (id) => {
    const t = tasks.get(id);
    if (!t) return;
    rows.push(t);
    for (const c of t.children) pushRow(c);
  };
  const orderedRoots = [...tasks.values()].filter(t => t.parent == null).sort(compareWbs);
  for (const r of orderedRoots) pushRow(r.id);

  return {
    hasSchedule: true,
    tasks, links, rows, range, criticalIds, taskOfElement, linkedElements, cyclic,
    dataDate,
    roots: orderedRoots.map(t => t.id),
  };
}

/**
 * The traffic-light states. `delayed`/`onTime`/`ahead` are the three the 4D compare
 * view is built around; `inProgress` is the fourth state something under way with no
 * variance yet has to be in, and is deliberately blue so it can't be mistaken for
 * `ahead` yellow.
 */
export const TASK_STATUS = {
  delayed:    { key: "delayed",    label: "Delayed",     color: 0xe74c3c },
  onTime:     { key: "onTime",     label: "On time",     color: 0x0b7f3b },
  ahead:      { key: "ahead",      label: "Ahead",       color: 0xf1c40f },
  inProgress: { key: "inProgress", label: "In progress", color: 0x3498db },
};

export const STATUS_ORDER = ["delayed", "inProgress", "onTime", "ahead"];

/**
 * One task's traffic-light state at an instant, or null for "do not colour this".
 *
 * Two regimes, both anchored to a date actually reached by the playhead so nothing
 * paints the future:
 *
 *   STARTED (has actualStart) -- judged against what was RECORDED: actual start/
 *   finish vs baseline start/finish. A colour here is a claim about work that
 *   happened.
 *
 *   NOT STARTED (no actualStart yet) -- judged against what is EXPECTED: effStart/
 *   effFinish (the file's own current schedule, already pushed out by Synchro's
 *   rescheduling, or a forecast) vs baseline start/finish, via the same
 *   startVarianceDays/varianceDays the Gantt's Var column reads. A colour here is a
 *   claim about the PLAN, not about progress -- upcoming work already forecast late
 *   shows red before a single actual date exists.
 *
 * WHY THIS IS NOT THE OLD ALL-RED BUG. An earlier version of this judged un-started
 * tasks by comparing the playhead itself to the baseline finish -- once a baseline
 * finish had passed with no actual, the task went red, and combined with the
 * playhead defaulting to the END of the schedule that made every incomplete task
 * simultaneously "finished, and late" (34/34 red on a job where only 7 had any
 * actuals at all). The gate here is different: it never looks at the playhead
 * position relative to the baseline, only at whether the file's OWN expected dates
 * (effStart/effFinish) diverge from the baseline. A task with no forecast and an
 * unmoved schedule reads variance 0 -- onTime -- no matter how far the playhead has
 * run past its baseline finish; only a real forecast/reschedule turns it red or
 * yellow. `baselineMatched === false` is refused outright: those tasks kept the
 * CURRENT file's own dates as "start"/"finish" (see withBaseline's header), so
 * `start`/`finish` there is not a real baseline and comparing against it would be
 * comparing a schedule against itself.
 *
 * `includeUpcoming` (default true) gates the NOT STARTED branch only -- callers wire
 * it to their own "Upcoming activities" checkbox so it can be switched off without
 * touching how started/finished work is judged.
 */
export function taskStatusAt(task, date, includeUpcoming = true) {
  const d = +date;
  const as = +(task.actualStart || 0);

  if (as && d >= as) {
    // Started, and either never finished or not yet finished at this date.
    const af = +(task.actualFinish || 0);
    if (!af || d < af) return "inProgress";

    // Finished: judged on FINISH variance ONLY -- a late start with an on-time finish
    // (the crew caught up) is green, not red. `finish` becomes BL Finish when a
    // planned IFC is merged. Without it we cannot make an honest variance claim, so
    // retain the true element colour. Start is deliberately not consulted here: it
    // only ever drives the inProgress branch above. 2026-08-11, explicit user decision.
    const bf = +(task.finish || 0);
    if (!bf) return null;

    // Deliberately an EXACT timestamp comparison, not calendar-day rounding. A real
    // clock-time difference is a real signal here -- e.g. Synchro recording an actual
    // finish at midnight against a baseline finish at 5pm the same day genuinely means
    // the work wrapped up earlier in the day, and the user wants that to keep counting
    // as "ahead" rather than being rounded away to "onTime".
    if (af > bf) return "delayed";
    if (af === bf) return "onTime";
    return "ahead";
  }

  // NOT STARTED. Gate on the file's own expected start, exactly the "reached" test
  // the 3D build-up already uses elsewhere -- a task not yet due to begin stays
  // uncoloured, not red-by-default. The gate itself still checks START (has this
  // task's own expected start been reached by the playhead) -- that is a "has this
  // become relevant yet" test, distinct from the finish-only variance judged below.
  if (!includeUpcoming) return null;
  if (task.baselineMatched === false) return null;
  const es = +(task.effStart || task.start || 0);
  if (!es || d < es) return null;
  const bf = +(task.finish || 0);
  if (!bf) return null;

  // Forecast/plan variance, FINISH only -- see the finished branch above for why.
  if (task.varianceDays > 0) return "delayed";
  if (task.varianceDays < 0) return "ahead";
  return "onTime";
}

/**
 * Merges a BASELINE schedule, read from a separate earlier IFC export, into the current
 * one — and this is the only way to get real planned-vs-actual out of Synchro IFC2X3.
 *
 * WHY A SECOND FILE IS NEEDED. Measured on this project 2026-08-01: in
 * synchro_plannedvsactual.ifc, ActualStart equals ScheduleStart on ALL 45 tasks and
 * ActualFinish equals ScheduleFinish on ALL 45. There is exactly one
 * IfcScheduleTimeControl per task, one IfcWorkSchedule, and no property sets on tasks.
 * The file simply does not contain a baseline, because IFC2X3's IfcScheduleTimeControl
 * has only ONE set of Schedule* fields — the schema has nowhere to put one. When
 * progress was recorded in Synchro it overwrote the planned dates with the actuals.
 * Diffing the 27 Jul export against the 31 Jul one recovers the real slippage: 7
 * completed activities moved, up to +14 days on Mobilization, and nothing else changed.
 *
 * So: `current` supplies what actually happened (its Schedule, Actual and EarlyStart
 * fields), and `baseline` supplies what was planned. Tasks are matched on activity code
 * (IfcTask.TaskId, e.g. "A1050"), falling back to the WBS number and then the name.
 *
 * The result keeps this module's existing contract exactly — `start`/`finish` are the
 * baseline, `effStart`/`effFinish` are the best-known truth — so taskStatusAt and the
 * traffic lights need no changes at all.
 */
export function withBaseline(current, baseline) {
  if (!current?.hasSchedule || !baseline?.hasSchedule) return current;

  const byCode = new Map(), byWbs = new Map(), byName = new Map();
  for (const t of baseline.tasks.values()) {
    if (!t.start || !t.finish) continue;
    if (t.code && !byCode.has(t.code)) byCode.set(t.code, t);
    if (t.wbs && !byWbs.has(t.wbs)) byWbs.set(t.wbs, t);
    if (t.name && !byName.has(t.name)) byName.set(t.name, t);
  }

  // QUALITY CHECK ON THE BASELINE FILE. A baseline must be a PLAN-ONLY export, taken
  // before progress was recorded. If it carries actuals then Synchro has already
  // overwritten its planned dates in place -- the same overwrite that makes a baseline
  // necessary in the first place -- so its "plan" is partly actuals and every variance
  // it produces is understated. Reported rather than rejected: a partly-progressed
  // baseline is still better than none, but the user has to be told.
  const baselineActuals = [...baseline.tasks.values()]
    .filter(t => !t.isSummary && (t.actualStart || t.actualFinish)).length;

  const tasks = new Map();
  let matched = 0, moved = 0;
  for (const [id, t] of current.tasks) {
    const b = (t.code && byCode.get(t.code))
           || (t.wbs && byWbs.get(t.wbs))
           || (t.name && byName.get(t.name));
    if (!b) { tasks.set(id, { ...t, baselineMatched: false }); continue; }
    matched++;

    const clone = { ...t, baselineMatched: true, start: b.start, finish: b.finish };
    clone.varianceDays = clone.effFinish ? calendarDaysBetween(b.finish, clone.effFinish) : 0;
    clone.startVarianceDays = clone.effStart ? calendarDaysBetween(b.start, clone.effStart) : 0;
    if (clone.varianceDays !== 0 || clone.startVarianceDays !== 0) moved++;
    tasks.set(id, clone);
  }

  // NOTHING MATCHED -> NOT A BASELINE FOR THIS MODEL. Without this the function would
  // still return hasBaseline:true, the Gantt would relabel its columns "BL Start"/"BL
  // Finish", and every unmatched task keeps its own dates -- so an unrelated project's
  // IFC would silently present the model's own schedule as a baseline, with Var reading
  // 0 everywhere. Refusing the merge makes a wrong file obvious instead of plausible.
  if (matched === 0) {
    return { ...current, hasBaseline: false, baselineMatched: 0,
             baselineTotal: baseline.tasks.size, baselineRejected: "no tasks matched" };
  }

  // The span has to cover the baseline AND the actuals, or a slipped task finishes past
  // the end of the timeline and can never be scrubbed to.
  const dated = [...tasks.values()].filter(t => t.start && t.finish);
  const range = dated.length
    ? {
        min: new Date(Math.min(...dated.map(t => Math.min(+t.start, +(t.effStart || t.start))))),
        max: new Date(Math.max(...dated.map(t => Math.max(+t.finish, +(t.effFinish || t.finish))))),
      }
    : current.range;

  return {
    ...current, tasks, range,
    // `rows` MUST be rebuilt, not inherited. readSchedule fills it with references to
    // the task objects, so a caller that spreads `...current` keeps rows pointing at
    // the ORIGINALS while `tasks` holds the clones -- and anything rendering from rows
    // (the Gantt does) silently shows the pre-merge dates while the 3D shows the merged
    // ones. Measured: the Gantt listed A1000 as 2026-06-11 when the baseline said
    // 2026-06-10, even though the traffic lights were correctly reporting 8 delayed.
    rows: current.rows.map(t => tasks.get(t.id) || t),
    hasBaseline: true,
    baselineMatched: matched,
    baselineTotal: baseline.tasks.size,
    baselineMoved: moved,
    baselineActuals,          // > 0 means the baseline file was not a clean plan-only export
  };
}

/**
 * Merges a Primavera P6 XML export into an IFC schedule, and this is the BEST source of
 * planned-vs-actual for this project — better than withBaseline's two-IFC diff, because
 * one file carries both sides authoritatively instead of inferring the baseline from an
 * older export.
 *
 * What comes from where:
 *   `start` / `finish`               <- P6 PlannedStart/PlannedFinish. THE BASELINE.
 *   `actualStart` / `actualFinish`   <- P6 ActualStart/ActualFinish.
 *   `forecastStart` / `forecastFinish` <- P6 RemainingEarlyStart/Finish.
 * The IFC keeps supplying the WBS tree, the element assignments, the logic links and the
 * critical path. Only dates are replaced, so nothing about the 3D side changes.
 *
 * Joined on activity code (IfcTask.TaskId == P6 Activity Id, e.g. "A1050"), falling back
 * to the task name. Measured on this project: 34 of 34 codes match exactly.
 *
 * Unlike withBaseline, this does NOT have to derive a forecast finish — P6 writes
 * RemainingEarlyFinishDate, so the inclusive-duration workaround in readSchedule is not
 * needed and cannot introduce a phantom slip here.
 *
 * SUMMARY ROLLUP is mandatory, unlike in withBaseline. Summary rows carry no activity code
 * so they never match, and their IFC dates come from whatever the current export says --
 * which for plannedvsactual.ifc is 42 days off its own children after that file's bulk
 * reschedule. Left alone, every summary bar in the Gantt would be visibly detached from
 * the activities underneath it. So summaries are recomputed from their children bottom-up.
 */
export function withP6Progress(current, p6) {
  if (!current?.hasSchedule || !p6?.hasP6 || !p6.activities?.size) return current;

  const byCode = p6.activities;
  const byName = new Map();
  for (const a of byCode.values()) {
    if (a.name && !byName.has(a.name)) byName.set(a.name, a);
  }

  const tasks = new Map();
  let matched = 0, moved = 0;
  for (const [id, t] of current.tasks) {
    const a = (t.code && byCode.get(t.code)) || (t.name && byName.get(t.name));
    // A summary has no code of its own; leave it for the rollup pass below.
    if (!a) { tasks.set(id, { ...t, baselineMatched: false }); continue; }
    matched++;

    const clone = { ...t, baselineMatched: true };
    if (a.planStart) clone.start = a.planStart;
    if (a.planFinish) clone.finish = a.planFinish;
    clone.actualStart = a.actualStart;
    clone.actualFinish = a.actualFinish;
    clone.forecastStart = a.forecastStart;
    clone.forecastFinish = a.forecastFinish;
    if (a.completion != null) clone.completion = a.completion;

    clone.effStart = clone.actualStart || clone.forecastStart || clone.start || null;
    clone.effFinish = clone.actualFinish || clone.forecastFinish || clone.finish || null;
    clone.varianceDays = (clone.effFinish && clone.finish)
      ? calendarDaysBetween(clone.finish, clone.effFinish) : 0;
    clone.startVarianceDays = (clone.effStart && clone.start)
      ? calendarDaysBetween(clone.start, clone.effStart) : 0;
    if (clone.varianceDays !== 0 || clone.startVarianceDays !== 0) moved++;
    tasks.set(id, clone);
  }

  // --- summary rollup, bottom-up ---
  // Depth-descending so every child is final before its parent is computed. `seen` guards
  // against a malformed tree pointing a task at itself as an ancestor.
  const order = [...tasks.values()].sort((a, b) => b.depth - a.depth);
  for (const t of order) {
    if (!t.children?.length) continue;
    const kids = t.children.map(c => tasks.get(c)).filter(Boolean);
    const pick = (key, fn) => {
      const vals = kids.map(k => k[key]).filter(Boolean).map(Number);
      return vals.length ? new Date(fn(...vals)) : null;
    };
    const start = pick("start", Math.min), finish = pick("finish", Math.max);
    const effStart = pick("effStart", Math.min), effFinish = pick("effFinish", Math.max);
    if (!start && !finish) continue;             // nothing dated below: leave it as-is
    const clone = { ...t, start: start || t.start, finish: finish || t.finish };
    clone.effStart = effStart || clone.start;
    clone.effFinish = effFinish || clone.finish;
    clone.varianceDays = (clone.effFinish && clone.finish)
      ? calendarDaysBetween(clone.finish, clone.effFinish) : 0;
    clone.startVarianceDays = (clone.effStart && clone.start)
      ? calendarDaysBetween(clone.start, clone.effStart) : 0;
    // A summary's completion is the mean of its children's, matching readSchedule.
    const pcts = kids.map(k => k.completion).filter(v => v != null);
    if (pcts.length) clone.completion = Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length);
    tasks.set(t.id, clone);
  }

  const dated = [...tasks.values()].filter(t => t.start && t.finish);
  const range = dated.length
    ? {
        min: new Date(Math.min(...dated.map(t => Math.min(+t.start, +(t.effStart || t.start))))),
        max: new Date(Math.max(...dated.map(t => Math.max(+t.finish, +(t.effFinish || t.finish))))),
      }
    : current.range;

  return {
    ...current, tasks, range,
    // Rebuilt, never inherited -- see the note in withBaseline. `rows` holds references to
    // the pre-merge task objects, so inheriting it makes the Gantt render old dates while
    // the 3D renders new ones.
    rows: current.rows.map(t => tasks.get(t.id) || t),
    // P6's data date is the real "as of" line; it beats the one guessed from actuals.
    dataDate: p6.dataDate || current.dataDate,
    hasBaseline: true,
    baselineSource: "p6",
    baselineMatched: matched,
    baselineTotal: byCode.size,
    baselineMoved: moved,
  };
}

// A fixed, repeating drift pattern in WORKING days, used only by withDemoVariance.
// Deliberately not Math.random: the same file must always produce the same picture,
// or "did my change actually work?" becomes unanswerable. Mixed signs so that all
// four traffic-light states appear somewhere in the run.
const DEMO_DRIFT = [0, 6, -3, 0, 12, 0, -5, 3, 9, 0, -2, 4, 0, 15, -4];

/**
 * A copy of the schedule with synthetic slippage applied to every leaf task's
 * EFFECTIVE dates only. The baseline is untouched, so the "Planned" view stays honest
 * and only the comparison changes.
 *
 * This exists because the sample export records almost no variance -- 7 activities
 * complete, each on exactly its planned date -- so an honest render of it is entirely
 * green and gives no way to tell a working traffic light from a broken one. Anything
 * driven by this must be labelled as synthetic in the UI.
 */
export function withDemoVariance(schedule) {
  if (!schedule?.hasSchedule) return schedule;
  const leaves = [...schedule.tasks.values()]
    .filter(t => !t.isSummary)
    .sort((a, b) => (+a.start || 0) - (+b.start || 0));

  const tasks = new Map(schedule.tasks);
  leaves.forEach((t, i) => {
    const drift = DEMO_DRIFT[i % DEMO_DRIFT.length];
    const clone = { ...t, synthetic: drift !== 0 };
    if (t.effStart) clone.effStart = addWorkdays(t.effStart, drift);
    if (t.effFinish) clone.effFinish = addWorkdays(t.effFinish, drift);
    if (clone.effStart && clone.effFinish && +clone.effFinish < +clone.effStart) {
      clone.effFinish = clone.effStart;
    }
    clone.varianceDays = (clone.effFinish && t.finish)
      ? calendarDaysBetween(t.finish, clone.effFinish) : 0;
    clone.startVarianceDays = (clone.effStart && t.start)
      ? calendarDaysBetween(t.start, clone.effStart) : 0;
    tasks.set(t.id, clone);
  });
  // rows must be rebuilt alongside tasks -- see the note in withBaseline. Harmless here
  // today only because nothing renders the demo schedule through rows; fixed so it does
  // not become a bug the moment something does.
  return { ...schedule, tasks, rows: schedule.rows.map(t => tasks.get(t.id) || t) };
}

/**
 * Buckets every scheduled element into a traffic-light state at `date`.
 *
 * Summary tasks are skipped: their elements are the union of their children's, so
 * including them would classify each element twice, with the parent's coarser dates
 * winning. Leaves are the only real source of truth.
 *
 * Returns { byStatus: {status: ids[]}, taskCounts: {status: n} }.
 */
export function elementStatusAt(schedule, date, statusFn = taskStatusAt) {
  const byStatus = { delayed: [], onTime: [], ahead: [], inProgress: [] };
  const taskCounts = { delayed: 0, onTime: 0, ahead: 0, inProgress: 0 };
  if (!schedule?.hasSchedule) return { byStatus, taskCounts };

  for (const task of schedule.tasks.values()) {
    if (task.isSummary) continue;
    const st = statusFn(task, date);
    if (!st || !byStatus[st]) continue;
    taskCounts[st]++;
    if (task.elementIds.length) byStatus[st].push(...task.elementIds);
  }
  return { byStatus, taskCounts };
}

/**
 * Which elements are finished, and which are being worked on, at a given instant.
 * Runs on the effective dates (actual, else forecast, else baseline), so a schedule
 * with no progress recorded still simulates off its plan.
 */
export function elementStateAt(schedule, date) {
  const built = [];
  const active = [];
  if (!schedule?.hasSchedule) return { built, active };
  const t = +date;

  for (const task of schedule.tasks.values()) {
    if (task.isSummary || task.elementIds.length === 0) continue;
    const start = +(task.effStart || task.start || 0);
    const finish = +(task.effFinish || task.finish || 0);
    if (!start || !finish) continue;
    if (t >= finish) built.push(...task.elementIds);
    else if (t >= start) active.push(...task.elementIds);
  }
  return { built, active };
}

/** 0..1 through a task's own duration at `date`. Drives the progress fill on a bar. */
export function taskProgressAt(task, date) {
  const start = +(task.start || 0);
  const finish = +(task.finish || 0);
  if (!start || !finish) return 0;
  if (date >= finish) return 1;
  if (date <= start) return 0;
  return (date - start) / (finish - start);
}
