import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import {
  applyNamePalette, toRealistic, makeMaterial, makeStatusMaterial, HIGHLIGHT, STATUS_LIGHTING,
  cssColor,
} from "./ifcMaterials";
import { elementStatusAt, taskStatusAt, STATUS_ORDER, TASK_STATUS } from "./ifcSchedule";
import { buildingFrameBox, frameCamera, makeShadowGround } from "./viewFraming";

// Falls back to the app's own colours when the parent hasn't picked custom ones.
const DEFAULT_STATUS_COLORS = Object.fromEntries(
  STATUS_ORDER.map(k => [k, cssColor(TASK_STATUS[k].color)])
);

// Field-by-field compare for the status-counts the simulation effect rebuilds every
// playback tick -- `tasks`/`elements` are flat { [status]: count } objects keyed by
// STATUS_ORDER, so a few key lookups is all a real equality check needs; no reason to
// JSON.stringify two whole objects every tick just to throw the strings away.
function countsEqual(a, b) {
  if (!a || !b) return false;
  for (const k of STATUS_ORDER) {
    if (a.tasks[k] !== b.tasks[k] || a.elements[k] !== b.elements[k]) return false;
  }
  return true;
}

/**
 * One half of the Planned vs Actual split view. Purely a render + simulate pane: it
 * does NOT load its own IFC file. The model, the shared IFCLoader, the buckets and
 * the schedule are all handed down by SplitCompareView, which loads BOTH files
 * through ONE IFCLoader instance -- see the note there for why that is mandatory
 * (web-ifc-three's IFCModel.modelIdCounter is a module-global static, so two
 * independently-`new`'d IFCLoaders each number their first model 0 internally while
 * their THREE meshes get global ids 0 and 1, and createSubset crashes on the
 * mismatch). Everything from here down is just "given a loaded model, grow it".
 */
export default function Viewport3D({
  label, loader, model, modelID, buckets, siteIds, allIds, schedule, currentDate, colourTerrain,
  showStatusColors = true, showUpcoming = false, statusColors = DEFAULT_STATUS_COLORS, onReady,
  statusFilter = null, onStatusCounts,
  selectedIds, highlightColor = cssColor(HIGHLIGHT.color), onPick, showEdges = true,
}) {
  const containerRef = useRef();
  const dataRef = useRef(null);
  const edgesRef = useRef(null);   // Map<key, LineSegments> -- one outline group per task, plus "unscheduled"
  // The mount effect below only depends on [model], so it attaches the click listener
  // ONCE per model and never again -- but `onPick` is a fresh closure every render of
  // SplitCompareView (it captures `plannedPane`/`actualSchedule` from whatever render
  // created it). Calling the `onPick` PROP directly from that one-time listener would
  // freeze it at whatever those were the moment this pane's model first appeared --
  // which, for the Planned pane, is BEFORE the Actual file finishes loading and
  // `actualSchedule` exists yet. A ref sidesteps that: the listener always calls
  // `onPickRef.current`, and this effect keeps that pointed at the latest closure.
  const onPickRef = useRef(onPick);
  useEffect(() => { onPickRef.current = onPick; }, [onPick]);
  // Same ref trick for the counts callback, so the simulation effect below does not
  // re-run just because the parent handed down a fresh function.
  const onCountsRef = useRef(onStatusCounts);
  const lastCountsRef = useRef(null);
  // Bumped when the deferred edge outlines finish, so the visibility effect re-runs.
  const [edgesEpoch, setEdgesEpoch] = useState(0);
  useEffect(() => { onCountsRef.current = onStatusCounts; }, [onStatusCounts]);

  useEffect(() => {
    if (!model || !containerRef.current) return;
    const container = containerRef.current;
    container.innerHTML = "";

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xdbe7f0);

    // SplitCompareView now mounts both panes as soon as both files are picked, not
    // when the Split tab is first opened -- so `container` can genuinely be 0x0 here
    // (display:none on an ancestor collapses it) while this pane loads in the
    // background. A 0/0 aspect ratio is NaN, which would leave the camera's own
    // projection matrix undefined until the real ResizeObserver below corrects it --
    // harmless while nothing is ever rendered to a hidden pane, but the warm-up
    // render loop further down DOES render while hidden on purpose, so it needs a
    // well-formed camera/renderer to do that against. Falls back to a plausible
    // viewport size; onResize overwrites this with the real one the moment the pane
    // actually becomes visible.
    const initW = container.clientWidth || 800;
    const initH = container.clientHeight || 600;

    const camera = new THREE.PerspectiveCamera(60, initW / initH, 0.1, 10000);
    camera.position.set(10, 10, 10);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(initW, initH);
    // At least 1.5x: on standard-density screens this supersamples, which is what makes
    // thin edge lines and element borders read crisply instead of shimmering.
    renderer.setPixelRatio(Math.min(Math.max(window.devicePixelRatio || 1, 1.5), 2));
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envRT.texture;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    // Hands the camera + controls up to SplitCompareView, which runs the "Lock views"
    // active/follower sync across both panes -- see the note there. Each pane owns its
    // own render loop, so the parent only ever mutates this camera's transform; it
    // never renders it itself.
    const readyApi = { camera, controls, fitView: null };
    onReady?.(readyApi);

    // Always mid-simulation, so always under the calmer light the un-tone-mapped
    // status materials need -- see STATUS_LIGHTING's note in SimpleViewer.
    const sun = new THREE.DirectionalLight(0xfff5e6, STATUS_LIGHTING.sunIntensity);
    scene.add(sun, sun.target);
    const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x8a7f6d, STATUS_LIGHTING.hemiIntensity);
    scene.add(hemi);

    scene.add(model);

    const uniqueColors = new Set();
    model.traverse(child => {
      if (!child.isMesh) return;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const m of mats) uniqueColors.add(m.color.getHexString());
    });

    let paletteMeshes = new Map();
    if (uniqueColors.size <= 1) {
      paletteMeshes = applyNamePalette(loader, model, modelID, scene, buckets);
    } else {
      model.traverse(child => {
        if (!child.isMesh) return;
        child.castShadow = true;
        child.receiveShadow = true;
        child.material = Array.isArray(child.material)
          ? child.material.map(toRealistic)
          : toRealistic(child.material);
      });
    }

    const paletteMats = paletteMeshes.size > 0
      ? new Map([...paletteMeshes.entries()].map(([k, mesh]) => [k, mesh.material]))
      : null;

    const statusMats = {};
    // Seeded from whatever colours are current when the model mounts; later picks
    // are applied in place by the effect below, not by remounting the model.
    for (const k of STATUS_ORDER) statusMats[k] = makeStatusMaterial(statusColors[k]);

    dataRef.current = {
      loader, modelID, model, scene, buckets, paletteMats, allIds, siteIds,
      statusMats, activeSubsets: new Map(), highlightMat: makeMaterial(HIGHLIGHT),
    };

    let running = true;
    const mountedAt = performance.now();
    // A bounded burst of REAL renders even while hidden, for WARMUP_MS after mount.
    // WebGL only compiles a material's shader program on its first actual draw call --
    // profiling showed that compile is the dominant cost of opening this pane, and
    // with both panes now mounting in the background as soon as both files are picked
    // (see SplitCompareView's eager-mount note), that cost was STILL landing exactly
    // on the click that makes the pane visible, because this loop skipped rendering
    // entirely while hidden. Actually rendering for a few seconds right after mount
    // pays that same compile cost in the background instead, while the user is still
    // looking at another tab -- WARMUP_MS is comfortably longer than the load + first
    // simulation pass takes, so every material that will ever be drawn (palette,
    // status colours, edges, highlight) has already been compiled at least once by
    // the time it ends. After that it reverts to the original behaviour: a hidden
    // pane costs nothing, forever, same as before this existed.
    const WARMUP_MS = 5000;
    (function animate() {
      if (!running) return;
      const warmingUp = performance.now() - mountedAt < WARMUP_MS;
      // Hidden view (display:none, e.g. the other tab) past the warm-up window: keep
      // the loop alive but skip the work -- clientWidth is 0 there, so nothing is
      // drawn until it is shown again.
      if (warmingUp || (container.clientWidth && container.clientHeight)) {
        controls.update();
        renderer.render(scene, camera);
      }
      requestAnimationFrame(animate);
    })();

    // One outline per task, plus one for anything with no task -- see the matching,
    // more detailed comment in SimpleViewer.jsx. This pane is ALWAYS mid-simulation
    // (the whole point of the split view), so a single whole-model outline would spoil
    // unbuilt geometry on every frame, not just sometimes.
    const buildAllEdges = async () => {
    // Start on the next tick so mounting the pane returns (and paints) first.
    await new Promise(r => setTimeout(r, 0));
    if (!running) return;
    const vertCount = model.geometry?.attributes?.position?.count ?? 0;
    if (vertCount > 0 && vertCount < 3000000) {
      const edgeGroups = new Map();
      edgesRef.current = edgeGroups;   // filled as slices finish; cleanup disposes whatever exists
      let lastYield = performance.now();
      const edgeMaterial = () =>
        new THREE.LineBasicMaterial({ color: 0x1f2a33, transparent: true, opacity: 0.7 });
      const buildEdgesFor = (ids, key) => {
        if (!ids.length) return;
        const tempID = `__edge_tmp_${key}`;
        try {
          const subset = loader.ifcManager.createSubset({
            modelID, ids, customID: tempID, removePrevious: true,
          });
          if (!subset?.geometry?.attributes?.position?.count) return;
          const lines = new THREE.LineSegments(new THREE.EdgesGeometry(subset.geometry, 25), edgeMaterial());
          lines.visible = false;
          scene.add(lines);
          edgeGroups.set(key, lines);
        } catch (e) {
          console.warn("edge outline failed for", key, e);
        } finally {
          try { loader.ifcManager.removeSubset(modelID, undefined, tempID); } catch (e) { /* never created */ }
        }
      };
      const scheduledIds = new Set();
      if (schedule?.hasSchedule) {
        for (const task of schedule.tasks.values()) {
          if (task.isSummary || !task.elementIds.length) continue;
          if (!running) return;
          buildEdgesFor(task.elementIds, `task-${task.id}`);
          if (performance.now() - lastYield > 12) { await new Promise(r => setTimeout(r, 0)); lastYield = performance.now(); }
          for (const id of task.elementIds) scheduledIds.add(id);
        }
      }
      if (!running) return;
      buildEdgesFor(allIds.filter(id => !scheduledIds.has(id)), "unscheduled");
      if (running) setEdgesEpoch(e => e + 1);
    }
    };

    let ground = null;
    const { frame: fBox, full } = buildingFrameBox(model, siteIds, label || "split");
    if (!fBox.isEmpty()) {
      const { center, radius } = frameCamera({ camera, controls, sun }, fBox, full);
      readyApi.fitView = () => frameCamera({ camera, controls, sun }, fBox, full);
      if (siteIds.size === 0) {
        ground = makeShadowGround(center, radius, full.min.y);
        scene.add(ground);
      }
    }

    buildAllEdges();

    const onResize = () => {
      if (!container.clientWidth || !container.clientHeight) return;
      renderer.setSize(container.clientWidth, container.clientHeight);
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(container);
    window.addEventListener("resize", onResize);

    // Click-to-select, same pattern as SimpleViewer.jsx: pick whatever's under the
    // pointer and report just the element id up to SplitCompareView, which resolves
    // it to a task (translating across the Planned/Actual code-vs-id mismatch -- see
    // the note there) and drives the highlight in both panes plus the shared Gantt.
    const raycaster = new THREE.Raycaster();
    const pointerNdc = new THREE.Vector2();
    let downAt = null;
    const onPointerDown = (e) => { downAt = { x: e.clientX, y: e.clientY }; };
    const onClick = (e) => {
      const moved = downAt && ((e.clientX - downAt.x) ** 2 + (e.clientY - downAt.y) ** 2 > 25);
      downAt = null;
      if (moved) return;

      const d = dataRef.current;
      if (!d) return;

      const rect = renderer.domElement.getBoundingClientRect();
      pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointerNdc, camera);

      // Raycaster.intersectObjects ignores `.visible` on its own -- see the note in
      // SimpleViewer.jsx. Only test what is actually drawn this frame.
      const pickable = scene.children.filter(
        o => o.isMesh && o.visible && o.geometry?.attributes?.expressID
      );
      const hit = raycaster.intersectObjects(pickable, false)[0];
      const id = hit ? hit.object.geometry.attributes.expressID.getX(hit.face.a) : null;
      // Tells SplitCompareView, which resolves the owning task (translating across the
      // Planned/Actual code-vs-id mismatch), highlights it in BOTH panes, selects the
      // shared Gantt row, and shows the ONE details dialog for it -- see the note there
      // for why that dialog lives in the parent rather than one per pane.
      onPickRef.current?.(id);
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("click", onClick);

    return () => {
      running = false;
      ro.disconnect();
      window.removeEventListener("resize", onResize);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("click", onClick);
      onReady?.(null);
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
      // See the matching comment in SimpleViewer.jsx: dispose() alone leaves the WebGL
      // context alive until GC, and this pane's parent (SplitCompareView) mounts TWO of
      // these every time "Planned vs Actual" is opened. Without forcing the context to
      // release here, repeated trips in and out of the split view accumulate live
      // contexts until Chromium's per-page cap force-loses one -- possibly a pane still
      // on screen -- which reads as a half-built model or bare edges with no console
      // error, because lost-context draw calls just silently no-op.
      renderer.forceContextLoss();
      dataRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  // Applies a colour pick immediately, without remounting the model. statusMats'
  // material instances are the exact ones already assigned to whatever subsets are
  // on screen, so mutating their colour in place is enough.
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
  }, [statusColors, model]);

  // Draws the "highlight" overlay for `selectedIds` -- either the elements clicked in
  // THIS pane, or the elements of a task selected in the shared Gantt (translated to
  // this pane's own element ids by SplitCompareView). Same shape as SimpleViewer's
  // selection effect: only the overlay subset is touched, nothing else is faded.
  useEffect(() => {
    const d = dataRef.current;
    if (!d) return;
    try {
      d.loader.ifcManager.createSubset({
        modelID: d.modelID, ids: selectedIds || [], material: d.highlightMat,
        scene: d.scene, removePrevious: true, customID: "highlight",
      });
    } catch (e) {
      console.warn("highlight subset failed:", e);
    }
  }, [selectedIds, model]);

  // Same immediate-repaint pattern as statusColors above, for the highlight material.
  useEffect(() => {
    const m = dataRef.current?.highlightMat;
    if (!m) return;
    m.color.copy(new THREE.Color(highlightColor));
    m.needsUpdate = true;
  }, [highlightColor, model]);

  // Edges visibility, per outline group -- same rule as SimpleViewer's: while there is
  // a schedule to grow against, each task's outline only shows once currentDate has
  // reached that task's effStart; anything with no task ("unscheduled") always shows.
  // Without a schedule at all, every group just shows (there is nothing to grow into).
  useEffect(() => {
    const groups = edgesRef.current;
    if (!groups) return;
    const building = !!schedule?.hasSchedule;
    const t = building ? +currentDate : 0;
    for (const [key, lines] of groups) {
      if (!building || key === "unscheduled") { lines.visible = showEdges; continue; }
      const taskId = Number(key.slice(5)); // key is `task-<id>`
      const es = +(schedule.tasks.get(taskId)?.effStart || 0);
      lines.visible = showEdges && !!es && t >= es;
    }
  }, [showEdges, currentDate, schedule, edgesEpoch]);

  // The 4D build-up + traffic-light colouring. Same subset-drawing shape as
  // SimpleViewer's simulation effect; see that file for the bucket-by-bucket
  // reasoning. This pane is ALWAYS simulating -- the whole point of the split view
  // is watching both grow together under one shared playhead.
  useEffect(() => {
    const d = dataRef.current;
    if (!d || !currentDate || !schedule?.hasSchedule) return;

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

    const bucketIds = (key, keep) => {
      const all = d.buckets.get(key)?.ids || [];
      return keep ? all.filter(id => keep.has(id)) : all;
    };

    const drawNatural = (ids) => {
      if (d.paletteMats) {
        const keep = ids && new Set(ids);
        for (const [key, mat] of d.paletteMats) draw(bucketIds(key, keep), mat, key);
      } else if (ids) {
        d.model.visible = false;
        draw(ids, undefined, "sim-built");
      } else {
        d.model.visible = true;
      }
    };

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

    const statusFn = schedule?.hasBaseline
      ? (task, date) => taskStatusAt(task, date, showUpcoming)
      : (task, date) => (taskStatusAt(task, date) === "inProgress" ? "inProgress" : null);
    const { byStatus, taskCounts } = elementStatusAt(schedule, currentDate, statusFn);

    const skip = colourTerrain ? null : d.siteIds;
    const shown = skip ? (ids) => ids.filter(id => !skip.has(id)) : (ids) => ids;

    // With colouring off, nothing is judged -- every reached element falls through to
    // `trueColor` below and keeps its own material colour.
    const judged = new Set();
    if (showStatusColors) {
      for (const k of STATUS_ORDER) for (const id of shown(byStatus[k])) judged.add(id);
    }

    const t = +currentDate;
    const reached = new Set();
    for (const task of schedule.tasks.values()) {
      if (task.isSummary || !task.elementIds.length) continue;
      const es = +(task.effStart || 0);
      if (es && t >= es) for (const id of task.elementIds) reached.add(id);
    }

    const scheduled = schedule.taskOfElement || new Map();
    const trueColor = [];
    for (const id of d.allIds) {
      if (judged.has(id)) continue;
      if (!scheduled.has(id) || reached.has(id)) trueColor.push(id);
    }

    // Legend filter: with a status chip selected, only that status is drawn.
    const iso = showStatusColors ? statusFilter : null;
    drawNatural(iso ? [] : trueColor);
    if (showStatusColors) {
      for (const k of STATUS_ORDER) if (!iso || k === iso) drawStatus(k, shown(byStatus[k]));
    }
    flush();

    // Only report when the numbers actually changed -- most timeline ticks change
    // nothing, and every report re-renders the parent (toolbar, Gantt, ...). A manual
    // field compare instead of JSON.stringify-ing both sides every tick -- see
    // countsEqual above.
    if (onCountsRef.current) {
      const elements = {};
      for (const k of STATUS_ORDER) elements[k] = byStatus[k].length;
      const nextCounts = { tasks: taskCounts, elements };
      if (!countsEqual(lastCountsRef.current, nextCounts)) {
        lastCountsRef.current = nextCounts;
        onCountsRef.current({ tasks: taskCounts, elements });
      }
    }
  }, [currentDate, colourTerrain, showStatusColors, schedule, showUpcoming, statusFilter]);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "7px 12px", background: "var(--paper-2)", borderBottom: "1px solid var(--line-soft)",
                    fontFamily: "var(--font-mono)", fontSize: 11, display: "flex", gap: 8,
                    alignItems: "center", flexShrink: 0 }}>
        <strong style={{ fontFamily: "var(--font-body)", fontSize: 12, fontWeight: 600,
                        letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-700)" }}>
          {label}
        </strong>
        {!model && <span style={{ color: "var(--ink-400)" }}>Loading...</span>}
      </div>
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
      </div>
    </div>
  );
}
