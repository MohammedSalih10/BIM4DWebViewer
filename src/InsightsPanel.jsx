// The right-hand analytics dock for 4D Simulation -- project/element stats, progress
// by category and a Planned-vs-Actual S-curve, in the spirit of the Aarvee "4D BIM
// Twin" mockup's data panel. Everything here reads the SAME schedule/contents data
// SimpleViewer already computed; nothing is invented or simulated for show -- with no
// baseline loaded the S-curve is a single "Planned" line and the panel says so, rather
// than drawing a fake "Actual" line with nothing behind it.
import React, { useMemo, useState } from "react";
import { calendarDaysBetween } from "./ifcSchedule";

const MIN_W = 220;
const MAX_W = 520;
const DEFAULT_W = 288;

// "12.3 MB" etc -- matching the Contents panel's own byte formatting so the two
// panels read consistently.
function fmtBytes(bytes) {
  if (bytes == null) return "";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// Whole calendar days, signed -- "+6d" late, "-3d" early. Mirrors the Gantt's own
// varianceText helper so the two panels never disagree on how a variance reads.
function fmtVariance(days) {
  if (days == null || days === 0) return "0d";
  return days > 0 ? `+${days}d` : `${days}d`;
}

function varianceColor(days) {
  if (days > 0) return "var(--status-delayed)";
  if (days < 0) return "var(--status-ontime)";
  return "var(--ink-700)";
}

// DD-MM-YYYY, matching SimpleViewer's own fmtSimDate.
function fmtDate(d) {
  if (!d) return "—";
  const dt = new Date(d);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(dt.getUTCDate())}-${p(dt.getUTCMonth() + 1)}-${dt.getUTCFullYear()}`;
}

/**
 * What fraction of `ids` this instant has "reached", using the exact same rule the
 * 3D build-up uses: an element with no task at all is context (always counted as
 * built), one with a task counts once that task's best-known finish (actual, else
 * forecast, else baseline) is at or before `date`. Returns null with no schedule, so
 * the caller can tell "0%" apart from "not applicable".
 */
function pctReached(ids, schedule, date) {
  if (!schedule?.hasSchedule || !ids.length) return null;
  const t = +date;
  const scheduled = schedule.taskOfElement;
  let done = 0;
  for (const id of ids) {
    const taskId = scheduled.get(id);
    if (taskId == null) { done++; continue; }               // unscheduled -> context
    const task = schedule.tasks.get(taskId);
    const fin = +(task?.effFinish || task?.finish || 0);
    if (fin && t >= fin) done++;
  }
  return Math.round((done / ids.length) * 100);
}

// Samples the schedule across its own date range into two cumulative curves: the
// PLANNED one (% of leaf tasks whose baseline finish falls at or before each sample
// point -- always fully known) and the ACTUAL one (% whose effective finish does --
// only meaningful up to `now`, so it stops there instead of guessing the future).
// Points beyond `now` on the actual curve are `null` so the SVG path breaks there
// rather than drawing a lie.
const SAMPLES = 48;
function buildSCurve(schedule, currentDate) {
  if (!schedule?.hasSchedule || !schedule.range) return null;
  const leaves = [...schedule.tasks.values()].filter(t => !t.isSummary && t.finish);
  if (!leaves.length) return null;

  const min = +schedule.range.min, max = +schedule.range.max;
  const span = max - min || 1;
  const now = Math.min(Math.max(+currentDate, min), max);

  const planned = [], actual = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const t = min + (span * i) / SAMPLES;
    let p = 0, a = 0;
    for (const task of leaves) {
      if (+task.finish <= t) p++;
      if (t <= now) {
        const eff = +(task.effFinish || task.finish);
        if (eff <= t) a++;
      }
    }
    planned.push(p / leaves.length);
    actual.push(t <= now ? a / leaves.length : null);
  }
  return { planned, actual, min, max, now, taskCount: leaves.length };
}

// Turns a sampled series (with possible `null` gaps) into an SVG path, mapped into a
// 260x84 box with 6px of headroom at the top -- the same box the mockup's own
// S-curve used, so a viewBox of "0 0 260 84" keeps every coordinate below relating
// simple and self-checkable.
function seriesToPath(series) {
  let d = "", open = false;
  series.forEach((v, i) => {
    if (v == null) { open = false; return; }
    const x = (i / SAMPLES) * 260;
    const y = 82 - v * 76;
    d += (!open ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1);
    open = true;
  });
  return d || "M0 82";
}

export default function InsightsPanel({
  schedule, currentDate, contents, statusCounts, statusColors, selectedTaskId, onClose,
}) {
  const curve = useMemo(() => buildSCurve(schedule, currentDate), [schedule, currentDate]);

  // Drag-to-resize on the panel's left edge (the boundary with the 3D/Gantt view).
  // Mirrors the Gantt's own task-table/chart divider (a window-level mousemove/mouseup
  // pair rather than anything on the handle itself) -- since this panel sits on the
  // RIGHT of the screen, dragging left (decreasing clientX) is what widens it.
  const [width, setWidth] = useState(DEFAULT_W);
  const [resizing, setResizing] = useState(false);
  const onResizeMouseDown = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    setResizing(true);
    const move = (ev) => {
      const next = Math.max(MIN_W, Math.min(MAX_W, startW - (ev.clientX - startX)));
      setWidth(next);
    };
    const up = () => {
      setResizing(false);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // statusCounts.builtUnique (not the per-status sum) because an element Synchro
  // assigned to more than one leaf activity lands in two status buckets -- summing
  // those double-counts it and can push this over 100%. builtUnique comes from a
  // Set, so it's already deduped. Math.min is a last-resort clamp in case some
  // other data oddity still slips one through.
  const builtEls = statusCounts
    ? statusCounts.natural + statusCounts.builtUnique
    : null;
  const pctBuilt = builtEls != null && contents?.total
    ? Math.min(100, Math.round((builtEls / contents.total) * 100))
    : null;

  // Whole-project finish variance: the project finishes when its LAST leaf activity
  // finishes, so this compares the latest baseline finish against the latest
  // effective (actual/forecast) finish across every leaf task -- not a single
  // "worst" activity, which read like a blame metric and didn't answer "is the
  // project as a whole ahead or behind?". Negative = ahead of baseline (good);
  // positive = behind baseline (bad) -- same sign convention as every other
  // variance readout in this app.
  const finishVariance = useMemo(() => {
    if (!schedule?.hasSchedule || !schedule.hasBaseline) return null;
    let baselineFinish = null, effFinish = null;
    for (const t of schedule.tasks.values()) {
      if (t.isSummary) continue;
      if (t.finish && (!baselineFinish || +t.finish > +baselineFinish)) baselineFinish = t.finish;
      if (t.effFinish && (!effFinish || +t.effFinish > +effFinish)) effFinish = t.effFinish;
    }
    if (!baselineFinish || !effFinish) return null;
    return calendarDaysBetween(baselineFinish, effFinish);
  }, [schedule]);

  const selectedTask = selectedTaskId != null ? schedule?.tasks?.get(selectedTaskId) : null;

  // Top-level categories only -- a full tree of bars here would fight the Contents
  // panel on the other side of the screen for the same information at more depth.
  // Memoized: this panel re-renders every playback tick (currentDate changes), and
  // without memoizing, every category's full element-id scan (`pctReached`) ran again
  // every single tick even on ticks where none of the percentages actually moved.
  const categoryBars = useMemo(() => (contents?.categoryTree || []).map(node => ({
    key: node.key, label: node.label, count: node.count,
    pct: pctReached(node.ids, schedule, currentDate),
  })), [contents, schedule, currentDate]);

  return (
    <aside style={{
      width, flexShrink: 0, display: "flex", flexDirection: "column", position: "relative",
      background: "var(--paper)", borderLeft: "1px solid var(--line-strong)", minHeight: 0,
    }}>
      {/* Drag handle on the panel's left boundary. Straddles the border (-3..+3)
          so it's easy to grab without needing pixel-perfect aim. */}
      <div
        onMouseDown={onResizeMouseDown}
        title="Drag to resize the insights panel"
        style={{
          position: "absolute", left: -3, top: 0, bottom: 0, width: 6,
          cursor: "col-resize", zIndex: 2,
          background: resizing ? "rgba(63,110,140,.5)" : "transparent",
        }}
      />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "10px 12px", borderBottom: "1px solid var(--line-soft)" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.08em",
                        textTransform: "uppercase", color: "var(--ink-700)" }}>
            {selectedTask ? "Task insights" : "Project insights"}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--ink-400)", overflow: "hidden",
                        textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {selectedTask ? (selectedTask.code || selectedTask.name) : "Planned vs actual"}
          </div>
        </div>
        <button onClick={onClose} title="Close"
                style={{ fontFamily: "inherit", fontSize: 13, background: "transparent", border: 0,
                         color: "var(--ink-400)", cursor: "pointer", padding: "2px 4px", flexShrink: 0 }}>
          ✕
        </button>
      </div>

      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>

        {/* --- stat cards ------------------------------------------------------- */}
        <div style={{ padding: "12px 12px 14px", borderBottom: "1px solid var(--line-soft)" }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.09em",
                        textTransform: "uppercase", color: "var(--ink-400)", marginBottom: 9 }}>
            {selectedTask ? "Task metrics" : "Project metrics"}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {(selectedTask
              ? [
                  { value: selectedTask.completion ?? "—", unit: "%", label: "Complete" },
                  { value: fmtVariance(selectedTask.varianceDays), unit: "", label: "Finish variance",
                    color: varianceColor(selectedTask.varianceDays) },
                  { value: selectedTask.critical ? "Yes" : "No", unit: "", label: "Critical path" },
                  { value: selectedTask.elementIds.length, unit: "el", label: "Elements built" },
                ]
              : [
                  { value: pctBuilt ?? "—", unit: "%", label: "Model built" },
                  { value: schedule?.tasks?.size ?? "—", unit: "tasks", label: "Scheduled activities" },
                  { value: schedule?.criticalIds?.size ?? "—", unit: "", label: "On critical path" },
                  finishVariance == null
                    ? { value: "—", unit: "", label: "No baseline loaded" }
                    : { value: fmtVariance(finishVariance), unit: "", label: "Finish variance",
                        color: varianceColor(finishVariance) },
                ]
            ).map((s, i) => (
              <div key={i} style={{ background: "var(--paper-2)", border: "1px solid var(--line-soft)",
                                     padding: "10px 10px 8px" }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                  <span style={{ fontSize: 17, fontWeight: 700, lineHeight: 1,
                                 color: s.color || "var(--ink-700)" }}>
                    {s.value}
                  </span>
                  {s.unit && (
                    <span style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: "0.04em",
                                   color: "var(--aar-blue)" }}>
                      {s.unit}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: "var(--ink-400)", marginTop: 4 }}>{s.label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* --- progress by category -------------------------------------------- */}
        {categoryBars.length > 0 && (
          <div style={{ padding: "12px 12px 14px", borderBottom: "1px solid var(--line-soft)" }}>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.09em",
                          textTransform: "uppercase", color: "var(--ink-400)", marginBottom: 10 }}>
              Progress by category
            </div>
            {categoryBars.map(b => (
              <div key={b.key} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
                <span style={{ width: 92, flexShrink: 0, fontSize: 11.5, color: "var(--ink-600)",
                               overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      title={b.label}>
                  {b.label}
                </span>
                <span style={{ flex: 1, height: 5, background: "var(--line-soft)", position: "relative",
                               overflow: "hidden" }}>
                  <span style={{
                    position: "absolute", left: 0, top: 0, bottom: 0,
                    width: (b.pct ?? 0) + "%", background: "var(--aar-blue)",
                    transition: "width 200ms ease-out",
                  }} />
                </span>
                <span style={{ width: 32, textAlign: "right", fontFamily: "var(--font-mono)",
                               fontSize: 11, color: "var(--ink-400)" }}>
                  {b.pct == null ? "—" : `${b.pct}%`}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* --- planned vs actual S-curve ---------------------------------------- */}
        <div style={{ padding: "12px 12px 14px", borderBottom: "1px solid var(--line-soft)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                        marginBottom: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.09em",
                          textTransform: "uppercase", color: "var(--ink-400)" }}>
              Progress S-curve
            </span>
            <span style={{ fontSize: 11, color: "var(--ink-400)" }}>
              {schedule?.hasBaseline ? "Baseline vs actual" : "Baseline only"}
            </span>
          </div>
          {curve ? (
            <>
              <svg viewBox="0 0 260 84" style={{ width: "100%", height: 84, display: "block" }}>
                <line x1="0" y1="83" x2="260" y2="83" stroke="var(--line-strong)" strokeWidth="1" />
                <line x1="0" y1="45" x2="260" y2="45" stroke="var(--line-soft)" strokeWidth="1" />
                <path d={seriesToPath(curve.planned)} fill="none" stroke="var(--ink-300)"
                      strokeWidth="1.5" strokeDasharray="3 3" />
                {schedule?.hasBaseline && (
                  <path d={seriesToPath(curve.actual) + " L" +
                           ((curve.now - curve.min) / (curve.max - curve.min) * 260).toFixed(1) +
                           " 82 L0 82 Z"}
                        fill="rgba(63,110,140,.12)" stroke="none" />
                )}
                {schedule?.hasBaseline && (
                  <path d={seriesToPath(curve.actual)} fill="none" stroke="var(--aar-blue)" strokeWidth="2" />
                )}
                <line x1={((curve.now - curve.min) / (curve.max - curve.min) * 260).toFixed(1)} y1="0"
                      x2={((curve.now - curve.min) / (curve.max - curve.min) * 260).toFixed(1)} y2="83"
                      stroke="var(--status-delayed)" strokeWidth="1.5" />
              </svg>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 6, fontSize: 11,
                            color: "var(--ink-400)" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ width: 12, height: 0, borderTop: "1.5px dashed var(--ink-300)",
                                 display: "inline-block" }} />
                  Planned
                </span>
                {schedule?.hasBaseline && (
                  <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <span style={{ width: 12, height: 2, background: "var(--aar-blue)",
                                   display: "inline-block" }} />
                    Actual
                  </span>
                )}
                <span>{curve.taskCount} tasks</span>
              </div>
            </>
          ) : (
            <div style={{ fontSize: 11, color: "var(--ink-400)", padding: "8px 0" }}>
              No schedule to plot yet.
            </div>
          )}
        </div>

        {/* --- attributes -------------------------------------------------------- */}
        <div style={{ padding: "12px 12px 16px" }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.09em",
                        textTransform: "uppercase", color: "var(--ink-400)", marginBottom: 9 }}>
            {selectedTask ? "Task attributes" : "Schedule attributes"}
          </div>
          {(selectedTask
            ? [
                ["Activity", selectedTask.code || "—"],
                ["WBS", selectedTask.wbs || "—"],
                ["BL start", fmtDate(selectedTask.start)],
                ["BL finish", fmtDate(selectedTask.finish)],
                ["Actual/forecast finish", fmtDate(selectedTask.effFinish),
                  varianceColor(selectedTask.varianceDays)],
                ["Elements built", `${selectedTask.elementIds.length}`],
              ]
            : [
                ["Data date", fmtDate(schedule?.dataDate)],
                ["Schedule range", schedule?.range
                  ? `${fmtDate(schedule.range.min)} → ${fmtDate(schedule.range.max)}`
                  : "—"],
                ["Baseline source", schedule?.hasBaseline
                  ? (schedule.baselineSource === "p6" ? "Primavera P6 export" : "Two-IFC diff")
                  : "None loaded"],
                ["Tasks matched to baseline", schedule?.hasBaseline
                  ? `${schedule.baselineMatched} of ${schedule.baselineTotal}` : "—"],
                ["Logic links", `${schedule?.links?.length ?? 0}`],
                ["Simulation date", fmtDate(currentDate)],
              ]
          ).map(([k, v, color]) => (
            <div key={k} style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between",
                                   gap: 10, padding: "5px 0", borderBottom: "1px solid var(--paper-cool)" }}>
              <span style={{ fontSize: 11.5, color: "var(--ink-400)", whiteSpace: "nowrap" }}>{k}</span>
              <span style={{ fontSize: 11, fontWeight: 500, color: color || "var(--ink-700)",
                             textAlign: "right", overflow: "hidden", textOverflow: "ellipsis",
                             whiteSpace: "nowrap" }}>
                {v}
              </span>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
