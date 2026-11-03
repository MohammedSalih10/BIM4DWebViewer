import React, { useEffect, useRef, useState } from "react";
import { IFCLoader } from "web-ifc-three/IFCLoader";
import { collectElements, cssColor, HIGHLIGHT } from "./ifcMaterials";
import { readSchedule, withBaseline, TASK_STATUS, STATUS_ORDER } from "./ifcSchedule";
import Viewport3D from "./Viewport3D";
import GanttChart from "./GanttChart";
import ColorCodingSettings from "./ColorCodingSettings";
import UpcomingActivities from "./UpcomingActivities";
import ElementDetailsDialog from "./ElementDetailsDialog";

const TICK_MS = 120;

// The app's own traffic-light colours, as "#rrggbb" -- the starting point for the
// per-user override in ColorCodingSettings, and what "Reset to defaults" goes back to.
const DEFAULT_STATUS_COLORS = Object.fromEntries(
  STATUS_ORDER.map(k => [k, cssColor(TASK_STATUS[k].color)])
);

/**
 * Planned vs Actual: two independently-scheduled IFCs, each growing off its OWN
 * dates, driven by ONE shared playhead -- so the Actual side can visibly be ahead of
 * or behind the Planned side at the same date. Bottom bar is a single merged Gantt
 * (Planned supplies the BL columns, Actual supplies Start/Finish + Actual), built by
 * the same withBaseline() merge SimpleViewer uses, so the shared timeline's
 * start/end already covers whichever file's dates run earlier or later.
 *
 * BOTH FILES ARE LOADED THROUGH ONE SHARED IFCLoader, sequentially. This is not an
 * optimisation, it is required: web-ifc-three's IFCModel gets its `.modelID` from a
 * MODULE-GLOBAL static counter (`IFCModel.modelIdCounter`), but each IFCLoader's own
 * IfcAPI numbers models 0, 1, 2... independently per instance. Two separately-`new`'d
 * IFCLoaders each loading one model therefore both produce an internal API modelID
 * of 0, while their THREE meshes get global ids 0 and 1 -- and createSubset on the
 * second one crashes reading `state.models[1]`, which only exists as `[0]` in that
 * loader's own manager. Loading both files through the SAME loader keeps the global
 * counter and the shared API's internal indices in lockstep (0, then 1, on both).
 *
 * WORSE: `model.modelID` itself cannot be trusted at all, even within one loader.
 * It comes from `IFCModel`'s constructor (`IFCModel.modelIdCounter++`), a counter
 * that is shared by every IFCLoader ever used on the page -- including whatever
 * SimpleViewer already loaded in the single view before the user switched here. So
 * `state.models` (keyed by the loader's own real, per-instance OpenModel index) and
 * `model.modelID` (the page-wide counter) drift apart from the very first load,
 * and passing `model.modelID` into `createSubset` throws deep in web-ifc-three
 * (`ItemsMap.getGeometry` reading `.mesh` of `undefined`). The fix below never
 * reads `model.modelID` -- it diffs `state.models`'s own keys before/after each
 * load to recover the REAL id, which is the only number `createSubset` accepts.
 */
export default function SplitCompareView({ plannedUrl, actualUrl }) {
  const loaderRef = useRef(null);
  const [plannedPane, setPlannedPane] = useState(null);   // { model, modelID, buckets, siteIds, allIds, schedule }
  const [actualPane, setActualPane] = useState(null);
  const [loadStatus, setLoadStatus] = useState("Loading both models...");
  const [actualSchedule, setActualSchedule] = useState(null); // the merged one, drives the shared Gantt

  const [currentDate, setCurrentDate] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [selectedTaskId, setSelectedTaskId] = useState(null);
  const [colourTerrain, setColourTerrain] = useState(false);
  const [showEdges, setShowEdges] = useState(true);
  const [showStatusColors, setShowStatusColors] = useState(true);
  // User-picked overrides for the traffic-light colours -- "system colours" (no
  // colour coding at all) is what showStatusColors=false already means, so this only
  // customises the colours used WHEN colour coding is on.
  const [statusColors, setStatusColors] = useState(DEFAULT_STATUS_COLORS);
  // Matches SimpleViewer's default -- off, so loading a baseline here does not
  // silently start colouring not-yet-started work until the user opts in.
  const [showUpcoming, setShowUpcoming] = useState(false);
  const [ganttH, setGanttH] = useState(300);
  // Collapses the Gantt panel down to just its divider bar, handing its height back
  // to the Planned/Actual pane row above (flex:1 there picks up the slack
  // automatically) -- same pattern as SimpleViewer's Gantt divider.
  const [ganttCollapsed, setGanttCollapsed] = useState(false);
  // Drag-to-resize split between the Planned and Actual panes -- a fraction (0..1)
  // of the row's width given to the Planned (left) pane. Starts at an even 50/50,
  // same as the fixed flex:1/flex:1 this replaces.
  const [splitFrac, setSplitFrac] = useState(0.5);
  const [splitResizing, setSplitResizing] = useState(false);
  const splitRowRef = useRef(null);
  const playRef = useRef(null);
  // Same click-to-select + highlight feature as SimpleViewer, mirrored across both
  // panes. `selectedTaskId` (already used by the shared Gantt below) is the single
  // source of truth; each pane's own element ids for that task are derived below.
  const [highlightColor, setHighlightColor] = useState(cssColor(HIGHLIGHT.color));
  // ONE details dialog for BOTH panes -- not one each. A click in either pane resolves
  // to the SAME merged task (see handlePick below), and that merged task already
  // carries BL (planned) + current + actual dates together, so a single dialog showing
  // it says everything two separate ones would, without asking "which one do I read".
  const [pickedDetails, setPickedDetails] = useState(null);

  // "Lock views": one pane's camera drives the other. Each Viewport3D owns its own
  // scene/camera/render loop and knows nothing about its sibling, so the two report
  // their {camera, controls} up here via onReady, and a loop in THIS component copies
  // the last-moved one's transform onto the other every frame -- the same
  // active/follower pattern, across two separate components. Mutating the follower's camera/controls in place is
  // enough: its own Viewport3D still renders it every frame, it just picks up
  // whatever this loop last set.
  const [locked, setLocked] = useState(true);
  const panesRef = useRef({ planned: null, actual: null });
  const activeRef = useRef("planned");

  const onPaneReady = (which) => (r) => {
    panesRef.current[which] = r;
    if (r) r.controls.addEventListener("start", () => { activeRef.current = which; });
  };

  useEffect(() => {
    if (!locked) return;
    let raf;
    const tick = () => {
      const { planned, actual } = panesRef.current;
      if (planned && actual) {
        const active = activeRef.current === "planned" ? planned : actual;
        const follower = activeRef.current === "planned" ? actual : planned;
        follower.camera.position.copy(active.camera.position);
        follower.camera.quaternion.copy(active.camera.quaternion);
        follower.controls.target.copy(active.controls.target);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [locked]);

  useEffect(() => {
    if (!plannedUrl || !actualUrl) return;
    let cancelled = false;
    setPlannedPane(null);
    setActualPane(null);
    setActualSchedule(null);
    setCurrentDate(null);
    setPlaying(false);
    setLoadStatus("Loading both models...");

    (async () => {
      try {
        const loader = new IFCLoader();
        await loader.ifcManager.setWasmPath("/wasm/");
        loaderRef.current = loader;

        // The only reliable way to learn a just-loaded model's REAL id -- see the
        // header note. `state.models` is keyed by it; `model.modelID` is not.
        const realIdOf = (before) => {
          const after = Object.keys(loader.ifcManager.state.models);
          const added = after.find(k => !before.has(k));
          return Number(added);
        };

        setLoadStatus("Loading Planned IFC...");
        const keysBefore1 = new Set(Object.keys(loader.ifcManager.state.models));
        const plannedModel = await loader.loadAsync(plannedUrl);
        const plannedID = realIdOf(keysBefore1);
        const { allIds: pIds, buckets: pBuckets } = await collectElements(loader, plannedModel, plannedID);
        const plannedSched = await readSchedule(loader, plannedID);
        if (cancelled) return;
        setPlannedPane({
          model: plannedModel, modelID: plannedID, buckets: pBuckets, allIds: pIds,
          siteIds: new Set(pBuckets.get("site")?.ids || []), schedule: plannedSched,
        });

        setLoadStatus("Loading Updated (Actual) IFC...");
        const keysBefore2 = new Set(Object.keys(loader.ifcManager.state.models));
        const actualModel = await loader.loadAsync(actualUrl);
        const actualID = realIdOf(keysBefore2);
        const { allIds: aIds, buckets: aBuckets } = await collectElements(loader, actualModel, actualID);
        const actualRaw = await readSchedule(loader, actualID);
        if (cancelled) return;

        const merged = (actualRaw?.hasSchedule && plannedSched?.hasSchedule)
          ? withBaseline(actualRaw, plannedSched)
          : actualRaw;

        setActualPane({
          model: actualModel, modelID: actualID, buckets: aBuckets, allIds: aIds,
          siteIds: new Set(aBuckets.get("site")?.ids || []), schedule: merged,
        });
        setActualSchedule(merged);
        setLoadStatus("");
      } catch (err) {
        console.error("Planned vs Actual load failed:", err);
        if (!cancelled) setLoadStatus("FAILED: " + (err?.message ?? String(err)));
      }
    })();

    return () => {
      cancelled = true;
      try { loaderRef.current?.ifcManager.dispose(); } catch (e) { /* already torn down */ }
      loaderRef.current = null;
    };
  }, [plannedUrl, actualUrl]);

  // Anchor the playhead at the end of the (merged) schedule once it is known.
  const mergedRef = useRef(false);
  useEffect(() => {
    if (!actualSchedule?.range) return;
    if (currentDate == null) { setCurrentDate(actualSchedule.range.max); return; }
    if (actualSchedule.hasBaseline && !mergedRef.current) {
      mergedRef.current = true;
      setCurrentDate(actualSchedule.range.max);
    }
  }, [actualSchedule, currentDate]);

  useEffect(() => {
    if (!playing || !actualSchedule?.range) {
      if (playRef.current) { clearInterval(playRef.current); playRef.current = null; }
      return;
    }
    playRef.current = setInterval(() => {
      setCurrentDate(prev => {
        const next = new Date(+(prev || actualSchedule.range.min) + speed * 86400000);
        if (next >= actualSchedule.range.max) { setPlaying(false); return actualSchedule.range.max; }
        return next;
      });
    }, TICK_MS);
    return () => { clearInterval(playRef.current); playRef.current = null; };
  }, [playing, speed, actualSchedule]);

  function togglePlay() {
    if (!actualSchedule?.range) return;
    if (playing) { setPlaying(false); return; }
    if (!currentDate || +currentDate >= +actualSchedule.range.max) {
      setCurrentDate(actualSchedule.range.min);
    }
    setPlaying(true);
  }

  function selectTask(taskId) {
    setSelectedTaskId(taskId);
    const task = taskId != null ? actualSchedule?.tasks?.get(taskId) : null;
    if (task?.finish && +task.finish > +(currentDate || 0)) {
      setPlaying(false);
      setCurrentDate(task.finish);
    }
  }

  // A task's activity CODE is the only thing guaranteed to mean the same task in BOTH
  // files -- the Planned file's IfcTask entities and the Actual (merged) file's are
  // numbered independently by each STEP file, so `selectedTaskId` (an Actual-side id,
  // since that's what the shared Gantt below is built from) has to be translated by
  // code to find the matching task -- and its own, separate elementIds -- in the
  // Planned pane's schedule. Same code-join withBaseline already does at load time.
  function taskElementIdsByCode(sched, code) {
    if (!sched || code == null) return [];
    for (const t of sched.tasks.values()) if (t.code === code) return t.elementIds;
    return [];
  }

  const selectedCode = selectedTaskId != null ? actualSchedule?.tasks?.get(selectedTaskId)?.code : null;
  // The Actual pane IS `actualSchedule` (see the load effect), so no translation needed.
  const actualSelIds = selectedTaskId != null ? (actualSchedule?.tasks?.get(selectedTaskId)?.elementIds ?? []) : [];
  const plannedSelIds = selectedCode != null ? taskElementIdsByCode(plannedPane?.schedule, selectedCode) : [];

  // Click-to-select in either pane: resolve the clicked element to a task and drive
  // the SAME `selectedTaskId` the Gantt uses, so a pick in one pane highlights the
  // matching elements in BOTH panes (via the derivation above) and the Gantt row,
  // all at once. ALSO populates the one shared details dialog: the clicked element's
  // own name (fetched from whichever file it actually came from) plus the MERGED
  // task, which already carries BL/current/actual together regardless of which pane
  // was clicked -- see the state declaration above for why that's one dialog, not two.
  function handlePick(which) {
    return async (elementId) => {
      if (elementId == null) { setSelectedTaskId(null); setPickedDetails(null); return; }
      const pane = which === "planned" ? plannedPane : actualPane;
      const localTaskId = pane?.schedule?.taskOfElement?.get(elementId);
      if (localTaskId == null) { setSelectedTaskId(null); setPickedDetails(null); return; }

      // The Actual pane's schedule IS `actualSchedule` (see the load effect), so its
      // own task id is already Gantt-facing. The Planned pane's ids are NOT -- its
      // IfcTask entities are numbered independently by that STEP file -- so they only
      // line up with the Gantt's tasks by activity CODE (same join withBaseline does
      // at load time).
      let mergedTask;
      if (which === "actual") {
        mergedTask = actualSchedule?.tasks?.get(localTaskId) ?? null;
      } else {
        const code = pane.schedule.tasks.get(localTaskId)?.code;
        mergedTask = code
          ? [...(actualSchedule?.tasks?.values() ?? [])].find(t => t.code === code) ?? null
          : null;
      }
      setSelectedTaskId(mergedTask ? mergedTask.id : null);

      let name = `Element #${elementId}`;
      try {
        const props = await loaderRef.current.ifcManager.getItemProperties(pane.modelID, elementId);
        name = props?.Name?.value || props?.ObjectType?.value || name;
      } catch (e) { /* unnamed */ }
      setPickedDetails({ name, task: mergedTask, hasBaseline: !!actualSchedule?.hasBaseline });
    };
  }

  function startResize(e) {
    if (ganttCollapsed) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = ganttH;
    const move = ev => setGanttH(Math.max(90, Math.min(700, startH - (ev.clientY - startY))));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  // Dragging the vertical divider between the Planned and Actual panes -- same
  // window-level mousemove/mouseup pattern as the Gantt's own divider above, just
  // driving a 0..1 split fraction (clamped so neither pane can be dragged away
  // entirely) instead of a pixel height.
  function startSplitResize(e) {
    e.preventDefault();
    const row = splitRowRef.current;
    if (!row) return;
    setSplitResizing(true);
    const move = ev => {
      const rect = row.getBoundingClientRect();
      const frac = (ev.clientX - rect.left) / rect.width;
      setSplitFrac(Math.max(0.15, Math.min(0.85, frac)));
    };
    const up = () => {
      setSplitResizing(false);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  const cd = currentDate || actualSchedule?.range?.min;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--paper-3)" }}>
      <div style={{ padding: "8px 20px", background: "var(--paper-2)", borderBottom: "1px solid var(--line-soft)",
                    display: "flex", alignItems: "center", gap: 14, flexShrink: 0, flexWrap: "wrap" }}>
        {/* No "Back to single view" button here -- the header's own "4D Simulation" /
            "3D View" tabs already exit this view (see App.jsx), so this would have
            been a second, redundant way to do the same thing. */}
        <strong style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase",
                        color: "var(--ink-700)" }}>
          Planned vs Actual
        </strong>
        {loadStatus && (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-500)" }}>
            {loadStatus}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <Flag
          label="Lock views" checked={locked} onChange={setLocked}
          title="ON = orbiting, zooming or panning either pane applies the same move to the other, so both are always viewed from the same angle. OFF = each pane's camera is independent."
        />
        <Flag
          label="Colour coding" checked={showStatusColors} onChange={setShowStatusColors}
          title="ON = the Actual pane tints work red/green/yellow/blue by its traffic-light status -- recorded actual dates once they exist, and expected/forecast dates before that, each judged against the baseline. OFF = both panes still grow on schedule, but every element just keeps its own material colour."
        />
        {showStatusColors && (
          <ColorCodingSettings
            colors={statusColors}
            onChange={(k, v) => setStatusColors(prev => ({ ...prev, [k]: v }))}
            onReset={() => setStatusColors(DEFAULT_STATUS_COLORS)}
          />
        )}
        <Flag
          label="Upcoming activities" checked={showUpcoming} onChange={setShowUpcoming}
          title="Shows current and future activities. The panel colours forecast dates against BL Start/Finish: red delayed, green on time, yellow ahead, blue in progress. With Colour coding on, it also applies the same baseline comparison in the 3D view."
        />
        <Flag
          label="Colour terrain" checked={colourTerrain} onChange={setColourTerrain}
          title="The terrain is one large element owned by the excavation activity, so colouring it hides the building behind a status-coloured sheet."
        />
        <Flag
          label="Edges" checked={showEdges} onChange={setShowEdges}
          title="Outlines each element as it's built, in both panes -- grouped by task the same way the build-up itself is, so the outline never gives away geometry that hasn't been reached yet."
        />
        <label title="The colour used to pick out whatever is selected -- click an element in either pane, or a task in the Gantt below. Both panes and the Gantt row stay in sync with each other."
               style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--ink-600)",
                       padding: "5px 9px", cursor: "pointer" }}>
          <input type="color" value={highlightColor}
                 onChange={e => setHighlightColor(e.target.value)}
                 style={{ width: 22, height: 18, padding: 0, border: "1px solid var(--line-strong)",
                          background: "none", cursor: "pointer" }} />
          Highlight
        </label>
      </div>

      <div ref={splitRowRef} style={{ flex: 1, display: "flex", minHeight: 0, position: "relative" }}>
        <div style={{ flex: `${splitFrac} 0 0`, minWidth: 0, borderRight: "1px solid var(--line-strong)" }}>
          <Viewport3D
            label="Planned"
            loader={loaderRef.current}
            model={plannedPane?.model}
            modelID={plannedPane?.modelID}
            buckets={plannedPane?.buckets}
            siteIds={plannedPane?.siteIds}
            allIds={plannedPane?.allIds}
            schedule={plannedPane?.schedule}
            currentDate={cd}
            colourTerrain={colourTerrain}
            showStatusColors={showStatusColors}
            showUpcoming={showUpcoming}
            statusColors={statusColors}
            showEdges={showEdges}
            onReady={onPaneReady("planned")}
            selectedIds={plannedSelIds}
            highlightColor={highlightColor}
            onPick={handlePick("planned")}
          />
        </div>
        {/* Drag handle on the boundary between the two panes -- same straddling
            -3..+3 hit target as the Contents/Insights side-panel handles, so it's
            easy to grab without needing pixel-perfect aim. */}
        <div
          onMouseDown={startSplitResize}
          title="Drag to resize Planned vs Actual"
          style={{
            position: "absolute", left: `calc(${splitFrac * 100}% - 3px)`, top: 0, bottom: 0, width: 6,
            cursor: "col-resize", zIndex: 2,
            background: splitResizing ? "rgba(0,147,210,.5)" : "transparent",
          }}
        />
        <div style={{ flex: `${1 - splitFrac} 0 0`, minWidth: 0 }}>
          <Viewport3D
            label="Actual"
            loader={loaderRef.current}
            model={actualPane?.model}
            modelID={actualPane?.modelID}
            buckets={actualPane?.buckets}
            siteIds={actualPane?.siteIds}
            allIds={actualPane?.allIds}
            schedule={actualPane?.schedule}
            currentDate={cd}
            colourTerrain={colourTerrain}
            showStatusColors={showStatusColors}
            showUpcoming={showUpcoming}
            statusColors={statusColors}
            showEdges={showEdges}
            onReady={onPaneReady("actual")}
            selectedIds={actualSelIds}
            highlightColor={highlightColor}
            onPick={handlePick("actual")}
          />
        </div>

        {/* The checkbox above was already wired to the tinting logic in Viewport3D
            but never actually rendered this list -- "Upcoming activities" looked
            like it did nothing when clicked. Floats over both panes, same as
            SimpleViewer's, driven off the merged `actualSchedule` the Gantt uses. */}
        {showUpcoming && actualSchedule?.hasSchedule && (
          <div style={{
            position: "absolute", top: 12, right: 12, width: 292, maxHeight: "75%",
            background: "rgba(255,255,255,.92)", backdropFilter: "blur(24px)",
            border: "1px solid var(--line-soft)", boxShadow: "var(--elev-2)", display: "flex",
            flexDirection: "column", overflow: "hidden", zIndex: 5,
          }}>
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "9px 12px", borderBottom: "1px solid var(--line-soft)", flexShrink: 0,
            }}>
              <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.06em",
                            textTransform: "uppercase", color: "var(--ink-700)" }}>
                Upcoming activities
              </span>
              <button
                onClick={() => setShowUpcoming(false)} title="Close"
                style={{ fontFamily: "inherit", fontSize: 12, background: "transparent", border: 0,
                         color: "var(--ink-400)", cursor: "pointer" }}
              >
                ✕
              </button>
            </div>
            <UpcomingActivities
              schedule={actualSchedule}
              asOf={cd || actualSchedule.range?.min}
              selectedTaskId={selectedTaskId}
              onSelectTask={selectTask}
              statusColors={statusColors}
            />
          </div>
        )}

        <ElementDetailsDialog
          details={pickedDetails}
          onClose={() => setPickedDetails(null)}
          placement="divider"
        />
      </div>

      {actualSchedule?.hasSchedule && actualSchedule.range && (
        <>
          <div
            onMouseDown={startResize}
            title={ganttCollapsed ? undefined : "Drag to resize"}
            style={{ height: 6, cursor: ganttCollapsed ? "default" : "ns-resize",
                     background: "var(--paper-3)", position: "relative",
                     borderTop: "1px solid var(--line-strong)", borderBottom: "1px solid var(--line-strong)",
                     flexShrink: 0 }}
          >
            {/* Collapse/expand the whole Gantt panel -- same control as SimpleViewer's
                Gantt divider. Arrow points the direction the panel will move. */}
            <button
              onMouseDown={e => e.stopPropagation()}
              onClick={() => setGanttCollapsed(v => !v)}
              title={ganttCollapsed ? "Show schedule" : "Hide schedule"}
              style={{
                position: "absolute", top: "50%", left: "50%",
                transform: "translate(-50%, -50%)",
                width: 44, height: 15, lineHeight: 1, fontSize: 9,
                display: "flex", alignItems: "center", justifyContent: "center",
                cursor: "pointer", padding: 0, borderRadius: 2,
                border: "1px solid var(--line-strong)", background: "var(--paper)",
                color: "var(--ink-500)",
              }}
            >
              {ganttCollapsed ? "▲" : "▼"}
            </button>
          </div>
          {!ganttCollapsed && (
            <div style={{ height: ganttH, flexShrink: 0, minHeight: 0 }}>
              <GanttChart
                schedule={actualSchedule}
                currentDate={cd || actualSchedule.range.min}
                onDateChange={setCurrentDate}
                selectedTaskId={selectedTaskId}
                onSelectTask={selectTask}
                playing={playing}
                onTogglePlay={togglePlay}
                speed={speed}
                onSpeedChange={setSpeed}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Same checkbox-chip pattern used in SimpleViewer's toolbar.
function Flag({ label, checked, onChange, title, fontSize = 13 }) {
  return (
    <label
      title={title}
      style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize, padding: "5px 9px",
               cursor: "pointer", color: "var(--ink-600)", whiteSpace: "nowrap" }}
    >
      <span style={{
        width: 13, height: 13, display: "grid", placeItems: "center", fontSize: 9, lineHeight: 1,
        background: checked ? "var(--aar-blue)" : "var(--paper)",
        border: "1px solid " + (checked ? "var(--aar-blue)" : "var(--line-strong)"), color: "#fff",
      }}>
        {checked ? "✓" : ""}
      </span>
      {label}
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)}
             style={{ display: "none" }} />
    </label>
  );
}
