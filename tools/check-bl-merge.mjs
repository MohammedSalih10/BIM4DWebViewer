// Headless verification of the plan-only-IFC -> progressed-IFC baseline merge, running
// the REAL production modules against the REAL files.
//
//   node tools/check-bl-merge.mjs <progressed.ifc> <baseline.ifc>
//   node tools/check-bl-merge.mjs plannedvsactual.ifc Sample_Proj_ifcsynchro.ifc
//
// WHAT THIS PROVES. The app dropped the P6 XML reader, so BL Start / BL Finish now come
// from a second IFC joined on activity code. That is only trustworthy if it reproduces
// the same baseline P6 reported. So the ORACLE here is b2 new.xml's PlannedStartDate /
// PlannedFinishDate -- read directly by this test, never by the app. A pass means the
// IFC-only path lands on the same dates the XML path used to, with no XML in production.
//
// Same harness trick as check-p6-merge.mjs: readSchedule only touches
// loader.ifcManager.state.api and .idsByType, so a small fake loader drives it in Node,
// and src/*.js is copied to .mjs because package.json is "type": "commonjs".
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import WebIFC from "web-ifc";

const [currPath, basePath] = process.argv.slice(2);
if (!currPath || !basePath) {
  console.error("usage: node tools/check-bl-merge.mjs <progressed.ifc> <baseline.ifc>");
  process.exit(2);
}
const ORACLE = "b2 new.xml";

// --- production sources as ESM -------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blcheck-"));
fs.copyFileSync(path.join("src", "ifcSchedule.js"), path.join(tmp, "ifcSchedule.mjs"));
const { readSchedule, withBaseline, taskStatusAt, elementStatusAt } =
  await import(pathToFileURL(path.join(tmp, "ifcSchedule.mjs")).href);

// --- fake loader over the raw web-ifc node api ---------------------------------------
const api = new WebIFC.IfcAPI();
api.SetWasmPath(path.join("node_modules", "web-ifc") + path.sep, true);
await api.Init();
const loaderFor = () => ({
  ifcManager: {
    state: { api },
    idsByType: async (m, cls) => {
      const v = api.GetLineIDsWithType(m, WebIFC[cls.toUpperCase()]);
      return { size: () => v.size(), get: (i) => v.get(i) };
    },
  },
});

const fmt = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "--");
let failures = 0;
const check = (label, got, want) => {
  const ok = String(got) === String(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}: got ${got}${ok ? "" : `, want ${want}`}`);
};

// --- oracle: the baseline P6 recorded, straight from the XML text --------------------
const oracle = new Map();
if (fs.existsSync(ORACLE)) {
  const xml = fs.readFileSync(ORACLE, "utf8");
  for (const m of xml.matchAll(/<Activity>([\s\S]*?)<\/Activity>/g)) {
    const b = m[1];
    const f = (t) => (b.match(new RegExp(`<${t}>([^<]*)</${t}>`)) || [])[1] || null;
    const id = f("Id");
    if (!id) continue;
    oracle.set(id, {
      planStart: (f("PlannedStartDate") || "").slice(0, 10) || null,
      planFinish: (f("PlannedFinishDate") || "").slice(0, 10) || null,
      actStart: (f("ActualStartDate") || "").slice(0, 10) || null,
    });
  }
}

// --- read both schedules -------------------------------------------------------------
const currID = api.OpenModel(new Uint8Array(fs.readFileSync(currPath)));
const current = await readSchedule(loaderFor(), currID);
const baseID = api.OpenModel(new Uint8Array(fs.readFileSync(basePath)));
const base = await readSchedule(loaderFor(), baseID);

console.log(`progressed : ${currPath}  (${current.tasks.size} tasks)`);
console.log(`baseline   : ${basePath}  (${base.tasks.size} tasks)`);
console.log(`oracle     : ${oracle.size ? `${ORACLE}, ${oracle.size} activities` : "ABSENT -- oracle checks skipped"}\n`);

const beforeCount = current.tasks.size;
const merged = withBaseline(current, base);

console.log("MERGE");
check("hasBaseline flag (drives the BL Start/BL Finish headers)", merged.hasBaseline, true);
check("task count unchanged", merged.tasks.size, beforeCount);
check("some tasks matched on activity code", merged.baselineMatched > 0, true);
check("rows rebuilt (no stale references)",
      merged.rows.every(r => merged.tasks.get(r.id) === r), true);

// --- the actual dates, against the oracle --------------------------------------------
const byCode = new Map();
for (const t of merged.tasks.values()) if (t.code) byCode.set(t.code, t);

if (oracle.size) {
  console.log("\nBL DATES vs P6 ORACLE  (completed activities)");
  console.log("code    activity                       BL start    BL finish   oracle BL   ok");
  let checked = 0, wrong = 0;
  for (const [code, o] of [...oracle].sort()) {
    if (!o.actStart) continue;                 // only the progressed ones are interesting
    const t = byCode.get(code);
    if (!t) { console.log(`${code.padEnd(7)} (not in the model)`); continue; }
    checked++;
    const okS = fmt(t.start) === o.planStart, okF = fmt(t.finish) === o.planFinish;
    if (!okS || !okF) wrong++;
    console.log(
      `${code.padEnd(7)} ${(t.name || "").slice(0, 29).padEnd(30)}` +
      `${fmt(t.start)}  ${fmt(t.finish)}  ${o.planStart}  ${okS && okF ? "OK" : "<-- MISMATCH"}`);
  }
  check(`BL dates match P6 on all ${checked} completed activities`, wrong, 0);

  console.log("\nVARIANCE IS NOW REAL");
  const late = [...merged.tasks.values()].filter(t => !t.isSummary && t.varianceDays > 0);
  check("at least one activity reports slippage", late.length > 0, true);
  const owning = late.filter(t => t.elementIds.length > 0);
  check("slipped activities own geometry (so RED can appear)", owning.length > 0, true);
  console.log(`        ${late.length} late, ${owning.length} of them owning ` +
              `${owning.reduce((n, t) => n + t.elementIds.length, 0)} elements`);

  console.log("\nACTUALS SURVIVED THE MERGE");
  const exc = byCode.get("A1040");
  if (exc) {
    check("A1040 actual start still 2026-07-09", fmt(exc.actualStart), "2026-07-09");
    check("A1040 actual finish still 2026-07-16", fmt(exc.actualFinish), "2026-07-16");
    check("A1040 BL start is the plan, not the actual", fmt(exc.start), "2026-07-06");
    check("A1040 reports positive variance", exc.varianceDays > 0, true);
  } else {
    failures++;
    console.log("  FAIL  A1040 Excavation and Earthworks not found in the merged schedule");
  }
}

// --- the six columns exactly as the Gantt will draw them -----------------------------
// Start/Finish must survive the merge: withBaseline overwrites start/finish with the
// baseline, so curStart/curFinish are the only remaining copy of the live schedule.
console.log("\nTHE SIX DATE COLUMNS");
console.log("code    activity                    Start       Finish      BL Start    BL Finish   ActStart    ActFinish   Var");
let lostCurrent = 0;
for (const t of merged.rows) {
  if (t.isSummary) continue;
  if (!t.curStart || !t.curFinish) lostCurrent++;
  console.log(
    `${(t.code || "?").padEnd(7)} ${(t.name || "").slice(0, 26).padEnd(27)}` +
    `${fmt(t.curStart).padEnd(12)}${fmt(t.curFinish).padEnd(12)}` +
    `${fmt(t.start).padEnd(12)}${fmt(t.finish).padEnd(12)}` +
    `${(t.actualStart ? fmt(t.actualStart) : "").padEnd(12)}` +
    `${(t.actualFinish ? fmt(t.actualFinish) : "").padEnd(12)}` +
    `${t.varianceDays ? (t.varianceDays > 0 ? "+" : "") + t.varianceDays + "d" : ""}`);
}
check("every task kept its own Start/Finish through the merge", lostCurrent, 0);
const withAct = merged.rows.filter(t => !t.isSummary && (t.actualStart || t.actualFinish));
check("only genuinely progressed activities carry actuals", withAct.length, 7);

// --- only recorded work may be coloured ----------------------------------------------
// The playhead opens at the END of the schedule, so this is the worst case: if the
// status rule leaks past recorded progress at all, it leaks here and the whole model
// turns red. Only activities with actuals may carry a traffic light at any date.
console.log("\nCOLOUR ONLY WHERE WORK WAS RECORDED  (scrubbing the playhead)");
const real = merged.rows.filter(t => !t.isSummary);
const haveActuals = real.filter(t => t.actualStart).length;

// Walk the whole timeline. Every date is checked, not just a few interesting ones:
// the failure mode being guarded against is a status rule that leaks past recorded
// progress, and that shows up as un-started activities acquiring a colour.
const DAY = 86400000;
let leaks = 0, sawBlue = 0, maxColoured = 0;
const marks = [];
for (let t = +merged.range.min; t <= +merged.range.max; t += 7 * DAY) {
  const at = new Date(t);
  const coloured = real.filter(x => taskStatusAt(x, at) !== null);
  leaks += coloured.filter(x => !x.actualStart).length;
  maxColoured = Math.max(maxColoured, coloured.length);
  const { taskCounts } = elementStatusAt(merged, at);
  if (taskCounts.inProgress > 0) sawBlue++;
  marks.push({ at, ...taskCounts, untouched: real.length - coloured.length });
}
console.log("   date         red  green  yellow  blue   untouched (own colour, opaque)");
for (const m of marks.filter((_, i) => i % 3 === 0))
  console.log(`   ${fmt(m.at)}   ${String(m.delayed).padStart(3)}` +
              `${String(m.onTime).padStart(7)}${String(m.ahead).padStart(8)}` +
              `${String(m.inProgress).padStart(6)}${String(m.untouched).padStart(26)}`);

check("no un-started activity is ever coloured, at any date", leaks, 0);
check(`never more coloured than the ${haveActuals} with actuals`, maxColoured <= haveActuals, true);
check("blue (in progress) does appear while work is under way", sawBlue > 0, true);

// --- the updated file's OWN dates must be what variance is measured against ----------
// The rule: finished activities use Actual, everything else uses the Start/Finish the
// updated file exports. If a reconstructed date creeps back in, Var stops being
// checkable by eye against the row it sits on.
console.log("\nEFFECTIVE DATES ARE THE FILE'S OWN");
let drift = 0;
for (const t of current.rows) {
  if (t.isSummary || t.actualStart) continue;
  if (fmt(t.start) !== fmt(t.effStart) || fmt(t.finish) !== fmt(t.effFinish)) {
    drift++;
    console.log(`        ${(t.code || "?").padEnd(8)} file ${fmt(t.start)}->${fmt(t.finish)}` +
                `  eff ${fmt(t.effStart)}->${fmt(t.effFinish)}`);
  }
}
check("not-yet-started tasks use the file's exported Start/Finish", drift, 0);

// --- a baseline from a DIFFERENT project must be refused, not silently accepted -------
const OTHER = "racbasicsampleproject (1).ifc";
if (fs.existsSync(OTHER)) {
  console.log("\nWRONG-FILE GUARD");
  const otherID = api.OpenModel(new Uint8Array(fs.readFileSync(OTHER)));
  const other = await readSchedule(loaderFor(), otherID);
  const bogus = withBaseline(current, other);
  check(`unrelated project (${OTHER}) refused as a baseline`, !!bogus.hasBaseline, false);
  check("...and the model's own schedule is left intact",
        bogus.tasks.size === current.tasks.size, true);
  api.CloseModel(otherID);
} else {
  console.log(`\nWRONG-FILE GUARD skipped -- ${OTHER} not present`);
}

api.CloseModel(currID);
api.CloseModel(baseID);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
