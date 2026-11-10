// Headless render smoke test for the Gantt panel.
//
//   node tools/check-gantt-render.mjs
//
// WHY THIS EXISTS. `vite build` type-checks nothing and does no scope analysis, so a
// JSX expression referencing a variable that no longer exists builds perfectly and then
// throws `ReferenceError` the moment React renders it. That is exactly how removing the
// `bl` (hasBaseline) flag from GanttChart shipped a white screen: the Gantt only mounts
// once a schedule has loaded, so the crash fired on IFC upload, long after the build.
//
// Rendering the component on the server executes every render-path expression and turns
// that class of bug back into a build-time failure. useEffect never runs under
// renderToString, which is why the window.addEventListener drag handlers are not a
// problem here.
//
// No new dependency: vite compiles the JSX (ssrLoadModule) and react-dom is already
// required by the app. Externalised node_modules mean the component gets the same React
// instance this file imports, so hooks work.
import { createServer } from "vite";
import React from "react";
import ReactDOMServer from "react-dom/server";

const DAY = 86400000;
const d = (s) => new Date(s);

/** A schedule shaped exactly like readSchedule()'s return value, small enough to eyeball.
 *  Covers the branches the row renderer walks: a summary with children, a critical task,
 *  a task with actuals, a task with neither, and one dependency arrow. */
function fixture() {
  const mk = (id, name, code, over = {}) => ({
    id, name, code,
    parent: null, children: [], depth: 0,
    isSummary: false, critical: false,
    start: d("2026-06-10"), finish: d("2026-06-20"),
    actualStart: null, actualFinish: null,
    effStart: d("2026-06-10"), effFinish: d("2026-06-20"),
    varianceDays: 0, totalFloat: 0, elementIds: [1, 2],
    completion: 0,
    ...over,
  });

  const summary = mk(1, "Construction Works", "", { isSummary: true, children: [2, 3] });
  const done = mk(2, "Excavation and Earthworks", "A1040", {
    parent: 1, depth: 1, critical: true,
    actualStart: d("2026-07-09"), actualFinish: d("2026-07-16"),
    effStart: d("2026-07-09"), effFinish: d("2026-07-16"), completion: 100,
  });
  const pending = mk(3, "GF Walls", "A1090", { parent: 1, depth: 1, critical: true });
  const lone = mk(4, "Project Closure", "A1200", {});

  const rows = [summary, done, pending, lone];
  const tasks = new Map(rows.map(t => [t.id, t]));

  return {
    hasSchedule: true,
    tasks, rows,
    roots: [1, 4],
    links: [{ from: 2, to: 3, type: "FS", lagDays: 0 }],
    criticalIds: new Set([2, 3]),
    range: { min: d("2026-06-10"), max: d("2027-01-27") },
    dataDate: d("2026-08-01"),
    cyclic: false,
    taskOfElement: new Map(), linkedElements: new Set(),
  };
}

// noExternal is required, not cosmetic: SSR hands node_modules straight to Node's ESM
// loader, which skips the resolve.alias in vite.config.js. web-ifc-three imports
// "three/examples/jsm/utils/BufferGeometryUtils" with no file extension -- legal for a
// bundler, rejected by Node -- and that alias is what redirects it to src/shims. Routing
// both packages through vite instead applies the alias, exactly as the browser build does.
const server = await createServer({
  server: { middlewareMode: true }, appType: "custom", logLevel: "error",
  ssr: { noExternal: ["web-ifc-three", "three"] },
});
let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m, e) => { failures++; console.log(`  FAIL  ${m}\n        ${e}`); };

try {
  // 1. Every module must at least load. Catches bad imports left behind by a refactor,
  //    e.g. a deleted p6Xml still being imported somewhere.
  console.log("MODULE LOAD");
  for (const m of ["/src/GanttChart.jsx", "/src/SimpleViewer.jsx", "/src/App.jsx",
                   "/src/ifcSchedule.js", "/src/ifcElements.js", "/src/ifcMaterials.js"]) {
    try { await server.ssrLoadModule(m); pass(m); }
    catch (e) { fail(m, e.message); }
  }

  // 2. The render itself -- the check that would have caught `bl is not defined`.
  console.log("\nGANTT RENDER");
  const { default: GanttChart } = await server.ssrLoadModule("/src/GanttChart.jsx");
  const schedule = fixture();
  const props = {
    schedule, currentDate: d("2026-08-01"), onDateChange: () => {},
    selectedTaskId: null, onSelectTask: () => {},
    playing: false, onTogglePlay: () => {}, speed: 1, onSpeedChange: () => {},
  };

  let html = "";
  try {
    html = ReactDOMServer.renderToString(React.createElement(GanttChart, props));
    pass(`rendered with a schedule (${html.length} chars of HTML)`);
  } catch (e) {
    fail("rendered with a schedule", `${e.name}: ${e.message}`);
  }

  // The empty state must survive too -- it is what shows before any file is picked.
  try {
    ReactDOMServer.renderToString(React.createElement(GanttChart, { ...props, schedule: null }));
    pass("rendered with schedule = null (pre-upload state)");
  } catch (e) {
    fail("rendered with schedule = null", `${e.name}: ${e.message}`);
  }

  // 2b. SimpleViewer's own JSX. All the Three.js work lives in useEffect, which
  //     renderToString never runs, so the component body and its toolbar render fine
  //     without WebGL. This is the check that was missing when removing the `bl` flag
  //     from GanttChart shipped a white screen -- deleting a piece of state while the
  //     JSX still reads it is a ReferenceError, and nothing else catches it.
  console.log("\nSIMPLEVIEWER RENDER");
  try {
    const { default: SimpleViewer } = await server.ssrLoadModule("/src/SimpleViewer.jsx");
    ReactDOMServer.renderToString(React.createElement(SimpleViewer, { ifcUrl: null }));
    pass("rendered with no file loaded");
    ReactDOMServer.renderToString(
      React.createElement(SimpleViewer, { ifcUrl: "blob:x", baselineUrl: "blob:y" }));
    pass("rendered with both file props set");
  } catch (e) {
    fail("SimpleViewer render", `${e.name}: ${e.message}`);
  }

  try {
    const { default: App } = await server.ssrLoadModule("/src/App.jsx");
    ReactDOMServer.renderToString(React.createElement(App));
    pass("App renders (both upload slots)");
  } catch (e) {
    fail("App render", `${e.name}: ${e.message}`);
  }

  // 3. The date columns are labelled BL Start / BL Finish ONLY when a baseline has been
  //    merged. Both states are asserted because both have shipped broken: the `bl` flag
  //    is read in three places (headers, legend swatch, Var tooltip) and dropping one
  //    of them is a ReferenceError that only fires once a schedule exists.
  if (html) {
    console.log("\nCOLUMNS -- no baseline");
    const has = (s) => html.includes(s);
    has(">Start<") && has(">Finish<")
      ? pass('Start / Finish columns present')
      : fail("Start/Finish headers", "not found in rendered output");
    !has("BL Start") && !has("BL Finish")
      ? pass('no "BL Start" / "BL Finish" without a baseline file')
      : fail("BL headers", 'rendered "BL" with hasBaseline unset');
    has("Actual Start") && has("Actual Finish")
      ? pass("Actual columns present")
      : fail("Actual headers", "not found in rendered output");
    has("Excavation and Earthworks") && has("A1040")
      ? pass("task rows rendered")
      : fail("task rows", "fixture tasks missing from output");

    // The bug this replaced: an activity with no actuals borrowed its scheduled date
    // into the Actual column, so an untouched project read as fully under way.
    //
    // Counting the green actual styling is the precise test. Both Actual HEADERS carry
    // it unconditionally, so a task with no actuals must show exactly 2 occurrences; a
    // task with actuals adds one per filled cell. Matching on the date text instead
    // gives false positives -- the bar's title tooltip repeats it.
    console.log("\nACTUAL COLUMNS ARE RECORDED FACTS ONLY");
    const GREEN = "color:var(--status-ontime)";
    const countGreen = (task) => {
      const one = { ...fixture(), rows: [task], tasks: new Map([[task.id, task]]) };
      const out = ReactDOMServer.renderToString(
        React.createElement(GanttChart, { ...props, schedule: one }));
      return out.split(GREEN).length - 1;
    };
    const bare = countGreen(fixture().tasks.get(3));   // GF Walls: no actuals at all
    const withActuals = countGreen(fixture().tasks.get(2));  // Excavation: both actuals

    bare === 2
      ? pass("not-started task leaves both Actual cells blank (headers only)")
      : fail("Actual leakage", `expected 2 green spans (the headers), got ${bare}`);
    withActuals === 4
      ? pass("completed task fills both Actual cells")
      : fail("Actual cells", `expected 4 green spans, got ${withActuals}`);

    console.log("\nHEADERS -- baseline merged");
    // What withBaseline() returns: start/finish become the PLAN, actuals stay put, and
    // the variance is the gap. Excavation's real numbers, from the b2 new.xml check.
    const withBL = fixture();
    withBL.hasBaseline = true;
    withBL.baselineSource = "ifc";
    const exc = withBL.tasks.get(2);
    exc.start = d("2026-07-06");
    exc.finish = d("2026-07-09");
    exc.varianceDays = 7;
    try {
      const blHtml = ReactDOMServer.renderToString(
        React.createElement(GanttChart, { ...props, schedule: withBL }));
      const blHas = (s) => blHtml.includes(s);
      blHas("BL Start") && blHas("BL Finish")
        ? pass('columns read "BL Start" / "BL Finish"')
        : fail("BL column headers", "not found with hasBaseline set");
      !blHas("Planned Start")
        ? pass('no "Planned Start" once a baseline is merged')
        : fail("stale header", '"Planned Start" still rendered alongside BL');
      blHas("Baseline")
        ? pass('legend swatch reads "Baseline"')
        : fail("legend swatch", '"Baseline" not found -- the `bl` flag is not reaching it');
    } catch (e) {
      fail("render with baseline merged", `${e.name}: ${e.message}`);
    }
  }
} finally {
  await server.close();
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
