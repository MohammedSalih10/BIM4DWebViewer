// One viewer, one window. The mode switcher ("Single model" / "4D: Planned vs Actual")
// is gone: SimpleViewer does the 4D simulation, the timeline and the colour coding
// itself, so there was nothing left to switch between.
//
// IFC ONLY -- NO XML. Two inputs, both .ifc:
//   1. the PROGRESSED model, which carries the geometry and the recorded actuals;
//   2. an optional BASELINE, a plan-only export from before progress was recorded.
//
// WHY THE SECOND FILE IS UNAVOIDABLE for BL Start / BL Finish. IFC2X3's
// IfcScheduleTimeControl has ONE set of Schedule* fields, so when Synchro records
// progress it overwrites the planned dates in place -- ActualStart == ScheduleStart on
// all 45 tasks of plannedvsactual.ifc. The durations go the same way (Excavation is
// stored as 5 days: the baseline was 4 and the actual 6), which also rules out
// rebuilding the plan by re-running CPM over the surviving IfcRelSequence logic. The
// plan therefore only survives in an EARLIER export, and joining the two on activity
// code reproduces Synchro's own BL columns exactly -- verified against b2 new.xml, which
// is no longer read by the app.
//
// Optional: with no baseline the viewer still runs the full 4D build-up, it just labels
// the columns "Planned" instead of "BL" and has no variance to colour.
//
// Now unimported and safe to delete if not wanted back:
//   src/p6Xml.js, tools/check-p6-merge.mjs   the P6 XML path
//   src/Split4D.jsx                          the old side-by-side comparison
//
// LAYOUT: follows the Aarvee "4D BIM Twin" mockup's own chrome -- a dark navy header
// with the wordmark and mode tabs sitting where the mockup put "Structure / 4D
// Progress / Cost / Quality / Clash" (three real tabs here, not five decorative
// ones), and a slim brand footer. There is deliberately NO upload row here any more:
// the mockup keeps its file inputs down in the left sidebar's "Source files" list, so
// that's where the actual <input type=file> pickers live now too -- see the
// `sourceFiles` prop handed to SimpleViewer below, and its "Source files" footer.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import SimpleViewer from './SimpleViewer';
import SplitCompareView from './SplitCompareView';
import logo from './assets/RV.svg';
import { calendarDaysBetween } from './ifcSchedule';

const modeTab = (active) => ({
  display: 'flex', alignItems: 'center', gap: 7, fontFamily: 'inherit', fontSize: 12.5,
  fontWeight: active ? 600 : 500, padding: '7px 14px', border: 0, borderRadius: 'var(--r-sm)',
  background: active ? 'var(--aar-blue)' : 'transparent',
  color: active ? '#fff' : 'var(--ink-500)', whiteSpace: 'nowrap',
  // Every tab (active, inactive, disabled) carries the same light 1px outline, so the
  // three look uniform; the active one adds the glow on top.
  boxShadow: active ? 'none' : '0 0 0 1px var(--line)',
});

// One mode tab, styled like the mockup's dot-prefixed "Structure / 4D Progress / ..."
// row on its light toolbar -- a coloured square instead of an icon, a filled pill
// instead of an underline (there is no dark bar here for an underline to read against).
function ModeTab({ active, dotColor, label, onClick, disabled, title }) {
  return (
    <button
      onClick={onClick} disabled={disabled} title={title}
      style={{ ...modeTab(active), opacity: disabled ? 0.5 : 1,
               cursor: disabled ? 'not-allowed' : 'pointer' }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 2, background: dotColor, display: 'inline-block',
                     flexShrink: 0, boxShadow: active ? '0 0 0 1px rgba(255,255,255,.7)' : 'none' }} />
      {label}
    </button>
  );
}

export default function App() {
  const [model, setModel] = useState({ url: null, name: null, size: null, pickedAt: null });
  const [baseline, setBaseline] = useState({ url: null, name: null, size: null, pickedAt: null });
  // 'sim' = the default single 4D view (schedule, colour-coding, Gantt); '3d' = the
  // same viewer with all of that hidden, just the model + Contents panel + element
  // inspection; 'split' = the Planned-vs-Actual side-by-side view.
  const [mode, setMode] = useState('sim');
  // SimpleViewer's own load-progress / element-count / baseline-match line, and its
  // live schedule object -- both reported up so the header can carry a schedule
  // variance readout the way the mockup's top bar does, without SimpleViewer having
  // to know anything about the header that hosts it.
  const [viewerStatus, setViewerStatus] = useState('');
  const [schedule, setSchedule] = useState(null);

  // A blob: URL carries no filename, so the name (and size/pick time, for the "Source
  // files" row's meta line) has to travel alongside it to be shown.
  const pick = (set) => (e) => {
    const f = e.target.files[0];
    if (f) set({ url: URL.createObjectURL(f), name: f.name, size: f.size, pickedAt: new Date() });
    e.target.value = ''; // so picking the same filename again still fires onChange
  };
  const clear = (set) => () => set({ url: null, name: null, size: null, pickedAt: null });

  const canSplit = !!(model.url && baseline.url);
  // The split view mounts (and starts its own load + both panes' render setup) the
  // MOMENT both files are present, not when its tab is first opened -- same
  // always-mounted philosophy SimpleViewer already uses (see the render below: it's
  // just shown/hidden via CSS). Clicking "Planned vs Actual" used to be the moment
  // that triggered loading both files a second time AND standing up two full 3D
  // scenes, which is exactly the freeze users felt. Mounting eagerly moves that same
  // work to run quietly in the background (while display:none) as soon as the second
  // file is picked, so by the time the tab is actually clicked, there is nothing left
  // to do but flip a CSS display property. Clearing either file drops it so it
  // reloads fresh next time.
  const [splitMounted, setSplitMounted] = useState(false);
  useEffect(() => {
    setSplitMounted(canSplit);
  }, [canSplit]);

  // Header subtitle = the project's own name: the top-level heading of the task list
  // (first root task, e.g. "Sample Bridge"), so it follows whatever the schedule calls
  // its project. Falls back to the file name while no schedule is read (or the file
  // carries none), then to the empty-state text.
  const projectName = useMemo(() => {
    // SimpleViewer keeps its last schedule after both files are cleared, so ignore it
    // unless a file is actually loaded.
    const loaded = !!(model.url || baseline.url);
    const root = loaded && schedule?.hasSchedule ? schedule.tasks.get(schedule.roots?.[0]) : null;
    return root?.name?.trim() || model.name || baseline.name || 'No model loaded';
  }, [schedule, model.url, baseline.url, model.name, baseline.name]);

  // The viewer status line ("444 elements in 18 categories ... · baseline matched
  // 45/45 tasks, 44 differ from plan") gets clipped with an ellipsis in the header
  // -- there's no room to show it in full alongside the mode tabs and the finish-
  // variance badge. This lets a click on it reveal the whole string in a popover.
  //
  // Positioned `fixed`, not `absolute`, and holding its own on-screen coordinates
  // rather than relying on a `position:relative` ancestor: the header itself sets
  // overflowY:hidden (see its own comment below, on the scroll-instead-of-clip
  // behaviour), which would otherwise clip anything absolutely-positioned taller
  // than the 51px header the moment it tried to open below the button.
  const [statusPopoverPos, setStatusPopoverPos] = useState(null); // null = closed, else {top, right}
  const statusRef = useRef(null);
  const statusBtnRef = useRef(null);
  const toggleStatusPopover = () => {
    if (statusPopoverPos) { setStatusPopoverPos(null); return; }
    const r = statusBtnRef.current.getBoundingClientRect();
    setStatusPopoverPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
  };
  useEffect(() => {
    if (!statusPopoverPos) return;
    const onDocDown = (e) => {
      if (statusRef.current?.contains(e.target)) return; // the trigger button
      if (e.target.closest?.('[data-status-popover]')) return; // the popover itself
      setStatusPopoverPos(null);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [statusPopoverPos]);

  // Whole-project finish variance, for the header's own badge -- same rule
  // InsightsPanel's headline number uses (latest baseline finish across every leaf
  // task vs latest effective finish), so the two never disagree. Negative = ahead
  // of baseline (good); positive = behind baseline (bad).
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

  return (
    // No minWidth here any more: that used to force the ENTIRE page into a
    // horizontal scrollbar (drag the whole window sideways) the moment the
    // viewport got narrower than the mockup's fixed 1180px chrome. The page
    // itself never scrolls sideways now -- overflow-x is hidden -- and any
    // section that still needs more room than the window gives it (Contents,
    // Insights, the Gantt) gets its own drag-to-resize handle instead, so
    // only that one section grows/shrinks rather than the whole website.
    <div style={{
      display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr) auto', height: '100%',
      background: 'var(--paper-3)', overflowY: 'auto', overflowX: 'hidden',
    }}>
      <header style={{
        display: 'flex', alignItems: 'center', gap: 22,
        padding: '0 20px', height: 56, background: 'var(--paper)', color: 'var(--ink-700)', flexShrink: 0,
        borderBottom: '1px solid var(--line-soft)', boxShadow: 'var(--elev-1)',
        // The header has no wrap and nothing in it shrinks to nothing (logo, mode
        // tabs, badges all keep their natural width) -- on a narrow window the row
        // is simply wider than the viewport. The root container hides overflow-x
        // so the whole PAGE never scrolls sideways (see the note above), which
        // used to mean anything past the right edge here -- the mode tabs, the
        // status line, the schedule-variance badge -- was clipped and permanently
        // unreachable, not just visually cut off. Scrolling the header itself,
        // instead of the page, keeps that page-level rule intact while still
        // making every control reachable.
        overflowX: 'auto', overflowY: 'hidden', scrollbarWidth: 'thin',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0, flexShrink: 0 }}>
          <img src={logo} alt="Aarvee" style={{ height: 34, width: 'auto' }} />
          <div style={{ width: 1, height: 34, background: 'var(--line-soft)' }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            <span style={{ fontFamily: 'var(--font-body)', fontSize: 20, fontWeight: 600,
                          lineHeight: 1.1, letterSpacing: '-0.013em', whiteSpace: 'nowrap',
                          color: 'var(--logo-color)' }}>
              4D BIM Web Viewer
            </span>
            <span style={{ fontSize: 12.5, lineHeight: 1, letterSpacing: '0.08em', textTransform: 'uppercase',
                          color: 'var(--ink-400)', whiteSpace: 'nowrap' }}>
              {projectName}
            </span>
          </div>
        </div>

        <div style={{ width: 1, height: 34, background: 'var(--line-soft)', flexShrink: 0 }} />

        <nav style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
          <ModeTab
            active={mode === '3d'} dotColor="var(--ink-500)" label="3D View"
            onClick={() => setMode('3d')}
            title="Just the model: Contents panel and element inspection, with the schedule, colour-coding and Gantt chart hidden."
          />
          <ModeTab
            active={mode === 'sim'} dotColor="var(--aar-blue)" label="4D Simulation"
            onClick={() => setMode('sim')}
          />
          <ModeTab
            active={mode === 'split'} dotColor="var(--status-ahead)" label="Planned vs Actual"
            onClick={() => canSplit && setMode('split')} disabled={!canSplit}
            title={canSplit
              ? 'Side-by-side: the Planned IFC on the left, the Updated IFC on the right, each growing off its own schedule under one shared timeline.'
              : 'Load both a Planned and an Updated IFC to compare them side by side.'}
          />
        </nav>

        {/* No minWidth:0/overflow:hidden here any more -- with those set, this box
            (and the badge inside it) would shrink to nothing and disappear rather
            than push the header wider, which is exactly the "clipped and
            unreachable" failure the header's own overflow-x:auto above exists to
            fix. Letting it keep its natural width means a too-narrow window makes
            the header scroll instead. */}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
                      gap: 14 }}>
          {mode !== 'split' && viewerStatus && (
            <div ref={statusRef} style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--ink-400)',
                            whiteSpace: 'nowrap', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {viewerStatus}
              </span>
              <button
                ref={statusBtnRef}
                onClick={toggleStatusPopover}
                title="Show the full status line"
                aria-label="Show the full status line"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                         width: 16, height: 16, padding: 0, border: 0, background: 'transparent',
                         color: 'var(--ink-400)', cursor: 'pointer', fontSize: 13, letterSpacing: '-1px',
                         lineHeight: 1 }}
              >
                ⋮
              </button>
            </div>
          )}
          {mode !== '3d' && finishVariance != null && (() => {
            const varianceColor = finishVariance > 0 ? 'var(--status-delayed)'
                                 : finishVariance < 0 ? 'var(--status-ontime)' : 'var(--ink-700)';
            return (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', flexShrink: 0,
                            padding: '4px 14px', background: 'var(--paper)', borderRadius: 'var(--r-md)',
                            boxShadow: 'var(--elev-1)',
                            border: '1px solid var(--line-soft)', borderLeftWidth: 4, borderLeftColor: varianceColor }}>
                <span style={{ fontSize: 10.5, letterSpacing: '0.1em', textTransform: 'uppercase',
                              fontWeight: 600, color: 'var(--ink-500)' }}>
                  Finish variance
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 700,
                              color: varianceColor }}>
                  {finishVariance > 0 ? `+${finishVariance}d` : finishVariance < 0 ? `${finishVariance}d` : '0d'}
                </span>
              </div>
            );
          })()}
        </div>
      </header>

      {/* Rendered here, as a sibling of the header rather than nested inside it, and
          positioned `fixed` with explicit viewport coordinates -- see the note above
          `statusPopoverPos` on why an absolutely-positioned popover nested in the
          header never actually became visible. */}
      {statusPopoverPos && (
        <div data-status-popover style={{
          position: 'fixed', top: statusPopoverPos.top, right: statusPopoverPos.right, zIndex: 1000,
          width: 380, maxWidth: '80vw', background: 'var(--paper)', border: '1px solid var(--line-soft)',
          boxShadow: '0 4px 16px rgba(0,0,0,.2)', padding: '10px 12px',
          fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--ink-700)',
          whiteSpace: 'normal', wordBreak: 'break-word', lineHeight: 1.5,
        }}>
          {viewerStatus}
        </div>
      )}

      <div style={{ minHeight: 0, minWidth: 0, position: 'relative' }}>
        {/* Both views stay MOUNTED once they exist and are just shown/hidden. Switching
            tabs used to unmount one viewer and mount the other, which threw away the
            parsed IFC and re-parsed it every time -- that was the lag. The split view is
            created lazily the first time its tab is opened (so it costs nothing until
            then) and dropped again if either file is cleared. */}
        {splitMounted && canSplit && (
          <div style={{ height: '100%', display: mode === 'split' ? 'block' : 'none' }}>
            <SplitCompareView plannedUrl={baseline.url} actualUrl={model.url} />
          </div>
        )}
        <div style={{ height: '100%', display: mode === 'split' && canSplit ? 'none' : 'block' }}>
          {/* With only the Planned IFC picked, it becomes the primary model -- same 4D
              build-up as picking only the Updated IFC, just off its own (planned) dates
              since there is no progress to compare against. The baseline merge only
              makes sense once BOTH files are present. */}
          <SimpleViewer ifcUrl={model.url || baseline.url}
                        baselineUrl={model.url && baseline.url ? baseline.url : null}
                        onStatusChange={setViewerStatus}
                        onScheduleChange={setSchedule}
                        viewMode={mode === '3d' ? '3d' : '4d'}
                        sourceFiles={[
                          {
                            label: 'Planned IFC', dotColor: 'var(--ink-700)', file: baseline, accept: '.ifc',
                            onPick: pick(setBaseline), onClear: clear(setBaseline),
                            tooltip: 'The PLANNED export, taken after planning and BEFORE any progress was recorded. Matched to the updated file on activity code -- the only source of true BL Start / BL Finish, because recording progress overwrites the planned dates in place. Optional: without it the viewer still runs the 4D build-up, it just has no variance to colour.',
                          },
                          {
                            label: 'Updated IFC', dotColor: 'var(--aar-blue)', file: model, accept: '.ifc',
                            onPick: pick(setModel), onClear: clear(setModel),
                            tooltip: 'The UPDATED export: the current Synchro IFC, with progress recorded. Supplies the geometry, the Actual Start/Finish of completed activities, and the current Start/Finish of everything still to come.',
                          },
                        ]} />
        </div>
      </div>

      <footer style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
        padding: '0 16px', height: 30, background: 'var(--aar-blue-tint)',
        borderTop: '1px solid var(--line-strong)', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img src={logo} alt="" style={{ height: 18, width: 'auto' }} />
          <span style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--ink-700)', letterSpacing: '0.01em' }}>
            Aarvee Engineering Consultants Limited
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--ink-600)' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%',
                        background: model.url || baseline.url ? 'var(--status-ontime)' : 'var(--ink-300)',
                        display: 'inline-block' }} />
          {model.url || baseline.url ? 'Model synced' : 'No model loaded'}
        </div>
      </footer>
    </div>
  );
}
