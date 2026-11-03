import React, { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { IFCLoader } from "web-ifc-three/IFCLoader";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import {
  collectElements, applyNamePalette, toRealistic, makeMaterial, makeStatusMaterial,
  HIGHLIGHT, PROGRESS, STATUS_LIGHTING, REALISTIC_LIGHTING, cssColor,
} from "./ifcMaterials";
import { collectBuildingElements } from "./ifcElements";
import {
  readSchedule, elementStatusAt, withBaseline, taskStatusAt,
  TASK_STATUS, STATUS_ORDER,
} from "./ifcSchedule";
import { buildingFrameBox, frameCamera, makeShadowGround } from "./viewFraming";
import GanttChart from "./GanttChart";
import UpcomingActivities from "./UpcomingActivities";
import ColorCodingSettings from "./ColorCodingSettings";
import FloatingViewControls, { DisplayRow, DisplaySection, VpIcon, VP_ICONS } from "./ViewportControls";
import ElementDetailsDialog from "./ElementDetailsDialog";
import InsightsPanel from "./InsightsPanel";
import { fetchElementDetails } from "./elementDetails";

// Field-by-field compare for the status-counts object the simulation effect rebuilds
// every playback tick -- `tasks`/`elements` are flat { [status]: count } objects keyed
// by STATUS_ORDER, so a handful of key lookups is all a real equality check needs.
function countsEqual(a, b) {
  if (a.natural !== b.natural || a.builtUnique !== b.builtUnique || a.notYetBuilt !== b.notYetBuilt) return false;
  for (const k of STATUS_ORDER) {
    if (a.tasks[k] !== b.tasks[k] || a.elements[k] !== b.elements[k]) return false;
  }
  return true;
}

// "12.3 MB" etc, for the Contents panel's "Source files" footer -- the same rounding
// App.jsx's own fmtSize uses, kept as a second copy rather than a shared import since
// it's four lines and pulling in a whole module for it would be overkill.
function fmtBytes(bytes) {
  if (bytes == null) return "";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// Drag-to-resize range for the Contents ("Model layers") sidebar -- mirrors
// InsightsPanel's own MIN_W/MAX_W/DEFAULT_W so the two side panels feel consistent.
const CONTENTS_MIN_W = 220;
const CONTENTS_MAX_W = 520;
const CONTENTS_DEFAULT_W = 288;

// Milliseconds between simulation frames. This is the frame RATE, not the speed --
// speed is days-per-frame and belongs to the user, on the Gantt toolbar's -/+ control.
// 120ms is about as fast as this can usefully tick: every frame rewrites the IFC
// subsets for 444 elements, so a shorter interval buys smoothness the rebuild cannot
// keep up with. Change the SPEED_STEPS ladder, not this, to alter how fast time moves.
const TICK_MS = 120;

// The app's own traffic-light colours, as "#rrggbb" -- the starting point for the
// per-user override in ColorCodingSettings, and what "Reset to defaults" goes back to.
const DEFAULT_STATUS_COLORS = Object.fromEntries(
  STATUS_ORDER.map(k => [k, cssColor(TASK_STATUS[k].color)])
);

// viewMode: "4d" (default) shows the schedule/colour-coding/Gantt chrome; "3d" hides
// all of it and leaves just the model, the Contents panel and element inspection --
// the model, schedule and 3D scene are still loaded exactly the same either way, this
// only changes what the toolbar and the bottom panel show.
export default function SimpleViewer({
  ifcUrl, baselineUrl, onStatusChange, onScheduleChange, viewMode = "4d",
  // [{ label, dotColor, file: {name,size}, accept, onPick, onClear, tooltip }] -- the
  // Planned/Updated IFC slots App.jsx owns the state for. Rendered here, at the
  // bottom of the Contents panel, so both the "what is this model built from" list
  // AND the actual <input type=file> pickers sit where the mockup put them (the left
  // sidebar's "Source files" section) instead of a big upload row above the viewport.
  sourceFiles = [],
}) {
  const containerRef = useRef();
  const viewportRef = useRef();   // the 3D area incl. its floating controls -- what Fullscreen expands
  const dataRef = useRef(null);   // Three.js + IFC state; deliberately NOT useState
  const edgesRef = useRef(null);   // Map<key, LineSegments> -- one outline group per task, plus "unscheduled"
  const playRef = useRef(null);

  const [status, setStatus] = useState("Waiting for file...");
  // The building-element tree from ifcElements.js. Materials still drive the
  // colours, but the panel lists elements, not materials.
  const [contents, setContents] = useState(null);
  const [groupBy, setGroupBy] = useState("category"); // 'category' | 'level'
  const [selected, setSelected] = useState(null);     // { key, label, ids } | null
  const [collapsed, setCollapsed] = useState({});
  const [search, setSearch] = useState("");
  const [showEdges, setShowEdges] = useState(true);
  // Contents used to be a permanent 300px column that ate into the 3D view's width.
  // It's now a floating overlay (like Upcoming activities already was) so the 3D
  // viewer can run full width, directly above the Gantt chart -- scrubbing the
  // timeline and watching the model update no longer means looking across a sidebar.
  const [showContents, setShowContents] = useState(true);

  // 4D simulation state.
  const [schedule, setSchedule] = useState(null);
  // The 4D simulation IS the planned-vs-actual view -- there is no separate mode. While
  // it runs, work that has started or finished is tinted by its traffic-light status;
  // everything else -- not yet started, or with no activity at all -- is drawn in its
  // own true colour, fully opaque. Nothing is ever faded or hidden. See the simulation
  // effect for the two buckets that produces.
  const [simulate, setSimulate] = useState(false);
  // OFF reverts the tinted (bucket 3) elements to their own material colour too, so the
  // build-up still grows on schedule but nothing is judged red/green/yellow/blue.
  const [showStatusColors, setShowStatusColors] = useState(true);
  // User-picked overrides for the traffic-light colours -- "system colours" (no
  // colour coding at all) is what showStatusColors=false already means, so this only
  // customises the colours used WHEN colour coding is on.
  const [statusColors, setStatusColors] = useState(DEFAULT_STATUS_COLORS);
  const [colourTerrain, setColourTerrain] = useState(false);
  const [statusCounts, setStatusCounts] = useState(null);
  // Legend chip click = isolate that status in the 3D view (null = show everything).
  const [statusFilter, setStatusFilter] = useState(null);
  const [noRealVariance, setNoRealVariance] = useState(false);
  // The baseline is merged by its OWN effect, so its outcome cannot live in the load
  // effect's status string. Appended to `status` when rendered.
  const [baseNote, setBaseNote] = useState("");
  // Bumped when a model has finished loading and dataRef.current is fully populated.
  // The baseline effect waits on this: it needs d.loader, and effects do not await.
  const [modelEpoch, setModelEpoch] = useState(0);
  // Bumped when the (deferred, time-sliced) edge outlines finish, so the visibility effect re-runs.
  const [edgesEpoch, setEdgesEpoch] = useState(0);
  const [currentDate, setCurrentDate] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);              // days advanced per tick
  const [selectedTaskId, setSelectedTaskId] = useState(null);
  const [ganttH, setGanttH] = useState(300);
  // Collapses the Gantt panel down to just its divider bar, handing its height back
  // to the 3D viewport above (flex:1 there picks up the slack automatically -- see
  // the arrow button on the divider, below). Independent of ganttH: expanding again
  // restores whatever height was last set, rather than resetting to a default.
  const [ganttCollapsed, setGanttCollapsed] = useState(false);
  // Drag-to-resize width of the Contents sidebar, same pattern as the Gantt's height
  // divider below and InsightsPanel's own left-edge handle.
  const [contentsW, setContentsW] = useState(CONTENTS_DEFAULT_W);
  const [contentsResizing, setContentsResizing] = useState(false);
  // A forward-looking lookahead list, independent of the 4D simulation toggle above --
  // it reads the plan, not recorded progress, so it stays useful even with `simulate`
  // off (see UpcomingActivities.jsx for why it needs its own colour palette).
  const [showUpcoming, setShowUpcoming] = useState(false);
  // The right-hand analytics dock (stats, progress-by-category, the planned-vs-actual
  // S-curve) -- see InsightsPanel.jsx. On by default in 4D Simulation, matching the
  // mockup's own data panel being open out of the box; irrelevant in 3D View, which
  // hides all schedule chrome the same way it hides the Gantt.
  const [showInsights, setShowInsights] = useState(true);
  // The colour used to highlight whatever is selected (Contents panel node, or a
  // clicked Gantt/Upcoming task). Independent of `statusColors` below -- this has
  // nothing to do with the 4D simulation, it's on whenever anything is selected.
  // Defaults to HIGHLIGHT's own blue, but the user can repick any shade they like.
  const [highlightColor, setHighlightColor] = useState(cssColor(HIGHLIGHT.color));
  // The "element details" dialog's data -- populated for a 3D click or a Contents-tree
  // selection (see the fetch effect below), never for a Gantt selection. A tree node
  // spanning many elements shows a group summary (its activity only if they all share
  // one), as there is no single set of properties for "all windows".
  const [pickedDetails, setPickedDetails] = useState(null);

  // Back to the defaults the toggles start with.
  const resetDisplay = () => {
    setShowStatusColors(true); setShowUpcoming(false); setColourTerrain(false);
    setShowEdges(true); setShowInsights(true);
  };

  // Reports the load-progress / element+schedule counts / baseline-match line up to
  // App.jsx, which renders it in the IFC upload row's blank space instead of this
  // component giving it a whole extra full-width row of its own above the viewport.
  useEffect(() => {
    onStatusChange?.(`${status}${baseNote}`);
  }, [status, baseNote, onStatusChange]);

  // Lifts the live schedule object up to App.jsx, purely so its header can show a
  // schedule-variance badge (the mockup's own top-bar chip) without SimpleViewer
  // knowing anything about the header that hosts it.
  useEffect(() => {
    onScheduleChange?.(schedule);
  }, [schedule, onScheduleChange]);

  useEffect(() => {
    if (!ifcUrl || !containerRef.current) return;
    const container = containerRef.current;
    container.innerHTML = "";
    setStatus("Setting up scene...");
    setContents(null); setSelected(null); setSearch(""); setCollapsed({});
    setSchedule(null); setSimulate(false); setPlaying(false);
    setCurrentDate(null); setSelectedTaskId(null);
    setStatusCounts(null); setColourTerrain(false);
    setNoRealVariance(false); setBaseNote(""); setShowUpcoming(false);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xdbe7f0);

    const camera = new THREE.PerspectiveCamera(60, container.clientWidth / container.clientHeight, 0.1, 10000);
    camera.position.set(10, 10, 10);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    // At least 1.5x: on standard-density screens this supersamples, which is what makes
    // thin edge lines and element borders read crisply instead of shimmering.
    renderer.setPixelRatio(Math.min(Math.max(window.devicePixelRatio || 1, 1.5), 2));
    // Without this, three r149 treats the IFC's sRGB colors as linear and the
    // whole model washes out.
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    // Image-based lighting: soft realistic bounce that a single AmbientLight can't
    // fake. Only affects MeshStandardMaterial, which is why the Lambert swap matters.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envRT.texture;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    const sun = new THREE.DirectionalLight(0xfff5e6, REALISTIC_LIGHTING.sunIntensity);
    sun.castShadow = true;
    scene.add(sun, sun.target);
    // Kept in a variable because planned-vs-actual mode re-exposes the scene: status
    // materials are not tone mapped, so they need much calmer light to hold their hue.
    const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x8a7f6d, REALISTIC_LIGHTING.hemiIntensity);
    scene.add(hemi);

    let running = true;
    (function animate() {
      if (!running) return;
      // Hidden view (display:none, e.g. the other tab): keep the loop alive but skip
      // the work -- clientWidth is 0 there, so nothing is drawn until it is shown again.
      if (container.clientWidth && container.clientHeight) {
        controls.update();
        renderer.render(scene, camera);
      }
      requestAnimationFrame(animate);
    })();

    let ground = null;

    (async () => {
      try {
        setStatus("Creating IFCLoader...");
        // Let the browser paint the picked file name / status before the parse below
        // blocks the main thread -- otherwise the page freezes the instant a file is chosen.
        await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
        if (!running) return;
        const loader = new IFCLoader();
        await loader.ifcManager.setWasmPath("/wasm/");

        setStatus("Loading IFC (large files take a while)...");
        const model = await loader.loadAsync(ifcUrl);
        // NOT model.modelID -- see the note in SplitCompareView.jsx. IFCModel's own
        // modelID comes from a module-global counter shared by every IFCLoader ever
        // used on the page, while `state.models` is keyed by this loader's own,
        // independent, per-instance index. They only coincide if this is the very
        // first model ever loaded anywhere on the page; a second file picked into
        // this same picker, or any earlier split-view use, throws that off. This
        // loader is fresh and loads exactly one model, so its `state.models` has
        // exactly one entry and that entry's key is the only trustworthy id.
        const modelID = Number(Object.keys(loader.ifcManager.state.models)[0]);
        scene.add(model);

        // Decide up front whether the file supplied usable colors of its own.
        const uniqueColors = new Set();
        model.traverse(child => {
          if (!child.isMesh) return;
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          for (const m of mats) uniqueColors.add(m.color.getHexString());
        });
        setStatus("Reading materials...");
        const { allIds, buckets } = await collectElements(loader, model, modelID);

        // The terrain and hard landscaping: one 80x85m surface plus scattered paving.
        // Excluded from camera framing (it dwarfs the 35m building) and, by default,
        // from status colouring -- see the note in the simulation effect.
        const siteIds = new Set(buckets.get("site")?.ids || []);

        // Colored subsets, or the file's own colors if it has any.
        let paletteMeshes = new Map();
        let colorNote;
        if (uniqueColors.size <= 1) {
          paletteMeshes = applyNamePalette(loader, model, modelID, scene, buckets);
          colorNote = `no colors in file - ${buckets.size} inferred materials`;
        } else {
          model.traverse(child => {
            if (!child.isMesh) return;
            child.castShadow = true;
            child.receiveShadow = true;
            child.material = Array.isArray(child.material)
              ? child.material.map(toRealistic)
              : toRealistic(child.material);
          });
          colorNote = `using the file's own ${uniqueColors.size} colors`;
        }

        // The panel contents. A separate pass from the material one above, because
        // "what element is this" and "what is it made of" come from different parts
        // of the file -- see the header comment in ifcElements.js.
        setStatus("Reading building elements...");
        const elements = await collectBuildingElements(loader, model, modelID);
        setContents(elements);
        // A Synchro export has one fake storey, so the level view is only worth
        // offering when the file really does carry more than one.
        setGroupBy(elements.levelCount > 1 ? "level" : "category");

        setStatus("Reading 4D schedule...");
        let sched = null;
        try {
          sched = await readSchedule(loader, modelID);
        } catch (e) {
          console.warn("Failed to read the schedule:", e);
        }
        // The baseline is NOT merged here -- see the dedicated effect below. Merging it
        // in this effect meant baselineUrl had to be a dependency, so picking a baseline
        // tore down the scene and re-parsed the whole 53MB model for dates that take
        // milliseconds to read.
        if (!running) return;
        setSchedule(sched);
        if (sched?.hasSchedule && sched.range) {
          // Start at the end of the schedule, so the first thing on screen is the
          // finished building -- same as before this panel existed. Play rewinds.
          setCurrentDate(sched.range.max);
        }

        const schedNote = sched?.hasSchedule
          ? `${sched.tasks.size} tasks, ${sched.links.length} links, ` +
            `${sched.criticalIds.size} on the critical path`
          : "no schedule in file";

        setStatus(
          `${allIds.length} elements in ${elements.categoryTree.length} categories` +
          (elements.levelCount > 1 ? ` across ${elements.levelCount} levels` : "") +
          ` · ${colorNote} · ${schedNote}.`
        );

        // The palette subsets' own materials, so the 4D simulation can rewrite those
        // same subsets per date instead of creating a second set of meshes.
        const paletteMats = paletteMeshes.size > 0
          ? new Map([...paletteMeshes.entries()].map(([k, mesh]) => [k, mesh.material]))
          : null;

        // Solid traffic-light materials, opaque. Statuses must be unmistakable in the
        // simulation: red / green / yellow / blue are the requested schedule result,
        // not a 60% tint that can be mistaken for the original material colour.
        const statusMats = {};
        // Seeded from whatever colours are current when this file finishes loading;
        // later picks are applied in place by the effect below, not by reloading.
        for (const k of STATUS_ORDER) statusMats[k] = makeStatusMaterial(statusColors[k]);

        // STALE-LOAD GUARD. Loading 53MB takes ~30s, and nothing cancels an in-flight
        // load -- the cleanup below only flips `running`. Without this check a load that
        // was superseded still runs to completion and overwrites dataRef.current with
        // ITS scene: one whose renderer is disposed, whose environment map has been
        // released, and whose canvas was removed from the DOM. Every later subset draw
        // then goes to that dead scene, so the live one keeps only the bare white mesh
        // and loses every coloured palette subset. That is the "everything goes into
        // shade, only the white building is left" failure.
        if (!running) {
          try { loader.ifcManager.dispose(); } catch (e) { /* already torn down */ }
          return;
        }

        dataRef.current = {
          loader, modelID, model, scene, buckets, paletteMats, allIds,
          siteIds, sun, hemi, statusMats,
          activeSubsets: new Map(),   // customID -> material, for cheap stale clearing
          highlightMat: makeMaterial(HIGHLIGHT),
          progressMat: makeMaterial(PROGRESS),
          schedule: sched,
          // The model's OWN schedule, kept unmerged so the baseline effect can re-merge
          // from a clean base (and revert cleanly when the baseline is cleared).
          rawSchedule: sched,
        };

        // Real geometric edges (not a screen-space effect), so they stay crisp at any
        // zoom. thresholdAngle=25 keeps corners and outlines but skips the interior
        // triangulation of curved surfaces.
        //
        // ONE OUTLINE PER TASK, not one for the whole model -- so Edges can track the
        // 4D build-up instead of having to go dark the moment it starts. A single
        // whole-model EdgesGeometry has no idea which triangles belong to work that
        // hasn't been reached yet, so simply leaving it visible during playback would
        // draw the finished building's outline around a half-built one -- exactly the
        // spoiler the visibility effect below is built to avoid. Grouping by task (the
        // same grouping the 4D simulation's own "reached" test uses -- see that effect)
        // means each outline can be shown or hidden in lockstep with the elements it
        // traces, no per-frame recomputation needed. Elements with no task at all
        // (terrain, anything unclassified) get one more group that's always visible,
        // matching the simulation's own "not scheduled -> always drawn" rule.
        // The edge outlines are the slowest synchronous part of a load (one createSubset +
        // EdgesGeometry per task), and nothing needs them to show the model -- so they are
        // built AFTER the model is on screen, in ~12ms slices, instead of before it.
        const buildAllEdges = async () => {
        const vertCount = model.geometry?.attributes?.position?.count ?? 0;
        if (vertCount > 0 && vertCount < 3000000) {
          const edgeGroups = new Map(); // key -> LineSegments; key is `task-<id>` or "unscheduled"
          // Published straight away and filled in as slices finish, so the effect cleanup can
          // dispose whatever exists if the model is swapped out mid-build.
          edgesRef.current = edgeGroups;
          let lastYield = performance.now();
          const edgeMaterial = () =>
            new THREE.LineBasicMaterial({ color: 0x1f2a33, transparent: true, opacity: 0.7 });

          // Builds one LineSegments outline from exactly `ids`' geometry. Goes through
          // createSubset/removeSubset purely as a way to get a triangle-indexed
          // BufferGeometry restricted to those ids -- web-ifc-three has no other way to
          // slice the merged model geometry by expressID. The subset mesh itself is
          // discarded immediately; only the EdgesGeometry computed from it is kept.
          const buildEdgesFor = (ids, key) => {
            if (!ids.length) return;
            const tempID = `__edge_tmp_${key}`;
            try {
              const subset = loader.ifcManager.createSubset({
                modelID, ids, customID: tempID, removePrevious: true,
              });
              if (!subset?.geometry?.attributes?.position?.count) return;
              const lines = new THREE.LineSegments(new THREE.EdgesGeometry(subset.geometry, 25), edgeMaterial());
              lines.visible = false; // the visibility effect sets the real value
              scene.add(lines);
              edgeGroups.set(key, lines);
            } catch (e) {
              console.warn("edge outline failed for", key, e);
            } finally {
              try { loader.ifcManager.removeSubset(modelID, undefined, tempID); } catch (e) { /* never created */ }
            }
          };

          const scheduledIds = new Set();
          if (sched?.hasSchedule) {
            for (const task of sched.tasks.values()) {
              if (task.isSummary || !task.elementIds.length) continue;
              if (!running) return;
              buildEdgesFor(task.elementIds, `task-${task.id}`);
              // Time-slice: hand the thread back every ~12ms so the UI keeps responding.
              if (performance.now() - lastYield > 12) { await new Promise(r => setTimeout(r, 0)); lastYield = performance.now(); }
              for (const id of task.elementIds) scheduledIds.add(id);
            }
          }
          // Everything with no task -- the whole model when there is no schedule at all,
          // which is exactly the old single-outline behaviour in that case.
          if (!running) return;
          buildEdgesFor(allIds.filter(id => !scheduledIds.has(id)), "unscheduled");

          if (running) setEdgesEpoch(e => e + 1);
        } else {
          console.warn(`Skipping edges - ${vertCount} vertices is too many to outline safely.`);
        }
        };

        // Frame the BUILDING, not the site. This used to fit the whole model's bounding
        // box, which on this project is 80.6 x 85.4 because of the terrain and the
        // planting scattered across the plot -- it left the building a speck in the
        // middle of the viewport. Same helper the split view uses.
        const { frame: fBox, full } = buildingFrameBox(model, siteIds, "SimpleViewer");
        if (!fBox.isEmpty()) {
          // Frame on the building, but fit the shadows to the WHOLE model -- otherwise
          // only the middle third of the terrain receives any.
          const { center, radius } = frameCamera({ camera, controls, sun }, fBox, full);
          if (dataRef.current) {
            dataRef.current.fitView = () => frameCamera({ camera, controls, sun }, fBox, full);
          }
          // A shadow-catcher plane ONLY when the file has no ground of its own. With a
          // terrain present the plane catches the terrain's own shadow and draws it as
          // a second, offset footprint -- see makeShadowGround's comment.
          if (siteIds.size === 0) {
            ground = makeShadowGround(center, radius, full.min.y);
            scene.add(ground);
          }
        } else {
          console.warn("Bounding box is empty - no visible geometry.");
        }

        // Everything in dataRef.current is now populated, so the baseline effect can
        // safely reach for d.loader. It cannot simply await this effect, hence the flag.
        if (running) setModelEpoch(e => e + 1);
        buildAllEdges();
      } catch (err) {
        console.error("IFC load failed:", err);
        if (running) setStatus("FAILED: " + (err?.message ?? String(err)));
      }
    })();

    const onResize = () => {
      if (!container.clientWidth || !container.clientHeight) return;
      renderer.setSize(container.clientWidth, container.clientHeight);
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
    };
    // A ResizeObserver, not just a window listener: dragging the Gantt panel taller
    // resizes the viewport without the window ever changing size, and a plain
    // resize listener would leave the canvas stretched.
    const ro = new ResizeObserver(onResize);
    ro.observe(container);
    window.addEventListener("resize", onResize);

    // Click-to-select in the 3D view itself: pick whatever's under the pointer and
    // drive it through the SAME `selected` state the Contents panel and Gantt already
    // use, so it gets the same blue highlight overlay and the same "Clear selection".
    const raycaster = new THREE.Raycaster();
    const pointerNdc = new THREE.Vector2();
    let downAt = null;
    const onPointerDown = (e) => { downAt = { x: e.clientX, y: e.clientY }; };
    const onClick = (e) => {
      // OrbitControls listens on this same canvas, and a native "click" still fires on
      // mouseup even after an orbit/pan drag -- only treat it as a pick if the pointer
      // barely moved between down and up.
      const moved = downAt && ((e.clientX - downAt.x) ** 2 + (e.clientY - downAt.y) ** 2 > 25);
      downAt = null;
      if (moved) return;

      const d = dataRef.current;
      if (!d) return;

      const rect = renderer.domElement.getBoundingClientRect();
      pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointerNdc, camera);

      // Raycaster.intersectObjects does NOT check `.visible` on its own -- it would
      // happily report a hit on the hidden merged `model`, which always carries every
      // element's full geometry (including ones the 4D simulation hasn't built yet, or
      // whatever the palette hid behind its coloured subsets). Only test what the user
      // can actually see.
      const pickable = scene.children.filter(
        o => o.isMesh && o.visible && o.geometry?.attributes?.expressID
      );
      const hit = raycaster.intersectObjects(pickable, false)[0];
      if (!hit) { setSelected(null); return; }

      const id = hit.object.geometry.attributes.expressID.getX(hit.face.a);
      let label = `Element #${id}`;
      try {
        const line = d.loader.ifcManager.state?.api?.GetLine(d.modelID, id);
        label = line?.Name?.value || line?.ObjectType?.value || label;
      } catch (err) { /* unnamed -- keep the fallback label */ }
      setSelected({ key: `pick-${id}`, label, ids: [id], source: "pick" });
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("click", onClick);

    return () => {
      running = false;
      ro.disconnect();
      window.removeEventListener("resize", onResize);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("click", onClick);
      controls.dispose();
      envRT.texture.dispose();
      pmrem.dispose();
      if (ground) { ground.geometry.dispose(); ground.material.dispose(); }
      if (edgesRef.current) {
        for (const lines of edgesRef.current.values()) {
          lines.removeFromParent();
          lines.geometry.dispose();
          lines.material.dispose();
        }
        edgesRef.current = null;
      }
      renderer.dispose();
      // dispose() only frees resources the renderer tracks (programs, textures) -- it
      // does NOT release the underlying WebGL context, which stays alive tied to the
      // (now detached) canvas until garbage collection gets around to it. Every pick of
      // a new file, and every trip through "Planned vs Actual" (which mounts two MORE
      // WebGLRenderers in Viewport3D), creates another one of these. Chromium caps a
      // page at a small number of live contexts (historically ~16); once that cap is
      // hit it force-loses the OLDEST context to make room, which can be a viewer that
      // is still on screen -- draw calls after a context loss silently no-op, so the
      // scene graph looks intact (right element/index counts) but nothing paints except
      // whatever was already rasterized, which is how a fully-built model can render as
      // bare edges (a separate LineSegments draw call for that one still lands while
      // subset meshes lost their bound buffers). forceContextLoss() frees the context
      // immediately instead of waiting on GC, so switching views repeatedly never
      // accumulates enough live contexts to hit that cap.
      renderer.forceContextLoss();
      dataRef.current = null;
    };
    // ONLY the model. baselineUrl must NOT be here: it would tear the scene down and
    // re-parse 53MB of geometry to pick up a handful of dates. The baseline effect below
    // merges them in place instead.
  }, [ifcUrl]);

  // Merges the baseline IFC into the loaded model's schedule, IN PLACE -- no scene
  // teardown, no geometry reload. Only the schedule is read from the baseline: opening
  // it through the raw web-ifc api parses the STEP data without building any geometry,
  // so a second 53MB file costs well under a second.
  //
  // This is what turns the date columns into BL Start / BL Finish. The baseline's
  // schedule dates are the only surviving copy of the plan -- see the note in App.jsx
  // for why a progressed export cannot supply them.
  useEffect(() => {
    const d = dataRef.current;
    if (!d?.rawSchedule?.hasSchedule) return;
    let cancelled = false;

    // Applied for both outcomes, so clearing the baseline reverts cleanly rather than
    // leaving the merged dates on screen with no file behind them.
    const apply = (sched, note) => {
      if (cancelled) return;
      d.schedule = sched;
      setSchedule(sched);
      setBaseNote(note);
      // Whether ANY slipped activity owns geometry. That, not the raw variance count,
      // is what decides if red or yellow can ever appear on the model.
      setNoRealVariance(![...sched.tasks.values()].some(
        t => !t.isSummary && t.varianceDays !== 0 && t.elementIds.length > 0));
      // The merged span can reach further than the model's own, so re-anchor the
      // playhead at the end rather than leaving it mid-timeline.
      if (sched.range) setCurrentDate(sched.range.max);
    };

    if (!baselineUrl) { apply(d.rawSchedule, ""); return; }

    (async () => {
      setBaseNote(" · reading baseline...");   // replaced by apply() either way
      let baseID = null;
      try {
        const api = d.loader.ifcManager.state?.api;
        const buf = new Uint8Array(await (await fetch(baselineUrl)).arrayBuffer());
        if (cancelled) return;
        baseID = await api.OpenModel(buf);
        const base = await readSchedule(d.loader, baseID);
        if (cancelled) return;
        if (base?.hasSchedule) {
          const merged = withBaseline(d.rawSchedule, base);
          if (!merged.hasBaseline) {
            // Matched nothing: almost always a file from a different project, or a
            // geometry-only export whose tasks carry no activity codes.
            apply(d.rawSchedule,
              ` · baseline IGNORED: no activity codes matched this model` +
              ` (${base.tasks.size} tasks in the baseline file)`);
          } else {
            const unmatched = merged.tasks.size - merged.baselineMatched;
            apply(merged,
              ` · baseline matched ${merged.baselineMatched}/${merged.tasks.size} tasks` +
              (unmatched ? `, ${unmatched} unmatched` : "") +
              `, ${merged.baselineMoved} differ from plan` +
              (merged.baselineActuals
                ? ` · WARNING: baseline file has actuals on ${merged.baselineActuals}` +
                  ` tasks, so it is not a clean plan-only export and variance is understated`
                : ""));
          }
        } else {
          apply(d.rawSchedule, " · baseline file has no schedule, ignored");
        }
      } catch (e) {
        console.warn("Failed to read the baseline schedule:", e);
        apply(d.rawSchedule, " · baseline could not be read (see console)");
      } finally {
        // Always close it: the dates have been copied out, and a 53MB STEP model left
        // open in WASM memory alongside the main one is pure waste.
        try { if (baseID != null) d.loader.ifcManager.state.api.CloseModel(baseID); }
        catch (e) { /* already gone */ }
      }
    })();

    return () => { cancelled = true; };
  }, [baselineUrl, modelEpoch]);

  // Highlights the picked element group in orange, ON TOP of the model -- nothing
  // else is touched. Every node in the tree carries its own express IDs, so this
  // works the same whether you clicked a level, a category, a single type in the
  // Contents panel, or a task in the Gantt/Upcoming activities.
  //
  // Used to also ghost (fade to 12% opacity) everything else so the highlighted
  // group stood out spatially. The user asked for that removed: a task that owns a
  // small slice of the model (e.g. "Facade works" owning a handful of glazing
  // panels) was fading out ~99% of the building, which read as broken rather than
  // helpful. The orange overlay alone is still enough to see where the selection is.
  useEffect(() => {
    const d = dataRef.current;
    if (!d) return;

    const ids = selected?.ids ?? [];

    try {
      d.loader.ifcManager.createSubset({
        modelID: d.modelID, ids, material: d.highlightMat,
        scene: d.scene, removePrevious: true, customID: "highlight",
      });
    } catch (e) {
      console.warn("highlight subset failed:", e);
    }
  }, [selected]);

  // Keeps the Gantt's highlighted row in sync with whatever got selected some OTHER
  // way -- a Contents panel node, or a click in the 3D view. Selecting a TASK already
  // sets `selectedTaskId` directly (see selectTask) and tags `selected.source` so this
  // effect skips it, leaving that direction alone.
  //
  // Going the other way is a many-to-one lookup: `taskOfElement` maps a single element
  // to the one task that builds it, but a Contents panel node can span many elements
  // across many different tasks (e.g. the "Windows" category), so there is no single
  // task to highlight unless every selected element happens to agree on the same one.
  useEffect(() => {
    if (!schedule?.taskOfElement) return;
    if (selected?.source === "task") return;

    const ids = selected?.ids;
    if (!ids || ids.length === 0) { setSelectedTaskId(null); return; }

    let taskId, ambiguous = false;
    for (const id of ids) {
      const t = schedule.taskOfElement.get(id);
      if (t === undefined) continue;               // this element has no task -- ignore it
      if (taskId === undefined) taskId = t;
      else if (taskId !== t) { ambiguous = true; break; }
    }
    setSelectedTaskId(ambiguous || taskId === undefined ? null : taskId);
  }, [selected, schedule]);

  // element id -> { level, category }, read straight off the Contents tree (level ->
  // category -> type) so the 3D View's details dialog needs no extra IFC reads.
  const placeOfElement = useMemo(() => {
    const m = new Map();
    for (const lvl of contents?.levelTree || []) {
      for (const cat of lvl.children) {
        for (const id of cat.ids) m.set(id, { level: lvl.label, category: cat.label });
      }
    }
    return m;
  }, [contents]);

  // Populates the "element details" dialog for a 3D click or a Contents-tree selection
  // (Gantt selections don't open it -- the Gantt already shows the task). Runs async
  // because IFC property sets are only readable through the loader's own promises;
  // `cancelled` guards against a second click landing before the first one's fetch
  // finishes, or the model changing out from under an in-flight request.
  useEffect(() => {
    const d = dataRef.current;
    if (!d || (selected?.source !== "pick" && selected?.source !== "contents")) {
      setPickedDetails(null);
      return;
    }

    // Contents-tree node covering several elements: no single element to read, so
    // summarise the group instead. The activity is shown only when every element that
    // has one agrees on it (same rule as the task-highlight effect above); otherwise
    // the dialog says the group spans several activities.
    // 3D View shows no dates: `timeless` makes the dialog render only Name / Category /
    // Level / Activity (the linked task's name). The schedule is still consulted, but
    // only its name is displayed there.
    const timeless = viewMode !== "4d";
    const sched = schedule;

    // Name / category / level for the 3D View dialog. A group shows a value only when
    // all its elements agree, otherwise "Multiple (n)".
    const placeInfo = ids => {
      const pick = key => {
        const vals = new Set(ids.map(id => placeOfElement.get(id)?.[key] || "—"));
        return vals.size === 1 ? [...vals][0] : `Multiple (${vals.size})`;
      };
      return { category: pick("category"), level: pick("level") };
    };

    if (selected.ids.length !== 1) {
      const taskIds = new Set();
      for (const id of selected.ids) {
        const t = sched?.taskOfElement?.get(id);
        if (t !== undefined) taskIds.add(t);
      }
      const name = `${selected.label} (${selected.ids.length} elements)`;
      const task = taskIds.size === 1 ? sched.tasks.get([...taskIds][0]) : null;
      // 3D View row text: "Multiple (n)" when the group spans activities, "—" if none.
      const taskLabel = task ? (task.code ? `${task.name} (${task.code})` : task.name)
        : taskIds.size > 1 ? `Multiple (${taskIds.size})` : "—";
      const note = taskIds.size > 1 ? `Elements span ${taskIds.size} activities.` : null;
      setPickedDetails({
        id: selected.key, name, task, note, timeless, taskLabel, hasBaseline: !!sched?.hasBaseline,
        ...placeInfo(selected.ids),
      });
      return;
    }
    let cancelled = false;
    fetchElementDetails(d.loader, d.modelID, selected.ids[0], sched)
      .then(details => {
        if (cancelled) return;
        const t = details.task;
        const taskLabel = t ? (t.code ? `${t.name} (${t.code})` : t.name) : "—";
        setPickedDetails({ ...details, timeless, taskLabel, ...placeInfo(selected.ids) });
      })
      .catch(e => {
        console.warn("Failed to read element details:", e);
        if (!cancelled) setPickedDetails(null);
      });
    return () => { cancelled = true; };
  }, [selected, schedule, viewMode, placeOfElement]);

  // Applies a colour pick immediately, without rebuilding or reloading anything.
  // statusMats' material instances are the exact ones already assigned to whatever
  // subsets are on screen, so mutating their colour in place is enough -- the next
  // render just picks it up.
  useEffect(() => {
    const mats = dataRef.current?.statusMats;
    if (!mats) return;
    for (const k of STATUS_ORDER) {
      const m = mats[k];
      if (!m) continue;
      const c = new THREE.Color(statusColors[k]);
      m.color.copy(c);
      m.emissive.copy(c);
      m.needsUpdate = true;
    }
  }, [statusColors, modelEpoch]);

  // Same immediate-repaint pattern as statusColors above, for the single highlight
  // material the selection effect draws its "highlight" subset with.
  useEffect(() => {
    const m = dataRef.current?.highlightMat;
    if (!m) return;
    m.color.copy(new THREE.Color(highlightColor));
    m.needsUpdate = true;
  }, [highlightColor, modelEpoch]);

  // --- 4D simulation -------------------------------------------------------------
  //
  // Drives visibility off the schedule by rewriting the SAME subsets the palette
  // already uses (`removePrevious: true` reuses each mesh and just rewrites its index
  // buffer, so this is cheap enough to run on every frame of playback). Reusing the
  // existing customIDs and material instances is deliberate: a second set of meshes
  // would double the draw calls.
  useEffect(() => {
    const d = dataRef.current;
    if (!d || !currentDate) return;

    const setSubset = (ids, material, customID) => {
      try {
        const s = d.loader.ifcManager.createSubset({
          modelID: d.modelID, ids, material,
          scene: d.scene, removePrevious: true, customID,
        });
        if (s) { s.castShadow = true; s.receiveShadow = true; }
      } catch (e) {
        console.warn("subset update failed:", customID, e);
      }
    };

    // ONLY POPULATED SUBSETS ARE TOUCHED. Tinting multiplies the customIDs -- 15 buckets
    // for the natural pass, plus up to 15 x 4 tinted -- and calling createSubset for all
    // 75 on every tick of playback would not keep up. Instead each pass records what it
    // actually drew, and anything left over from the previous frame is emptied at the
    // end. In practice only a handful are live at any date.
    const drawn = new Map();
    const draw = (ids, material, customID) => {
      if (!ids || ids.length === 0) return;
      setSubset(ids, material, customID);
      drawn.set(customID, material);
    };
    const flush = () => {
      for (const [cid, mat] of d.activeSubsets) if (!drawn.has(cid)) setSubset([], mat, cid);
      d.activeSubsets = drawn;
    };

    // Elements grouped the way the palette groups them, so a bucket's ids can be drawn
    // or tinted as a unit. `null` ids means "everything in the bucket".
    const bucketIds = (key, keep) => {
      const all = d.buckets.get(key)?.ids || [];
      return keep ? all.filter(id => keep.has(id)) : all;
    };

    // The model in its own colours, restricted to `ids` when one is given.
    const drawNatural = (ids) => {
      if (d.paletteMats) {
        const keep = ids && new Set(ids);
        for (const [key, mat] of d.paletteMats) draw(bucketIds(key, keep), mat, key);
      } else if (ids) {
        // The file has its own colours. A subset with no material inherits the model's
        // material array and geometry groups, so per-element colours survive.
        d.model.visible = false;
        draw(ids, undefined, "sim-built");
      } else {
        d.model.visible = true;
      }
    };

    // Work with recorded actuals receives its exact, solid traffic-light colour. Work
    // without actuals is handled by drawNatural above and keeps its native colour.
    const drawStatus = (k, ids) => {
      if (!ids.length) return;
      if (d.paletteMats) {
        const keep = new Set(ids);
        for (const key of d.paletteMats.keys()) {
          draw(bucketIds(key, keep), d.statusMats[k], `st-${k}-${key}`);
        }
      } else {
        draw(ids, d.statusMats[k], `st-${k}`);
      }
    };

    // --- not simulating: the finished building, its own colours, nothing faded --------
    // `viewMode !== "4d"` has to bail out here too, not just `!simulate` -- `simulate`
    // is component state, so it stays true across a tab switch if the user pressed Play
    // in 4D Simulation and then clicked 3D View. Without this check, 3D View would keep
    // showing whatever partial build-up state was left over instead of the whole model.
    if (viewMode !== "4d" || !simulate || !d.schedule?.hasSchedule) {
      drawNatural(null);
      flush();
      setStatusCounts(null);
      return;
    }

    // --- the 4D simulation ------------------------------------------------------------
    //
    // There is no separate planned-vs-actual mode: the growth and the colouring are the
    // same picture, and nothing is ever ghosted or transparent. Every element is one of:
    //
    //   1. NOT YET REACHED   -> not drawn at all. Reached is judged on effStart, which
    //      is (actual start, else the CURRENT schedule, else a forecast) -- the same
    //      field the Gantt's Var column reads. This is what makes activities with no
    //      recorded actual still grow on schedule: their effStart falls back to the
    //      updated export's own Start, already rescheduled along the logic links, so a
    //      slip on an early activity carries its successors' reveal times with it.
    //   2. REACHED, NO ACTUAL DATA  -> tinted by forecast-vs-baseline once a baseline
    //      is loaded AND "Upcoming activities" is checked (taskStatusAt's "not
    //      started" branch: expected dates compared to BL Start/Finish), so upcoming
    //      work already forecast late shows red before a single actual date exists.
    //      Without a baseline, or with that checkbox off, there is nothing to judge
    //      it against (or the user asked not to), so it is shown as built and left
    //      alone -- no colour claims a fact that has not happened.
    //   3. REACHED, WITH ACTUAL DATA -> its own colour pulled 60% towards its traffic
    //      light (red/green/yellow once finished, blue while under way), opaque. A
    //      transparent status colour turned the building into glass, since blending
    //      needs depth writing off; tinting keeps it solid.
    //   4. NO ACTIVITY ASSIGNED AT ALL (terrain, landscaping) -> always drawn, own
    //      colour, opaque -- context, not progress, so it never disappears.
    const sched = d.schedule;

    // Delayed/onTime/ahead are a comparison against a PLANNED date. Without a merged
    // baseline file, `start`/`finish` are just the progressed file's own Schedule
    // fields -- which Synchro overwrites with the actual dates the moment progress is
    // recorded (see withBaseline's header comment), so as===bs and af===bf on every
    // finished task and taskStatusAt would call all of them "on time". That is not an
    // absence of delay, it is an absence of anything to compare against, so it must be
    // suppressed rather than shown as a false green. "In progress" is not a comparison
    // -- it only says work has started -- so it stays regardless of baseline.
    const statusFn = sched?.hasBaseline
      ? (task, date) => taskStatusAt(task, date, showUpcoming)
      : (task, date) => (taskStatusAt(task, date) === "inProgress" ? "inProgress" : null);
    const { byStatus, taskCounts } = elementStatusAt(sched, currentDate, statusFn);

    // The terrain belongs to the excavation activity, so colouring it paints an 80x85m
    // status-coloured sheet across the whole view and the building cannot be read
    // against it. Left in its natural olive by default; the counts still include it.
    const skip = colourTerrain ? null : d.siteIds;
    const shown = skip ? (ids) => ids.filter(id => !skip.has(id)) : (ids) => ids;

    // With colouring off, nothing is judged -- every reached element falls through to
    // `trueColor` below and keeps its own material colour, exactly like bucket 2.
    const judged = new Set();       // bucket 3: tinted
    if (showStatusColors) {
      for (const k of STATUS_ORDER) for (const id of shown(byStatus[k])) judged.add(id);
    }

    // Bucket 1 vs 2: has this task's best-known start been reached by the playhead.
    const t = +currentDate;
    const reached = new Set();
    for (const task of sched.tasks.values()) {
      if (task.isSummary || !task.elementIds.length) continue;
      const es = +(task.effStart || 0);
      if (es && t >= es) for (const id of task.elementIds) reached.add(id);
    }

    const scheduled = sched.taskOfElement || new Map();
    const trueColor = [];           // buckets 2 and 4
    let hiddenCount = 0;
    for (const id of d.allIds) {
      if (judged.has(id)) continue;
      if (!scheduled.has(id) || reached.has(id)) trueColor.push(id);
      else hiddenCount++;           // bucket 1: simply never drawn this frame
    }

    // Isolate: with a legend chip selected, only that status is drawn; the natural-
    // coloured and every other status bucket are left undrawn (flush() clears them).
    const iso = showStatusColors ? statusFilter : null;
    drawNatural(iso ? [] : trueColor);
    if (showStatusColors) {
      for (const k of STATUS_ORDER) if (!iso || k === iso) drawStatus(k, shown(byStatus[k]));
    }
    // Anything not drawn this frame -- including bucket 1 -- is cleared by flush(),
    // which is what makes "not yet reached" mean "not drawn" with no extra code.
    flush();

    const elementCounts = {};
    for (const k of STATUS_ORDER) elementCounts[k] = byStatus[k].length;
    // `judged` is a Set, so judged.size is already deduped -- unlike summing the
    // per-status arrays above, which double-counts any element that Synchro has
    // assigned to more than one leaf activity (it lands in two different status
    // buckets). That sum is fine for the per-status legend badges, but a "how much
    // of the model is built" total needs judged.size or it can read over 100%.
    // Skip the state update when nothing changed: most timeline ticks leave every
    // count the same, and a new object would re-render the whole viewer for nothing.
    // A manual field-by-field compare instead of JSON.stringify-ing both sides --
    // this runs every tick, and STATUS_ORDER is tiny, so a few key lookups beat
    // serializing two whole objects just to throw the strings away.
    const nextCounts = { tasks: taskCounts, elements: elementCounts,
                         natural: trueColor.length, builtUnique: judged.size,
                         notYetBuilt: hiddenCount };
    setStatusCounts(prev => (prev && countsEqual(prev, nextCounts)) ? prev : nextCounts);
  }, [currentDate, simulate, showStatusColors, colourTerrain, schedule, showUpcoming, viewMode, statusFilter]);

  // Status materials are not tone mapped, so the scene has to be re-exposed for them:
  // under the normal 2.2-intensity sun their channels clamp and the hue shifts (green
  // to mint, red to salmon). See makeStatusMaterial in ifcMaterials.js.
  useEffect(() => {
    const d = dataRef.current;
    if (!d?.sun) return;
    // The simulation is now always status-coloured, so the calmer exposure follows the
    // simulation itself rather than a separate toggle -- gated on viewMode for the same
    // stale-`simulate`-across-tabs reason as the big effect above.
    const L = (viewMode === "4d" && simulate) ? STATUS_LIGHTING : REALISTIC_LIGHTING;
    d.sun.intensity = L.sunIntensity;
    d.hemi.intensity = L.hemiIntensity;
  }, [simulate, schedule, viewMode]);

  // Edges visibility, per outline group. Not simulating (or not in 4D view at all) --
  // every group shows, exactly like one whole-model outline used to. WHILE simulating,
  // each task's outline only shows once that task is "reached", using the identical
  // `effStart` test the build-up's own visibility effect above runs -- so the outline
  // grows in lockstep with the model instead of giving away unbuilt geometry. The
  // "unscheduled" group (terrain, anything with no task) always shows, matching that
  // same effect's "not scheduled -> always drawn" rule.
  useEffect(() => {
    const groups = edgesRef.current;
    if (!groups) return;
    const building = viewMode === "4d" && simulate && schedule?.hasSchedule;
    const t = building ? +currentDate : 0;
    for (const [key, lines] of groups) {
      if (!building || key === "unscheduled") { lines.visible = showEdges; continue; }
      const taskId = Number(key.slice(5)); // key is `task-<id>`
      const es = +(schedule.tasks.get(taskId)?.effStart || 0);
      lines.visible = showEdges && !!es && t >= es;
    }
  }, [simulate, showEdges, viewMode, currentDate, schedule, edgesEpoch]);

  // Playback: advance `speed` days per tick until the end of the schedule.
  //
  // Wall-clock pace is TICK_MS per `speed` days. At the 1 d/frame default that walks
  // this 273-day project in about 49 seconds, which is slow enough to actually watch a
  // storey go up. The Speed dropdown is the coarse control; this is the fine one.
  useEffect(() => {
    if (!playing || !schedule?.range) {
      if (playRef.current) { clearInterval(playRef.current); playRef.current = null; }
      return;
    }
    playRef.current = setInterval(() => {
      setCurrentDate(prev => {
        const next = new Date(+(prev || schedule.range.min) + speed * 86400000);
        if (next >= schedule.range.max) { setPlaying(false); return schedule.range.max; }
        return next;
      });
    }, TICK_MS);
    return () => { clearInterval(playRef.current); playRef.current = null; };
  }, [playing, speed, schedule]);

  function togglePlay() {
    if (!schedule?.range) return;
    if (playing) { setPlaying(false); return; }
    // Pressing play has to mean "watch it get built", so switch the simulation on and
    // rewind if we are sitting at the end.
    setSimulate(true);
    if (!currentDate || +currentDate >= +schedule.range.max) {
      setCurrentDate(schedule.range.min);
    }
    setPlaying(true);
  }

  // Clicking a task in the Gantt highlights the elements it builds, reusing the same
  // highlight path as the Contents panel and the 3D view's own click-to-select.
  // `source: "task"` tells the selection<->Gantt sync effect below that selectedTaskId
  // is already correct here, so it doesn't need to (re)derive it from `selected.ids`.
  function selectTask(taskId) {
    setSelectedTaskId(taskId);
    const task = taskId != null ? schedule?.tasks?.get(taskId) : null;
    setSelected(task && task.elementIds.length
      ? { key: `task-${taskId}`, label: task.name, ids: task.elementIds, source: "task" }
      : null);

    // Jump the playhead to the moment the task completes. Without this, clicking a
    // task scheduled later than the current date highlights elements that have not
    // been built yet, and the viewport (mid-simulation) shows nothing there yet.
    if (task?.finish && simulate && +task.finish > +(currentDate || 0)) {
      setPlaying(false);
      setCurrentDate(task.finish);
    }
  }

  // Dragging the divider between the 3D view and the Gantt. Not meaningful while
  // collapsed -- there's no panel height left to drag -- so the handle no-ops then;
  // the arrow button (on the same bar) is what expands it again.
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

  // Dragging the Contents sidebar's right edge. Sits on the LEFT of the screen, so
  // (unlike InsightsPanel's mirror-image handle) widening it means moving with the
  // drag, not against it.
  function startContentsResize(e) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = contentsW;
    setContentsResizing(true);
    const move = ev => setContentsW(Math.max(CONTENTS_MIN_W, Math.min(CONTENTS_MAX_W, startW + (ev.clientX - startX))));
    const up = () => {
      setContentsResizing(false);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  const q = search.trim().toLowerCase();
  const roots = !contents ? []
    : groupBy === "level" ? contents.levelTree
    : contents.categoryTree;

  // Keeps a branch if its own label matches (then the whole branch stays, so you can
  // still see what is inside "Walls") or if anything below it matches.
  //
  // Memoized: `roots`/`q` only change on a real Contents interaction (load, group-by
  // toggle, search keystroke), never on a `currentDate` tick -- but without this, the
  // whole category/level tree was re-walked and every node's JSX rebuilt on every
  // single playback tick (several times a second), for a panel that wasn't even
  // changing.
  const visibleRoots = useMemo(() => {
    function filterTree(nodes) {
      if (!q) return nodes;
      const out = [];
      for (const n of nodes) {
        if (n.label.toLowerCase().includes(q)) { out.push(n); continue; }
        const kids = filterTree(n.children);
        if (kids.length) out.push({ ...n, children: kids });
      }
      return out;
    }
    return filterTree(roots);
  }, [roots, q]);

  // A Set for O(1) membership below. Selections that come from the Gantt or a 3D
  // click carry ids that don't equal any single tree node's own `ids` array (a task
  // or a picked element rarely lines up exactly with a category/level/type grouping),
  // so matching on node identity alone (the old `selected?.key === node.key` check)
  // never lit up for those -- the panel only ever highlighted a node you'd clicked
  // IN the panel itself. Overlap catches every other source too.
  const selIds = selected ? new Set(selected.ids) : null;

  // One renderer for every tier, so a 2-level (category) and a 3-level (level)
  // tree share exactly the same behaviour. depth only affects indentation.
  function renderNode(node, depth) {
    const hasKids = node.children.length > 0;
    const isOpen = hasKids && (!collapsed[node.key] || !!q);
    // Exact match drives the click-to-toggle behaviour (clicking the same node again
    // clears it); overlap drives the visual highlight, so ancestors/descendants of a
    // Gantt- or 3D-picked selection light up too, not just an identical node clicked
    // here. They're kept separate so clicking a DIFFERENT, merely-overlapping node
    // (e.g. a parent category while one of its types is selected) selects that node
    // instead of being mistaken for "click to deselect".
    const isExact = selected?.key === node.key;
    const overlaps = !!selIds && node.ids.some(id => selIds.has(id));
    return (
      <div key={node.key}>
        <div
          title={node.label}
          onClick={() => setSelected(isExact ? null : { key: node.key, label: node.label, ids: node.ids, source: "contents" })}
          style={{
            display: "flex", alignItems: "center", gap: 7, fontFamily: "var(--font-mono)",
            padding: "5px 12px", paddingLeft: 12 + depth * 14, cursor: "pointer",
            fontSize: depth === 0 ? 12 : 11.5,
            fontWeight: depth === 0 ? 600 : 400,
            textTransform: depth === 0 ? "uppercase" : "none",
            letterSpacing: depth === 0 ? "0.06em" : "normal",
            color: depth === 0 ? "var(--ink-700)" : "var(--ink-600)",
            background: overlaps ? "var(--aar-blue-fog)" : depth === 0 ? "var(--paper-2)" : "transparent",
            borderBottom: "1px solid " + (depth === 0 ? "var(--line-soft)" : "var(--paper-cool)"),
          }}
        >
          <span
            onClick={e => {
              if (!hasKids) return;
              e.stopPropagation();  // expanding must not also change the selection
              setCollapsed(p => ({ ...p, [node.key]: !p[node.key] }));
            }}
            style={{ width: 9, flexShrink: 0, color: "var(--ink-400)" }}
          >
            {hasKids ? (isOpen ? "▾" : "▸") : ""}
          </span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {node.label}
          </span>
          <span style={{ marginLeft: "auto", paddingLeft: 6, color: "var(--ink-300)" }}>{node.count}</span>
        </div>
        {isOpen && node.children.map(child => renderNode(child, depth + 1))}
      </div>
    );
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--paper-3)" }}>
      {/* The Contents sidebar sits beside the 3D view, directly above the Gantt chart --
          a proper flex column now (not a floating overlay), matching the mockup. */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", minWidth: 0 }}>
        {showContents && (
          <aside style={{
            width: contentsW, flexShrink: 0, display: "flex", flexDirection: "column", position: "relative",
            background: "var(--paper)", borderRight: "1px solid var(--line-strong)", minHeight: 0,
          }}>
            {/* Drag handle on the panel's right boundary -- mirrors InsightsPanel's
                own left-edge handle so both side panels resize the same way, straddling
                the border (-3..+3) so it's easy to grab without pixel-perfect aim. */}
            <div
              onMouseDown={startContentsResize}
              title="Drag to resize Model layers"
              style={{
                position: "absolute", right: -3, top: 0, bottom: 0, width: 6,
                cursor: "col-resize", zIndex: 2,
                background: contentsResizing ? "rgba(63,110,140,.5)" : "transparent",
              }}
            />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                          padding: "10px 12px", borderBottom: "1px solid var(--line-soft)" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.08em",
                              textTransform: "uppercase", color: "var(--ink-700)" }}>
                  Model layers
                </span>
                {contents && (
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--ink-400)" }}>
                    {visibleRoots.reduce((n, r) => n + r.count, 0)} shown
                  </span>
                )}
              </div>
              <button
                onClick={() => setShowContents(false)} title="Close"
                style={{ fontFamily: "inherit", fontSize: 13, background: "transparent", border: 0,
                         color: "var(--ink-400)", cursor: "pointer", padding: "2px 4px" }}
              >
                ✕
              </button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr",
                          borderBottom: "1px solid var(--line-soft)" }}>
              {[["level", "By level"], ["category", "By category"]].map(([key, label]) => (
                <button
                  key={key} onClick={() => setGroupBy(key)}
                  style={{
                    fontFamily: "inherit", fontSize: 12, fontWeight: 500, padding: "8px 0", cursor: "pointer",
                    border: 0, borderBottom: "2px solid " + (groupBy === key ? "var(--aar-blue)" : "transparent"),
                    background: groupBy === key ? "var(--paper)" : "var(--paper-2)",
                    color: groupBy === key ? "var(--ink-700)" : "var(--ink-400)",
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--line-soft)" }}>
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search elements…"
                style={{ width: "100%", fontFamily: "inherit", fontSize: 12, padding: "7px 9px",
                        border: "1px solid var(--line-strong)", background: "var(--paper)", color: "var(--ink-700)",
                        outline: "none" }}
              />
              {selected && (
                <button
                  onClick={() => setSelected(null)}
                  style={{ marginTop: 6, width: "100%", fontFamily: "inherit", fontSize: 11.5,
                          padding: "5px 0", cursor: "pointer", border: "1px solid var(--line-strong)",
                          background: "var(--paper)", color: "var(--ink-700)" }}
                >
                  Clear selection ({selected.ids.length})
                </button>
              )}
            </div>

            <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
              {visibleRoots.length === 0 && (
                <div style={{ fontSize: 11.5, color: "var(--ink-400)", padding: 10 }}>
                  {!contents ? "Load an IFC file." : "No elements match."}
                </div>
              )}
              {visibleRoots.map(node => renderNode(node, 0))}
            </div>

            {contents && contents.classified < contents.total && (
              <div style={{ padding: "8px 12px", borderTop: "1px solid var(--line-soft)", fontSize: 11.5,
                            lineHeight: 1.45, color: "var(--ink-400)", background: "var(--paper-2)" }}>
                {contents.total - contents.classified} of {contents.total} elements could not
                be identified from the file and sit under Generic Models.
              </div>
            )}

            {/* The Planned/Updated IFC pickers -- moved here from App.jsx's header, so
                the file inputs live in the same place the mockup's "Source files"
                list sits: the bottom of the left panel, not a big row above the
                viewport. See the note on the `sourceFiles` prop above. */}
            {sourceFiles.length > 0 && (
              <div style={{ padding: "9px 12px", borderTop: "1px solid var(--line-soft)",
                            background: "var(--paper-2)" }}>
                <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em",
                              textTransform: "uppercase", color: "var(--ink-400)", marginBottom: 7 }}>
                  Source files
                </div>
                {sourceFiles.map(f => <SourceFileRow key={f.label} {...f} />)}
              </div>
            )}
          </aside>
        )}

        {/* Centre column: the 3D view stacked above the Gantt chart, between the
            Model layers panel and Insights -- both of which now run the FULL height
            of this row (down past the Gantt too), matching the mockup's layout
            instead of the Gantt spanning the whole window width below everything. */}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div ref={viewportRef} style={{ position: "relative", flex: 1, minWidth: 0, minHeight: 0,
                      background: "var(--paper-4)", overflow: "hidden" }}>
          <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />

          {/* Floating view controls: one compact toolbar (Display, Fit view, Fullscreen)
              top-right, with every visibility toggle in its popover -- replaces the
              full-width toolbar row that used to sit above the viewport. */}
          <FloatingViewControls
            onReset={resetDisplay} fullscreenRef={viewportRef}
            onFit={() => dataRef.current?.fitView?.()}
          >
                {viewMode === "4d" && (
                  <DisplaySection label="Colour">
                    <DisplayRow
                      icon={VP_ICONS.palette} label="Colour coding" checked={showStatusColors}
                      onChange={setShowStatusColors}
                      title="ON = work is tinted red/green/yellow/blue by its traffic-light status -- actual dates once recorded, and (with a baseline loaded) expected/forecast dates before that, each judged against the baseline. OFF = the build-up still grows on schedule, but every element just keeps its own material colour -- nothing is judged."
                    />
                    {showStatusColors && (
                      <div className="vp-sub">
                        <ColorCodingSettings
                          colors={statusColors}
                          onChange={(k, v) => setStatusColors(prev => ({ ...prev, [k]: v }))}
                          onReset={() => setStatusColors(DEFAULT_STATUS_COLORS)}
                        />
                      </div>
                    )}
                    {schedule?.hasSchedule && (
                      <DisplayRow
                        icon={VP_ICONS.calendar} label="Upcoming activities" checked={showUpcoming}
                        onChange={setShowUpcoming}
                        title="Shows current and future activities. The panel colours forecast dates against BL Start/Finish: red delayed, green on time, yellow ahead, blue in progress. With Colour coding on, it also applies the same baseline comparison in the 3D view."
                      />
                    )}
                  </DisplaySection>
                )}

                <DisplaySection label="Scene">
                  {viewMode === "4d" && (
                    <DisplayRow
                      icon={VP_ICONS.mountain} label="Colour terrain" checked={colourTerrain}
                      onChange={setColourTerrain}
                      title="The terrain is one 80x85m element owned by the excavation activity, so colouring it hides the building behind a status-coloured sheet. Off = it stays its natural olive; the legend counts still include it."
                    />
                  )}
                  <DisplayRow icon={VP_ICONS.box} label="Edges" checked={showEdges} onChange={setShowEdges} />
                </DisplaySection>

                <DisplaySection label="Overlays">
                  {viewMode === "4d" && schedule?.hasSchedule && (
                    <DisplayRow
                      icon={VP_ICONS.chart} label="Insights" checked={showInsights} onChange={setShowInsights}
                      title="A right-hand panel of project/task metrics, progress by category and a Planned-vs-Actual S-curve -- see InsightsPanel.jsx."
                    />
                  )}
                  <label className="vp-row"
                         title="The colour used to pick out whatever is selected -- a Contents panel node, or a clicked Gantt/Upcoming task. Everything else stays in its own colour; only the selected elements get this overlay.">
                    <VpIcon d={VP_ICONS.highlighter} color="var(--ink-300)" />
                    <span className="vp-row-label">Highlight colour</span>
                    <input type="color" value={highlightColor} onChange={e => setHighlightColor(e.target.value)}
                           className="vp-color" />
                  </label>
                </DisplaySection>
          </FloatingViewControls>

          {/* Status legend / isolate filter: floats top-left, clear of the Display toolbar. */}
          {viewMode === "4d" && simulate && showStatusColors && statusCounts && (
            <div className="vp-legend" style={{ left: showContents ? 12 : 104 }}>
              {STATUS_ORDER.map(k => {
                const active = statusFilter === k;
                return (
                  <button
                    key={k}
                    onClick={() => setStatusFilter(active ? null : k)}
                    title={active
                      ? "Showing only this status in the 3D view. Click to show everything again."
                      : `Click to show only "${TASK_STATUS[k].label}" elements in the 3D view. ` +
                        `${statusCounts.elements?.[k] ?? 0} elements.`}
                    className={"fchip" + (active ? " active" : statusFilter ? " dim" : "")}
                    style={{ "--c": statusColors[k] }}
                  >
                    <span style={{ width: 10, height: 10, background: statusColors[k], borderRadius: 2,
                                   display: "inline-block" }} />
                    {TASK_STATUS[k].label}
                    <strong>{statusCounts.tasks?.[k] ?? 0}</strong>
                    <span style={{ color: "var(--ink-400)" }}>({statusCounts.elements?.[k] ?? 0} el)</span>
                  </button>
                );
              })}
              {statusFilter && (
                <button className="fchip" onClick={() => setStatusFilter(null)}
                        title="Show all statuses again" style={{ "--c": "var(--aar-blue)" }}>
                  Clear ✕
                </button>
              )}
              {noRealVariance && (
                <span style={{ fontSize: 11.5, color: "var(--status-ahead)", whiteSpace: "nowrap" }}
                      title="No slipped activity in this file owns geometry, so all-green is correct.">
                  All on plan ⓘ
                </span>
              )}
            </div>
          )}

          {/* Reopens Contents once its own panel has been closed. Hidden while the
              panel is open so there's only ever one way to toggle it at a time. */}
          {!showContents && (
            <button
              onClick={() => setShowContents(true)}
              title="Show Contents"
              style={{
                position: "absolute", left: 12, top: 12, zIndex: 6, fontFamily: "inherit", fontSize: 12,
                fontWeight: 500, padding: "8px 12px", cursor: "pointer",
                background: "var(--paper)",
                border: "1px solid var(--line-soft)", color: "var(--ink-700)",
              }}
            >
              Contents
            </button>
          )}

          {/* Simulation date badge -- only meaningful while the 4D build-up is running. */}
          {viewMode === "4d" && simulate && currentDate && (
            <div style={{
              position: "absolute", left: 12, bottom: 12, display: "flex", alignItems: "center", gap: 10,
              padding: "8px 12px", background: "var(--paper)",
              border: "1px solid var(--line-soft)",
            }}>
              <span style={{ fontSize: 11.5, letterSpacing: "0.08em", textTransform: "uppercase",
                            color: "var(--ink-400)" }}>
                Simulation date
              </span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 600,
                            color: "var(--ink-700)" }}>
                {fmtSimDate(currentDate)}
              </span>
              {statusCounts && (
                <>
                  <span style={{ width: 1, height: 16, background: "var(--line-soft)" }} />
                  <span style={{ fontSize: 11.5, color: "var(--ink-600)" }}>
                    {statusCounts.natural + statusCounts.builtUnique} elements built
                  </span>
                </>
              )}
            </div>
          )}

          {viewMode === "4d" && showUpcoming && schedule?.hasSchedule && (
            <div style={{
              position: "absolute", right: 12, top: 60, maxHeight: "calc(100% - 72px)", width: 292,
              overflow: "auto", background: "var(--paper)",
              border: "1px solid var(--line-soft)", boxShadow: "var(--elev-2)", display: "flex",
              flexDirection: "column", zIndex: 5,
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
                schedule={schedule}
                asOf={currentDate || schedule.range?.min}
                selectedTaskId={selectedTaskId}
                onSelectTask={selectTask}
                statusColors={statusColors}
              />
            </div>
          )}

          <ElementDetailsDialog details={pickedDetails} onClose={() => setPickedDetails(null)} />
        </div>

        {/* The Gantt chart, with a draggable divider -- hidden entirely in 3D view,
            which is what gives that mode its extra vertical space. Sitting inside
            this centre column (not below the whole row) is what keeps it running
            only between Model layers and Insights, not the full window width. */}
        {viewMode === "4d" && schedule?.hasSchedule && schedule.range && (
          <>
            <div
              onMouseDown={startResize}
              title={ganttCollapsed ? undefined : "Drag to resize"}
              style={{ height: 6, cursor: ganttCollapsed ? "default" : "ns-resize",
                       background: "var(--paper-3)", position: "relative",
                       borderTop: "1px solid var(--line-strong)", borderBottom: "1px solid var(--line-strong)",
                       flexShrink: 0 }}
            >
              {/* Collapse/expand the whole Gantt panel, handing its height back to the
                  3D viewport above -- that panel is flex:1 there, so it fills the space
                  the instant this one's height drops to zero. The arrow points the
                  direction the panel will move: down (collapse) when open, up
                  (expand) when already collapsed. */}
              <button
                onMouseDown={e => e.stopPropagation()}
                onClick={() => setGanttCollapsed(v => !v)}
                title={ganttCollapsed ? "Show schedule" : "Hide schedule"}
                style={{
                  position: "absolute", top: "50%", left: "50%",
                  transform: "translate(-50%, -50%)",
                  width: 44, height: 15, lineHeight: 1, fontSize: 10.5,
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
                  schedule={schedule}
                  currentDate={currentDate || schedule.range.min}
                  onDateChange={d => { setCurrentDate(d); setSimulate(true); }}
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

        {viewMode === "4d" && showInsights && schedule?.hasSchedule && (
          <InsightsPanel
            schedule={schedule}
            currentDate={currentDate || schedule.range?.min}
            contents={contents}
            statusCounts={statusCounts}
            statusColors={statusColors}
            selectedTaskId={selectedTaskId}
            onClose={() => setShowInsights(false)}
          />
        )}
      </div>
    </div>
  );
}

// DD-MM-YYYY, matching the Gantt's own playhead readout style.
function fmtSimDate(d) {
  const dt = new Date(d);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(dt.getUTCDate())}-${p(dt.getUTCMonth() + 1)}-${dt.getUTCFullYear()}`;
}

// One row of the "Source files" list at the bottom of Model layers -- a compact,
// single-line file picker (dot + name/size + a tiny Choose/Replace + clear), not the
// wide dashed drop-box this used to be in App.jsx's header. This is now the ONLY
// place the Planned/Updated IFC actually get picked; App.jsx just owns the state.
function SourceFileRow({ label, dotColor, file, accept, onPick, onClear, tooltip }) {
  const inputRef = useRef();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }} title={tooltip}>
      <span style={{ width: 7, height: 7, flexShrink: 0, display: "inline-block",
                     background: file?.name ? dotColor : "var(--line-strong)" }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 11, color: file?.name ? "var(--ink-700)" : "var(--ink-400)",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
             title={file?.name || `${label} — not loaded`}>
          {file?.name || label}
        </div>
        {file?.name && (
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-400)" }}>
            {fmtBytes(file.size)}
          </div>
        )}
      </div>
      <input ref={inputRef} type="file" accept={accept} onChange={onPick} style={{ display: "none" }} />
      <button
        onClick={() => inputRef.current.click()} title={file?.name ? "Replace" : "Choose"}
        style={{ fontFamily: "inherit", fontSize: 11, fontWeight: 500, padding: "3px 7px", cursor: "pointer",
                 background: "var(--paper)", color: "var(--ink-700)", border: "1px solid var(--line-strong)",
                 flexShrink: 0 }}
      >
        {file?.name ? "Replace" : "Choose"}
      </button>
      {file?.name && (
        <button
          onClick={onClear} title="Clear"
          style={{ fontFamily: "inherit", fontSize: 11, width: 16, height: 16, cursor: "pointer",
                   background: "transparent", color: "var(--ink-400)", border: 0, flexShrink: 0, padding: 0 }}
        >
          ✕
        </button>
      )}
    </div>
  );
}
