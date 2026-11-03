import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { taskProgressAt } from "./ifcSchedule";

// Natural sort for activity codes ("A2" before "A10"): split into a leading
// letter run and a trailing number run and compare each separately, rather than
// plain string comparison, which would put "A10" before "A2".
function compareCode(a, b) {
  const ca = a.code || "", cb = b.code || "";
  const ma = ca.match(/^(\D*)(\d*)/) || ["", "", ""];
  const mb = cb.match(/^(\D*)(\d*)/) || ["", "", ""];
  if (ma[1] !== mb[1]) return ma[1] < mb[1] ? -1 : 1;
  const na = parseInt(ma[2] || "", 10), nb = parseInt(mb[2] || "", 10);
  if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
  return ca.localeCompare(cb);
}

const DAY = 86400000;
const ROW_H = 24;
// Width of the fixed task table with FOUR date columns: Start, Finish, Actual Start,
// Actual Finish. The BL pair is added only when a baseline is loaded -- see `leftW` in
// the component. Without one, BL Start/Finish would be a verbatim copy of Start/Finish,
// since both would read the same fields off the same file.
const LEFT_W_BASE = 700;
const HEADER_H = 36;
// At Day zoom the header splits into two bands: a month heading on top of the
// weekday cells below, since "Mon"/"Tue" alone carries no month context. Carved out
// of HEADER_H rather than added on top, so nothing downstream that positions off
// HEADER_H (rows, playhead, scroll-into-view) needs to know the zoom level.
const MONTH_ROW_H = 16;
// Wide enough for the longest header, "Actual Finish", at the header font size below.
const DATE_W = 78;
const BAR_H = 13;
// The seek slider's floor when the playback row runs out of room -- see MIN_SLIDER_W's
// use on that row: Play and the date box hold their size, so the slider is what
// shrinks, but it still needs to stay draggable at whatever width is left.
const MIN_SLIDER_W = 60;

const COLORS = {
  critical: "var(--status-delayed)",
  normal: "var(--aar-blue)",
  summary: "var(--ink-700)",
  done: "var(--status-ontime)",
  float: "var(--line-strong)",
  arrow: "var(--ink-400)",
  arrowCrit: "#E8777A",
  playhead: "var(--status-delayed)",
};

function fmt(d) {
  if (!d) return "";
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${m}-${day}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Data cells run a size bigger than the header labels (dateHead, below) -- the header's
// width is set to fit "Actual Finish" exactly, but a DATE like "2027-01-27" is shorter
// than that at any reasonable size, so the data columns have the slack to read larger.
const dateCell = { width: DATE_W, color: "var(--ink-400)", fontFamily: "var(--font-mono)", fontSize: 11.5 };

// Explicit size + nowrap so the four full labels cannot wrap or clip whatever the
// surrounding font size happens to be.
const dateHead = { width: DATE_W, color: "var(--ink-500)", fontSize: 11, whiteSpace: "nowrap" };

/**
 * Actual-date cells. These are RECORDED FACTS ONLY -- an activity with no actual leaves
 * the cell empty rather than borrowing its scheduled date.
 *
 * This used to fall back to the effective date, so every future activity displayed a
 * scheduled date under a heading that says "Actual". A whole project then reads as
 * started, and "actual vs baseline" silently becomes "schedule vs baseline" on the rows
 * where nothing has happened. Where the work has not begun, the honest cell is blank.
 */
const actualStyle = { color: "var(--status-ontime)" };

const varianceText = (d) => (d == null || d === 0 ? "" : d > 0 ? `+${d}d` : `${d}d`);
const varianceColor = (d) => (d > 0 ? "var(--status-delayed)" : d < 0 ? "var(--status-ontime)" : "var(--ink-400)");

/**
 * Gantt chart for the bottom panel: WBS tree on the left, time-scaled bars on the
 * right, dependency arrows between them, the critical path in red, and a playhead
 * that drives the 3D simulation.
 *
 * Layout note: this is ONE scroll container, not two synchronised ones. The task
 * table is `position: sticky; left: 0` and the header is `sticky; top: 0`, so a
 * single scrollbar moves both axes and the rows can never drift out of alignment
 * with their bars -- which is the usual bug in hand-rolled Gantt charts.
 */
/**
 * The playback speed ladder, in simulation days per frame.
 *
 * Days-per-frame is the only thing the user should be changing: the frame interval
 * itself is pinned by how long an IFC subset rebuild takes (see TICK_MS in
 * SimpleViewer). At that 120ms tick this ladder spans roughly 4 to 250 days per second,
 * i.e. the 273-day sample project takes anywhere from about 65 seconds down to 1.
 */
export const SPEED_STEPS = [0.5, 1, 2, 3, 5, 7, 14, 30];
const SPEED_LABELS = ["½ d/f", "1 d/f", "2 d/f", "3 d/f", "5 d/f", "1 wk/f", "2 wk/f", "1 mo/f"];
const TICK_MS = 120;   // must match SimpleViewer's; only used for the tooltip readout

/** Index of the ladder step nearest `speed`, so an off-ladder value still works. */
function speedIndex(speed) {
  let best = 0;
  for (let i = 1; i < SPEED_STEPS.length; i++) {
    if (Math.abs(SPEED_STEPS[i] - speed) < Math.abs(SPEED_STEPS[best] - speed)) best = i;
  }
  return best;
}

const stepSpeed = (speed, delta) =>
  SPEED_STEPS[Math.max(0, Math.min(SPEED_STEPS.length - 1, speedIndex(speed) + delta))];

const daysPerSecond = (speed) => speed * (1000 / TICK_MS);

const speedBtn = {
  fontFamily: "inherit", fontSize: 13, lineHeight: 1, width: 22, height: 22, padding: 0, cursor: "pointer",
  border: "1px solid var(--line-strong)", background: "var(--paper)", color: "var(--ink-700)",
};

// A checkbox rendered as a small filled/outline square, matching the theme's flag-chip
// convention used throughout the app (Dependencies / Critical only here).
const checkboxBox = (on) => ({
  width: 13, height: 13, display: "grid", placeItems: "center", fontSize: 10.5, lineHeight: 1,
  background: on ? "var(--aar-blue)" : "var(--paper)",
  border: "1px solid " + (on ? "var(--aar-blue)" : "var(--line-strong)"), color: "#fff",
});
const flagLabel = {
  display: "inline-flex", alignItems: "center", gap: 7, fontSize: 11.5, color: "var(--ink-600)",
  cursor: "pointer", whiteSpace: "nowrap",
};

/**
 * One row of the left-hand task table. Memoized with React.memo: nothing it shows
 * (code, name, the four/six date columns, variance, float) depends on `currentDate`,
 * only on the task itself, the current selection and the collapse state -- none of
 * which change on a playback tick. Without this, EVERY row in the table re-rendered
 * on every single tick (several times a second during playback) for no visible
 * reason. `selectRef` is a ref, not the raw callback: the parent viewer
 * (SimpleViewer/SplitCompareView) recreates its onSelectTask closure on every one of
 * its own renders, which would otherwise defeat this memoization every time --
 * same ref-indirection trick as `onPickRef` in Viewport3D.jsx.
 */
const TaskRow = React.memo(function TaskRow({
  t, sel, tableW, bl, hasKids, isCollapsed, striped, onToggleCollapse, selectRef,
}) {
  return (
    <div style={{ display: "flex", height: ROW_H, position: "relative" }}>
      <div
        onClick={() => selectRef.current(sel ? null : t.id)}
        title={`${t.name}${t.elementIds.length ? ` — ${t.elementIds.length} elements` : ""}`}
        style={{
          width: tableW, flexShrink: 0,
          display: "flex", alignItems: "center", gap: 6, padding: "0 6px",
          boxSizing: "border-box", cursor: "pointer",
          background: sel ? "var(--aar-blue-fog)" : (striped ? "var(--paper-2)" : "var(--paper)"),
          boxShadow: sel ? "inset 3px 0 0 var(--aar-blue)" : "none",
          borderRight: "1px solid var(--line-strong)",
          borderBottom: "1px solid var(--paper-cool)",
        }}
      >
        <span style={{ width: 52, fontSize: 12, color: "var(--ink-400)", overflow: "hidden",
                      flexShrink: 0 }}>
          {t.code}
        </span>
        <span style={{ flex: 1, display: "flex", alignItems: "center", gap: 4,
                       paddingLeft: t.depth * 12, overflow: "hidden" }}>
          <span
            onClick={e => {
              if (!hasKids) return;
              e.stopPropagation();
              onToggleCollapse(t.id);
            }}
            style={{ width: 9, flexShrink: 0, color: "var(--ink-400)" }}
          >
            {hasKids ? (isCollapsed ? "▸" : "▾") : ""}
          </span>
          <span style={{
            fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            fontWeight: t.isSummary ? 600 : 400,
            color: t.critical ? COLORS.critical : "var(--ink-700)",
          }}>
            {t.name}
          </span>
        </span>
        {/* Start / Finish -- the updated file's own schedule, links applied */}
        <span style={dateCell}>{fmt(t.curStart ?? t.start)}</span>
        <span style={dateCell}>{fmt(t.curFinish ?? t.finish)}</span>

        {/* BL Start / BL Finish -- only when a baseline is actually merged */}
        {bl && (
          <>
            <span style={{ ...dateCell, color: "var(--aar-blue-deep)" }}>{fmt(t.start)}</span>
            <span style={{ ...dateCell, color: "var(--aar-blue-deep)" }}>{fmt(t.finish)}</span>
          </>
        )}

        {/* Actual Start / Finish -- recorded facts only, blank otherwise */}
        <span style={{ ...dateCell, ...(t.actualStart ? actualStyle : null) }}>
          {t.actualStart ? fmt(t.actualStart) : ""}
        </span>
        <span style={{ ...dateCell, ...(t.actualFinish ? actualStyle : null) }}>
          {t.actualFinish ? fmt(t.actualFinish) : ""}
        </span>

        <span style={{ width: 44, textAlign: "right", fontSize: 11, fontWeight: 600,
                       color: varianceColor(t.varianceDays) }}>
          {varianceText(t.varianceDays)}
        </span>
        <span style={{ width: 34, textAlign: "right", fontSize: 11, color: "var(--ink-400)" }}>
          {t.isSummary || t.totalFloat == null ? "" : `${t.totalFloat}d`}
        </span>
      </div>
    </div>
  );
});

/**
 * One row of the right-hand timeline: the bar track, the bar (or summary chevron),
 * the progress fill and the remaining-float tick. Memoized for the same reason as
 * TaskRow -- `done` (the only prop that genuinely changes every tick) only differs
 * from the previous tick for whichever task is currently in progress, so every OTHER
 * row's memo short-circuits and skips re-rendering entirely.
 */
const BarRow = React.memo(function BarRow({
  t, sel, x, w, done, color, pxPerDay, width, striped, selectRef,
}) {
  return (
    <div style={{ display: "flex", height: ROW_H, position: "relative", zIndex: 2,
                 background: sel ? "var(--aar-blue-fog)" : "transparent" }}>
      {/* bar track. Not seekable -- only the toolbar slider above moves the
          playhead now, so a drag here can no longer be mistaken for (or
          interfere with) clicking a bar to select its task. */}
      <div
        style={{ position: "relative", width, flexShrink: 0,
                 borderBottom: "1px solid var(--paper-cool)",
                 background: striped ? "rgba(190,212,228,.32)" : "transparent" }}
      >
        {/* remaining float, so slack is visible next to the bar */}
        {!t.isSummary && t.totalFloat > 0 && (
          <div style={{
            position: "absolute", left: x + w, top: ROW_H / 2 - 1,
            width: t.totalFloat * (7 / 5) * pxPerDay, height: 2,
            background: COLORS.float,
          }} />
        )}

        {t.isSummary ? (
          <div style={{
            position: "absolute", left: x, width: w, top: ROW_H / 2 - 4,
            height: 8, background: color,
            clipPath: "polygon(0 0, 100% 0, 100% 100%, 96% 40%, 4% 40%, 0 100%)",
          }} />
        ) : (
          <div
            onClick={e => { e.stopPropagation(); selectRef.current(sel ? null : t.id); }}
            title={`${t.name} — ${fmt(t.start)} to ${fmt(t.finish)}` +
                   `${t.totalFloat != null ? `, float ${t.totalFloat}d` : ""}` +
                   `${t.critical ? " (critical)" : ""}`}
            style={{
              position: "absolute", left: x, width: w, top: (ROW_H - BAR_H) / 2,
              height: BAR_H, background: color,
              cursor: "pointer", overflow: "hidden", borderRadius: 2,
              outline: sel ? "2px solid var(--aar-blue)" : "none",
            }}
          >
            {/* Progress runs as a thinner inner bar, the way MS Project and
                P6 draw it, so a finished task still shows whether it was on
                the critical path instead of turning solid green. */}
            {done > 0 && (
              <div style={{
                position: "absolute", left: 0, top: (BAR_H - 7) / 2,
                width: `${done * 100}%`, height: 7,
                background: COLORS.done,
              }} />
            )}
          </div>
        )}
      </div>
    </div>
  );
});

export default function GanttChart({
  schedule, currentDate, onDateChange, selectedTaskId, onSelectTask,
  playing, onTogglePlay, speed, onSpeedChange,
}) {
  // `onSelectTask` is a fresh closure on every render of the parent viewer -- see the
  // note on TaskRow/BarRow above. Keeping the latest one in a ref lets those memoized
  // rows take a referentially-STABLE prop instead, so passing a new onSelectTask down
  // doesn't force every row to re-render.
  const selectRef = useRef(onSelectTask);
  useEffect(() => { selectRef.current = onSelectTask; }, [onSelectTask]);
  const scrollRef = useRef(null);      // right pane (timeline); drives vertical scroll
  const leftPaneRef = useRef(null);    // left pane (task table)
  const outerRef = useRef(null);       // wrapper around both panes + divider
  const [collapsed, setCollapsed] = useState({});
  // Stable across renders (useCallback, no deps) so it can be handed to the memoized
  // TaskRow below without defeating React.memo the way an inline arrow recreated
  // every render would.
  const toggleCollapse = useCallback((id) => setCollapsed(p => ({ ...p, [id]: !p[id] })), []);
  // null = the file's own hierarchical WBS order (the default). "asc"/"desc" keep the
  // tree exactly as-is -- same parents, same nesting, same indent -- and only reorder
  // SIBLINGS within each group by activity code, the way P6/Synchro sort columns work.
  // Toggled by clicking the "Code" column header, cycling asc -> desc -> back to WBS.
  const [codeSort, setCodeSort] = useState(null);
  const [pxPerDay, setPxPerDay] = useState(4);
  const [showArrows, setShowArrows] = useState(true);
  const [criticalOnly, setCriticalOnly] = useState(false);
  // "Fit" used to mean a fixed 1.5px/day -- close enough to fit most projects, but
  // just as often left dead space on the right (short project) or still needed
  // scrolling (long one), because it wasn't actually measuring anything. fitMode
  // instead drives pxPerDay itself: see the effect below that recomputes it from
  // the chart's real available width, so the whole timeline always fills exactly
  // the space there is, however wide that turns out to be.
  const [fitMode, setFitMode] = useState(false);
  const [containerW, setContainerW] = useState(0);

  // The "jump to date" box below mirrors `currentDate`, but a plain
  // `value={fmt(currentDate)}` fights the browser's own date widget: every keystroke
  // that completes a subfield (day/month/year) fires onChange, which used to clamp and
  // hand a *reformatted* string straight back into `value`. React then writes that
  // string to the input even when it's the same date, and browsers respond by resetting
  // which subfield has focus -- so typing a year out mid-edit kept bouncing you back to
  // the day field. Keeping a separate draft, and only resyncing it from `currentDate`
  // while the box is NOT focused, lets the browser own the text while you're typing;
  // the clamp still fires and drives the simulation, it just no longer echoes back.
  const [dateDraft, setDateDraft] = useState("");
  const [dateFocused, setDateFocused] = useState(false);

  // The task-table/chart split is draggable -- see the resize handle rendered just
  // after the rows below. `null` means "use the computed default" (leftWBase,
  // below); once the user drags, this holds their chosen width instead, and keeps
  // winning even if `bl` later changes the default (loading/unloading a baseline
  // shouldn't silently undo a resize the user just made).
  const [leftFrac, setLeftFrac] = useState(null);   // null = 50/50 split
  const [resizingCols, setResizingCols] = useState(false);

  const range = schedule?.range;

  // A few days of padding either side so the first and last bars aren't flush
  // against the edge of the chart.
  const axis = useMemo(() => {
    if (!range) return null;
    const start = +range.min - 3 * DAY;
    const end = +range.max + 3 * DAY;
    return { start, end, days: Math.max(1, Math.ceil((end - start) / DAY)) };
  }, [range]);

  const width = axis ? axis.days * pxPerDay : 0;
  const xOf = (t) => ((+t - axis.start) / DAY) * pxPerDay;

  // Rows the user can actually see: a task is hidden when any ancestor is collapsed.
  const rows = useMemo(() => {
    if (!schedule?.hasSchedule) return [];
    const hidden = new Set();
    const out = [];
    const keep = (t) => !(criticalOnly && !t.critical && !t.isSummary);

    if (codeSort) {
      // P6/Synchro-style column sort: re-order SIBLINGS at every level of the tree by
      // activity code, rather than flattening it. The hierarchy (who nests under whom,
      // and therefore each row's indent depth) is completely untouched -- only which
      // sibling comes first within a given parent changes. Re-walks from `schedule.tasks`
      // instead of `schedule.rows` because `rows` is pre-flattened in WBS order and
      // re-sorting it in place would lose the ability to regroup by parent.
      const cmp = codeSort === "asc" ? compareCode : (a, b) => compareCode(b, a);
      const walk = (id) => {
        const t = schedule.tasks.get(id);
        if (!t) return;
        if (t.parent != null && (hidden.has(t.parent) || collapsed[t.parent])) {
          hidden.add(t.id);
        } else if (keep(t)) {
          out.push(t);
        }
        const kids = t.children.map(cid => schedule.tasks.get(cid)).filter(Boolean).sort(cmp);
        for (const c of kids) walk(c.id);
      };
      const roots = [...schedule.tasks.values()].filter(t => t.parent == null).sort(cmp);
      for (const r of roots) walk(r.id);
      return out;
    }

    for (const t of schedule.rows) {
      if (t.parent != null && (hidden.has(t.parent) || collapsed[t.parent])) {
        hidden.add(t.id);
        continue;
      }
      if (!keep(t)) continue;
      out.push(t);
    }
    return out;
  }, [schedule, collapsed, criticalOnly, codeSort]);

  const rowIndex = useMemo(() => {
    const m = new Map();
    rows.forEach((t, i) => m.set(t.id, i));
    return m;
  }, [rows]);

  // A dependency whose endpoint is collapsed away still matters, so it is drawn to
  // the nearest visible ancestor instead of being silently dropped.
  const visibleRowOf = (id) => {
    let cur = id;
    const guard = new Set();
    while (cur != null && !guard.has(cur)) {
      guard.add(cur);
      if (rowIndex.has(cur)) return cur;
      cur = schedule.tasks.get(cur)?.parent ?? null;
    }
    return null;
  };

  const bodyH = rows.length * ROW_H;

  // The BL pair only exists when a baseline has actually been merged.
  const bl = !!schedule?.hasBaseline;
  const leftWBase = LEFT_W_BASE + (bl ? 2 * DATE_W : 0);
  // Left pane = leftFrac of the width (default half), the rest is the timeline.
  // tableW is the table's own content width: never narrower than its columns
  // need (the pane then scrolls sideways on its own), and stretched to fill the
  // pane when it is wider so the Task column absorbs the extra room.
  const DIV_W = 6;
  const paneW = containerW
    ? Math.round((containerW - DIV_W) * (leftFrac ?? 0.5))
    : leftWBase;
  const leftW = paneW;
  const tableW = Math.max(leftWBase, paneW);

  // Drag the divider between the panes (window-level mousemove/mouseup pair).
  const onColResizeMouseDown = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = paneW;
    const total = Math.max(1, containerW - DIV_W);
    setResizingCols(true);
    const move = (ev) => {
      setLeftFrac(Math.max(0.15, Math.min(0.85, (startW + (ev.clientX - startX)) / total)));
    };
    const up = () => {
      setResizingCols(false);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // Tracks the scroll container's own width, live -- not just on mount, since the
  // Gantt panel can be resized (the drag divider above it, or the browser window
  // itself). fitMode's effect below reads this to know how many pixels are actually
  // available for the chart.
  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const update = () => setContainerW(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [schedule?.hasSchedule]);

  // Fit zoom: pxPerDay is normally a fixed preset (Month/Week/Day), but "Fit" instead
  // solves for whatever pxPerDay makes the WHOLE project exactly fill the space
  // there is, so the timeline always reads clearly -- no dead space on a short
  // project, no forced scrolling on a long one.
  useEffect(() => {
    if (!fitMode || !axis || !containerW) return;
    const avail = Math.max(50, containerW - paneW - DIV_W - 14);
    setPxPerDay(Math.max(0.3, avail / axis.days));
  }, [fitMode, axis, containerW, paneW]);

  // Follow the playhead horizontally as the timeline (top slider or Play) moves it,
  // rather than leaving the user to chase it with the scrollbar. Only nudges the
  // scroll when the playhead actually leaves the visible timeline -- not every tick --
  // so it doesn't fight a manual scroll that's still in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !axis || !currentDate) return;
    const viewWidth = el.clientWidth;
    if (viewWidth <= 0) return;
    const playheadPx = xOf(currentDate);
    const margin = Math.min(80, viewWidth * 0.15);
    if (playheadPx < el.scrollLeft + margin || playheadPx > el.scrollLeft + viewWidth - margin) {
      // Biased towards the left third, so there's more upcoming timeline in view
      // than trailing history while playing forward.
      el.scrollLeft = Math.max(0, playheadPx - viewWidth * 0.3);
    }
  }, [currentDate, axis, pxPerDay]);

  // Follow the task list vertically too: whichever row the playhead currently sits
  // inside of (its own Start/Finish, links applied) is scrolled into view. Leaf
  // tasks win over an enclosing summary, since the summary's span usually covers the
  // whole visible window and would never need to scroll.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !schedule?.hasSchedule || !currentDate) return;
    const t = +currentDate;
    let activeIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const s = +(r.curStart ?? r.start ?? 0);
      const f = +(r.curFinish ?? r.finish ?? 0);
      if (s && f && t >= s && t <= f) {
        activeIdx = i;
        if (!r.isSummary) break;
      }
    }
    if (activeIdx === -1) return;
    const rowTop = HEADER_H + activeIdx * ROW_H;
    const rowBottom = rowTop + ROW_H;
    const viewTop = el.scrollTop + HEADER_H;
    const viewBottom = el.scrollTop + el.clientHeight;
    if (rowTop < viewTop || rowBottom > viewBottom) {
      el.scrollTop = Math.max(0, rowTop - (el.clientHeight - HEADER_H) / 2);
    }
  }, [currentDate, rows, schedule]);

  // Sync the date-box draft from the real playhead only when the user isn't actively
  // editing it -- see the note by dateDraft's declaration above.
  useEffect(() => {
    if (!dateFocused) setDateDraft(fmt(currentDate));
  }, [currentDate, dateFocused]);

  // --- calendar bands and gridlines for the selected zoom -------------------------
  // Month zoom has month cells, week zoom has Monday-to-Sunday cells, and day zoom
  // has one cell per calendar day. Keeping the header and the background grid on the
  // same bands makes every bar line up with the visible calendar segregation.
  const timeScale = pxPerDay >= 24 ? "day" : pxPerDay >= 10 ? "week" : "month";

  // Memoized -- and hoisted above the early-return below so the hook itself always
  // runs. `bands`/`monthBands` only change with the zoom level or the schedule's own
  // span, never with `currentDate`; without memoizing, the whole calendar grid (one
  // DOM cell per visible day/week/month) was rebuilt from scratch on every single
  // playback tick for a result that hadn't changed.
  const { bands, monthBands } = useMemo(() => {
    if (!axis) return { bands: [], monthBands: [] };
    const bands = [];
    {
      const d = new Date(axis.start);
      let cur;
      let next;
      if (timeScale === "day") {
        cur = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
        next = (t) => t + DAY;
      } else if (timeScale === "week") {
        // Monday is the conventional construction-programme week boundary.
        const mondayOffset = (d.getUTCDay() + 6) % 7;
        cur = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - mondayOffset);
        next = (t) => t + 7 * DAY;
      } else {
        cur = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
        next = (t) => {
          const m = new Date(t);
          return Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1);
        };
      }
      while (cur <= axis.end) {
        const end = next(cur);
        bands.push({ start: Math.max(cur, axis.start), end: Math.min(end, axis.end), labelDate: cur });
        cur = end;
      }
    }

    // Month heading strip, Day zoom only: consecutive day-bands sharing a calendar
    // month are merged into one wide cell, so "November" reads once across all of its
    // days instead of repeating on every column.
    const monthBands = [];
    if (timeScale === "day") {
      for (const band of bands) {
        const d = new Date(band.labelDate);
        const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
        const last = monthBands[monthBands.length - 1];
        if (last && last.key === key) {
          last.end = band.end;
        } else {
          monthBands.push({
            key, start: band.start, end: band.end,
            label: `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
          });
        }
      }
    }
    return { bands, monthBands };
  }, [axis, timeScale]);

  // --- dependency arrow geometry --- also hoisted + memoized for the same reason:
  // links only change with the schedule, the visible row set or the "show
  // dependencies" toggle, never with the playhead.
  const arrows = useMemo(() => {
    if (!showArrows || !schedule?.hasSchedule || !axis) return [];
    const out = [];
    for (const link of schedule.links) {
      const fromId = visibleRowOf(link.from);
      const toId = visibleRowOf(link.to);
      if (fromId == null || toId == null || fromId === toId) continue;
      const a = schedule.tasks.get(fromId);
      const b = schedule.tasks.get(toId);
      if (!a?.start || !a?.finish || !b?.start || !b?.finish) continue;

      // Anchor points depend on the relationship: an FS link leaves the predecessor's
      // finish, an SS link leaves its start, and so on.
      const fromStart = link.type === "SS" || link.type === "SF";
      const toFinish = link.type === "FF" || link.type === "SF";
      const ax = fromStart ? xOf(a.start) : xOf(a.finish);
      const bx = toFinish ? xOf(b.finish) : xOf(b.start);
      const ay = rowIndex.get(fromId) * ROW_H + ROW_H / 2;
      const by = rowIndex.get(toId) * ROW_H + ROW_H / 2;

      const dir = fromStart ? -1 : 1;   // which way we leave the predecessor
      const stub = 9;
      const enter = toFinish ? bx + 6 : bx - 6;
      const sx = ax + dir * stub;

      let d;
      if ((dir > 0 && sx <= enter - 4) || (dir < 0 && sx >= enter + 4)) {
        d = `M${ax},${ay} L${sx},${ay} L${sx},${by} L${enter},${by}`;
      } else {
        // Not enough room to go straight across: step out to the row gutter first.
        const mid = by + (by > ay ? -ROW_H / 2 : ROW_H / 2);
        const back = toFinish ? enter + stub : enter - stub;
        d = `M${ax},${ay} L${sx},${ay} L${sx},${mid} L${back},${mid} L${back},${by} L${enter},${by}`;
      }
      out.push({
        d, key: `${link.from}-${link.to}-${link.type}`,
        critical: a.critical && b.critical,
        toFinish, enter, by,
      });
    }
    return out;
  }, [showArrows, schedule, rowIndex]);

  if (!schedule?.hasSchedule || !axis) {
    return (
      <div style={{ padding: 10, fontSize: 12, color: "var(--ink-400)", fontFamily: "var(--font-mono)" }}>
        {schedule ? "This file contains no IfcTask schedule." : "Load an IFC file."}
      </div>
    );
  }

  const bandLabel = (band) => {
    const d = new Date(band.labelDate);
    if (timeScale === "month") return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
    if (timeScale === "week") {
      // "Week of month" counted from the 1st, not from which Monday-of-the-year this
      // is -- so the label resets to 1 at the start of every month, matching how a
      // site team says "week 2 of November" rather than "the 45th week of the year".
      const weekOfMonth = Math.ceil(d.getUTCDate() / 7);
      return `Week ${weekOfMonth} ${MONTHS[d.getUTCMonth()]}`;
    }
    return WEEKDAYS[d.getUTCDay()];
  };

  const playheadX = xOf(currentDate);

  const totalDays = Math.round((+range.max - +range.min) / DAY);

  // THE THREE DATE PAIRS, and which field each reads:
  //
  //   Start / Finish          t.curStart / t.curFinish -- the updated export's CURRENT
  //                           schedule, already rescheduled along the logic links.
  //                           Always shown; this is the live plan.
  //   BL Start / BL Finish    t.start / t.finish, which withBaseline() replaces with the
  //                           plan-only export's dates. Shown ONLY when a baseline is
  //                           merged: without one they would repeat Start/Finish
  //                           verbatim, and calling that "BL" would be a lie -- a
  //                           progressed IFC has its planned dates overwritten in place.
  //   Actual Start / Finish   t.actualStart / t.actualFinish, recorded facts only, blank
  //                           where the work has not begun.
  //
  // NOTE FOR FUTURE EDITS: `bl` (declared near the top, next to leftW) is read here, in
  // the legend swatch, in the Var tooltip, and in the column layout. Removing one use
  // without the others is what caused a white screen on upload once already.
  const dateHeadTitle =
    "Baseline (BL) dates, read from the plan-only IFC and matched on activity code.";

  const zoomOptions = [["fit", "Fit"], ["4", "Month"], ["10", "Week"], ["24", "Day"]];
  const zoomValue = fitMode ? "fit" : String(pxPerDay);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column",
                  background: "var(--paper)", fontSize: 11, color: "var(--ink-700)" }}>
      {/* Title/Zoom/filters, then Play/seek/date/Speed, all in one row above the
          chart. The left box is exactly leftW wide -- the same width as the sticky
          task table underneath -- so Play/seek/date/Speed start where the
          calendar/bars start, not where the task list (the "activities") does.

          `nowrap` is deliberate: everything but the slider keeps its natural size
          (flexShrink:0), and the slider is the one thing that gives -- it shrinks
          down to MIN_SLIDER_W before anything would wrap, and grows to fill
          whatever's left otherwise (uncapped now that the legend has its own bar
          below instead of competing with the slider for room in this one). */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "8px 14px",
                    borderBottom: "1px solid var(--line-soft)", background: "var(--paper-2)",
                    flexWrap: "nowrap", flexShrink: 0 }}>
        <div style={{ width: leftW, flexShrink: 0, display: "flex", alignItems: "center",
                      gap: 14, overflow: "hidden" }}>
          <strong style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.08em",
                          textTransform: "uppercase", color: "var(--ink-700)", whiteSpace: "nowrap" }}>
            Construction Schedule
          </strong>

          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            <span style={{ fontSize: 11.5, color: "var(--ink-400)" }}>Zoom</span>
            {zoomOptions.map(([v, label]) => (
              <button
                key={v}
                onClick={() => { if (v === "fit") setFitMode(true); else { setFitMode(false); setPxPerDay(Number(v)); } }}
                style={{
                  fontFamily: "inherit", fontSize: 11.5, padding: "4px 10px", cursor: "pointer",
                  background: zoomValue === v ? "var(--aar-blue)" : "var(--paper)",
                  color: zoomValue === v ? "#fff" : "var(--ink-600)",
                  border: "1px solid " + (zoomValue === v ? "var(--aar-blue)" : "var(--line-strong)"),
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <label style={flagLabel}>
            <span style={checkboxBox(showArrows)}>{showArrows ? "✓" : ""}</span>
            <input type="checkbox" checked={showArrows} onChange={e => setShowArrows(e.target.checked)}
                   style={{ display: "none" }} />
            Dependencies
          </label>
          <label style={flagLabel}>
            <span style={checkboxBox(criticalOnly)}>{criticalOnly ? "✓" : ""}</span>
            <input type="checkbox" checked={criticalOnly} onChange={e => setCriticalOnly(e.target.checked)}
                   style={{ display: "none" }} />
            Critical only
          </label>
        </div>

        <button
          onClick={onTogglePlay}
          style={{
            fontFamily: "inherit", fontSize: 12, fontWeight: 500, padding: "6px 14px", cursor: "pointer",
            minWidth: 84, flexShrink: 0, background: playing ? "var(--ink-700)" : "var(--aar-blue)",
            color: "#fff", border: 0,
          }}
        >
          {playing ? "❚❚ Pause" : "▶ Play"}
        </button>

        <input
          type="range"
          min={+range.min}
          max={+range.max}
          value={Math.min(Math.max(+currentDate, +range.min), +range.max)}
          onChange={e => onDateChange(new Date(Number(e.target.value)))}
          style={{ flex: "1 1 320px", minWidth: MIN_SLIDER_W }}
        />

        {/* Jump straight to a date, rather than only scrubbing the slider -- lets a
            client ask "what's built by 15 Sept" and land on it exactly instead of
            hunting pixel-by-pixel. Clamped to the schedule's own span. */}
        <input
          type="date"
          title="Jump the simulation straight to a date, to see what's built (or still to come) at that point."
          min={fmt(range.min)}
          max={fmt(range.max)}
          value={dateDraft}
          onFocus={() => setDateFocused(true)}
          onBlur={() => {
            setDateFocused(false);
            // Whatever's in the box when focus leaves becomes the truth: re-fmt from
            // the last committed currentDate if it was left empty or unparseable,
            // otherwise this just re-confirms what onChange already committed below.
            setDateDraft(fmt(currentDate));
          }}
          onChange={e => {
            // Show exactly what the browser's date widget has -- never a reformatted
            // or clamped echo -- so typing across day/month/year segments can't get
            // reset out from under the user mid-edit.
            setDateDraft(e.target.value);
            if (!e.target.value) return;
            const d = new Date(e.target.value);
            if (Number.isNaN(+d)) return;
            const clamped = new Date(Math.min(Math.max(+d, +range.min), +range.max));
            onDateChange(clamped);
          }}
          style={{
            fontFamily: "var(--font-mono)", fontSize: 12, flexShrink: 0, color: "var(--ink-700)",
            border: "1px solid var(--line-strong)", background: "var(--paper)", padding: "4px 6px",
          }}
        />

        {/* Speed: a ladder with -/+ rather than a fixed dropdown, so the simulation
            can be dialled from a slow walkthrough to a whole-project flythrough.
            Grouped with Play/seek/date since it's the same playback control set. */}
        <span style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
          <span style={{ fontSize: 11.5, color: "var(--ink-400)" }}>Speed</span>
          <button
            onClick={() => onSpeedChange(stepSpeed(speed, -1))}
            disabled={speedIndex(speed) === 0}
            title="Slower"
            style={speedBtn}
          >−</button>
          <span title={`${daysPerSecond(speed).toFixed(0)} days per second`}
                style={{ fontFamily: "var(--font-mono)", fontSize: 12, minWidth: 58,
                         textAlign: "center", color: "var(--ink-700)" }}>
            {SPEED_LABELS[speedIndex(speed)]}
          </span>
          <button
            onClick={() => onSpeedChange(stepSpeed(speed, +1))}
            disabled={speedIndex(speed) === SPEED_STEPS.length - 1}
            title="Faster"
            style={speedBtn}
          >+</button>
        </span>
      </div>

      {/* Legend, moved to its own bar -- pulling it out of the row above gives the
          seek slider the rest of that row's width to grow into instead of competing
          with these swatches for space. */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "5px 14px",
                    borderBottom: "1px solid var(--line-soft)", background: "var(--paper)",
                    flexWrap: "wrap", flexShrink: 0, fontSize: 11 }}>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center",
                       color: "var(--ink-600)" }}>
          <Swatch color={COLORS.critical} label={`Critical path (${schedule.criticalIds.size})`} />
          <Swatch color={COLORS.normal} label={bl ? "Baseline" : "Planned"} />
          <Swatch color={COLORS.done} label="Complete" />
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--ink-400)" }}>
            {totalDays}d · {schedule.links.length} links
          </span>
        </span>
      </div>

      {/* Two panes, each with its OWN horizontal scrollbar: the task table on the
          left, the timeline on the right, split 50/50 by default with a draggable
          divider between them. Vertical scroll is shared -- the right pane is the
          master and drives the left one (see onScroll / onWheel below). */}
      <div ref={outerRef} style={{ flex: 1, display: "flex", minHeight: 0, position: "relative" }}>
        <div ref={leftPaneRef}
             onWheel={e => { if (scrollRef.current) scrollRef.current.scrollTop += e.deltaY; }}
             style={{ width: paneW, flexShrink: 0, minWidth: 0,
                      overflowX: "scroll", overflowY: "hidden" }}>
          <div style={{ position: "relative", width: tableW, height: HEADER_H + bodyH }}>
            <div style={{ position: "sticky", top: 0, zIndex: 6, width: tableW, height: HEADER_H,
                          flexShrink: 0, display: "flex", alignItems: "center",
                          boxSizing: "border-box",
                          background: "var(--paper-2)", borderRight: "1px solid var(--line-strong)",
                          borderBottom: "1px solid var(--line-strong)",
                          padding: "0 6px", gap: 6, fontWeight: 600, color: "var(--ink-400)",
                          fontSize: 11.5, letterSpacing: "0.04em", textTransform: "uppercase" }}>
              <span
                onClick={() => setCodeSort(s => (s === "asc" ? "desc" : s === "desc" ? null : "asc"))}
                title={codeSort
                  ? "Siblings sorted by activity code within each group. Click to " +
                    (codeSort === "asc" ? "reverse" : "return to the file's own WBS order") + "."
                  : "Click to sort siblings by activity code within each group (currently the file's own WBS order)."}
                style={{ width: 52, cursor: "pointer", userSelect: "none",
                         color: codeSort ? "var(--aar-blue-deep)" : "var(--ink-400)" }}
              >
                Code{codeSort === "asc" ? " ▲" : codeSort === "desc" ? " ▼" : ""}
              </span>
              <span style={{ flex: 1 }}>Task</span>
              <span title="The CURRENT schedule from the updated export, rescheduled along the logic links: where an early activity slipped, its successors have already moved out. Actual dates for work that is done, forecast dates for work still to come."
                    style={dateHead}>Start</span>
              <span title="The CURRENT schedule from the updated export, rescheduled along the logic links: where an early activity slipped, its successors have already moved out. Actual dates for work that is done, forecast dates for work still to come."
                    style={dateHead}>Finish</span>
              {bl && (
                <>
                  <span title={dateHeadTitle}
                        style={{ ...dateHead, color: "var(--aar-blue-deep)" }}>BL Start</span>
                  <span title={dateHeadTitle}
                        style={{ ...dateHead, color: "var(--aar-blue-deep)" }}>BL Finish</span>
                </>
              )}
              <span title="Recorded actuals only. Blank until an activity has actually started or finished -- these cells never borrow a scheduled date."
                    style={{ ...dateHead, color: "var(--status-ontime)" }}>Actual Start</span>
              <span title="Recorded actuals only. Blank until an activity has actually started or finished -- these cells never borrow a scheduled date."
                    style={{ ...dateHead, color: "var(--status-ontime)" }}>Actual Finish</span>
              <span title={bl
                      ? "Actual/forecast finish minus BL finish, in calendar days."
                      : "Actual/forecast finish minus planned finish, in calendar days. " +
                        "With no baseline loaded this reads 0 on every task."}
                    style={{ width: 44, textAlign: "right" }}>Var</span>
              <span style={{ width: 34, textAlign: "right" }}>Float</span>
            </div>
            {rows.map((t, i) => (
              <TaskRow
                key={t.id}
                t={t}
                sel={t.id === selectedTaskId}
                tableW={tableW}
                bl={bl}
                hasKids={t.children.length > 0}
                isCollapsed={!!collapsed[t.id]}
                striped={!!(i % 2)}
                onToggleCollapse={toggleCollapse}
                selectRef={selectRef}
              />
            ))}
          </div>
        </div>

        {/* Divider between the panes. Drag to resize. */}
        <div
          onMouseDown={onColResizeMouseDown}
          title="Drag to resize the task list"
          style={{ width: DIV_W, flexShrink: 0, cursor: "col-resize", boxSizing: "border-box",
                   borderLeft: "1px solid var(--line-strong)", borderRight: "1px solid var(--line-strong)",
                   background: resizingCols ? "rgba(63,110,140,.5)" : "var(--paper-3)" }}
        />

        <div ref={scrollRef}
             onScroll={e => { if (leftPaneRef.current) leftPaneRef.current.scrollTop = e.currentTarget.scrollTop; }}
             style={{ flex: 1, minWidth: 0, overflowX: "scroll", overflowY: "auto", position: "relative" }}>
          <div style={{ position: "relative", width, height: HEADER_H + bodyH }}>
            <div style={{ position: "sticky", top: 0, zIndex: 6, height: HEADER_H, width,
                          background: "var(--paper-2)", borderBottom: "1px solid var(--line-strong)" }}>
            {/* Not seekable here -- the toolbar slider above is the only way to move
                the playhead, so dragging in the chart can't be mistaken for a task
                click. See the same note on the bar track below. */}
            <div
              style={{ position: "relative", width, flexShrink: 0 }}
            >
              {/* Month heading, Day zoom only -- see monthBands above. */}
              {timeScale === "day" && monthBands.map(mb => {
                const w = ((mb.end - mb.start) / DAY) * pxPerDay;
                return (
                  <div key={mb.key} style={{
                    position: "absolute", left: xOf(mb.start), width: w,
                    top: 0, height: MONTH_ROW_H,
                    borderLeft: "1px solid var(--line-strong)", borderBottom: "1px solid var(--line-strong)",
                    boxSizing: "border-box", padding: "1px 4px", overflow: "hidden",
                    whiteSpace: "nowrap", color: "var(--ink-600)", fontWeight: 600, fontSize: 10.5, lineHeight: 1.2,
                    background: "var(--paper-cool)",
                  }}>
                    {w > 30 ? mb.label : ""}
                  </div>
                );
              })}
              {bands.map(band => {
                const x = xOf(band.start);
                const w = ((band.end - band.start) / DAY) * pxPerDay;
                const top = timeScale === "day" ? MONTH_ROW_H : 0;
                return (
                  <div key={band.labelDate} style={{
                    position: "absolute", left: x, width: w, top,
                    height: HEADER_H - top,
                    borderLeft: "1px solid var(--line-strong)", boxSizing: "border-box",
                    padding: "3px 4px", overflow: "hidden", whiteSpace: "nowrap",
                    color: "var(--ink-500)", fontSize: 11,
                  }}>
                    {/* "Mon"/"Tue" etc. are short enough to fit the exact 24px-wide day
                        column at Day zoom -- the old threshold of 26 was tuned for the
                        longer "03 Nov" label this replaced, and hid the day header
                        entirely at that zoom level. */}
                    {w > 18 ? bandLabel(band) : ""}
                  </div>
                );
              })}
            </div>
            </div>

          {/* Calendar gridlines behind everything, matching the active zoom level. */}
          <div style={{ position: "absolute", left: 0, top: HEADER_H, width,
                        height: bodyH, zIndex: 0 }}>
            {bands.map(band => (
              <div key={band.labelDate} style={{
                position: "absolute", left: xOf(band.start), top: 0, bottom: 0,
                width: 1, background: "var(--paper-cool)",
              }} />
            ))}
          </div>

          {/* dependency arrows, under the bars so they read as connectors */}
          <svg
            width={width} height={bodyH}
            style={{ position: "absolute", left: 0, top: HEADER_H, zIndex: 1,
                     pointerEvents: "none" }}
          >
            {arrows.map(a => (
              <g key={a.key}>
                <path d={a.d} fill="none" strokeWidth={1}
                      stroke={a.critical ? COLORS.arrowCrit : COLORS.arrow} />
                <polygon
                  points={a.toFinish
                    ? `${a.enter + 5},${a.by - 3} ${a.enter + 5},${a.by + 3} ${a.enter - 1},${a.by}`
                    : `${a.enter - 5},${a.by - 3} ${a.enter - 5},${a.by + 3} ${a.enter + 1},${a.by}`}
                  fill={a.critical ? COLORS.arrowCrit : COLORS.arrow}
                />
              </g>
            ))}
          </svg>

            {rows.map((t, i) => {
              const x = xOf(t.start);
              const w = Math.max(3, xOf(t.finish) - x);
              const color = t.isSummary ? COLORS.summary
                          : t.critical ? COLORS.critical : COLORS.normal;
              return (
                <BarRow
                  key={t.id}
                  t={t}
                  sel={t.id === selectedTaskId}
                  x={x}
                  w={w}
                  done={taskProgressAt(t, currentDate)}
                  color={color}
                  pxPerDay={pxPerDay}
                  width={width}
                  striped={!!(i % 2)}
                  selectRef={selectRef}
                />
              );
            })}

          {/* playhead */}
          <div style={{
            position: "absolute", left: playheadX, top: 0,
            height: HEADER_H + bodyH, width: 2, background: COLORS.playhead,
            zIndex: 4, pointerEvents: "none",
          }}>
            <div style={{
              position: "sticky", top: 0, marginLeft: -26, width: 52,
              textAlign: "center", background: COLORS.playhead, color: "#fff",
              fontSize: 10.5, padding: "1px 0",
            }}>
              {fmt(currentDate).slice(5)}
            </div>
          </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Swatch({ color, label }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, whiteSpace: "nowrap",
                   padding: "3px 10px 3px 8px", background: "var(--paper-2)",
                   border: "1px solid var(--line)", borderRadius: "var(--r-sm)",
                   color: "var(--ink-600)", fontSize: 11 }}>
      <span style={{ width: 12, height: 8, background: color, borderRadius: 2, display: "inline-block" }} />
      {label}
    </span>
  );
}
