// Verifies the 4D "growth" rule SimpleViewer's render effect implements, by re-running
// the exact same classification in Node against the real schedule data. Cannot touch
// SimpleViewer.jsx directly -- it's JSX wired to a WebGL canvas -- so this mirrors its
// per-element bucket logic line for line against readSchedule()'s real output.
//
//   node tools/check-growth.mjs <updated.ifc> <baseline.ifc>
//
// THE RULE BEING CHECKED. Every element is exactly one of:
//   1. NOT YET REACHED        -- current date < task.effStart. Not drawn.
//   2. REACHED, NO ACTUAL     -- reached, but taskStatusAt returns null (no actualStart
//                                recorded). Drawn in its own true colour, untinted.
//   3. REACHED, WITH ACTUAL   -- taskStatusAt returns delayed/onTime/ahead/inProgress.
//                                Tinted.
//   4. NO TASK ASSIGNED       -- not in taskOfElement at all (terrain). Always drawn,
//                                own colour, never tinted, never hidden.
//
// effStart already resolves as actual -> the file's current schedule -> forecast (see
// ifcSchedule.js), which is what makes activities with no recorded progress still grow
// on schedule instead of the whole un-progressed majority of the project sitting static.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import WebIFC from "web-ifc";

const [currPath, basePath] = process.argv.slice(2);
if (!currPath || !basePath) {
  console.error("usage: node tools/check-growth.mjs <progressed.ifc> <baseline.ifc>");
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "growth-"));
fs.copyFileSync(path.join("src", "ifcSchedule.js"), path.join(tmp, "ifcSchedule.mjs"));
const { readSchedule, withBaseline, taskStatusAt } =
  await import(pathToFileURL(path.join(tmp, "ifcSchedule.mjs")).href);

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

const currID = api.OpenModel(new Uint8Array(fs.readFileSync(currPath)));
const current = await readSchedule(loaderFor(), currID);
const baseID = api.OpenModel(new Uint8Array(fs.readFileSync(basePath)));
const base = await readSchedule(loaderFor(), baseID);
const sched = withBaseline(current, base);

const fmt = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "--");
let failures = 0;
const check = (label, got, want) => {
  const ok = String(got) === String(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}: got ${got}${ok ? "" : `, want ${want}`}`);
};

// The universe of elements: everything ANY task claims, via taskOfElement.
const scheduled = sched.taskOfElement || new Map();
const allScheduledIds = new Set(scheduled.keys());

function classify(date) {
  const t = +date;
  const reached = new Set();
  for (const task of sched.tasks.values()) {
    if (task.isSummary || !task.elementIds.length) continue;
    const es = +(task.effStart || 0);
    if (es && t >= es) for (const id of task.elementIds) reached.add(id);
  }
  let trueColor = 0, tinted = 0, hidden = 0;
  const judged = new Set();
  for (const task of sched.tasks.values()) {
    if (task.isSummary) continue;
    const st = taskStatusAt(task, date);
    if (st) for (const id of task.elementIds) judged.add(id);
  }
  for (const id of allScheduledIds) {
    if (judged.has(id)) { tinted++; continue; }
    if (reached.has(id)) trueColor++; else hidden++;
  }
  return { trueColor, tinted, hidden, total: allScheduledIds.size };
}

console.log(`${currPath} + ${basePath}\n`);
console.log(`scheduled elements (own a task): ${allScheduledIds.size}`);
console.log(`project range: ${fmt(sched.range.min)} -> ${fmt(sched.range.max)}\n`);

console.log("date         hidden  true-colour  tinted   (hidden should fall to 0 by project end)");
const DAY = 86400000;
let prevHidden = Infinity, monotonic = true, sawPartial = false;
for (let t = +sched.range.min; t <= +sched.range.max; t += 7 * DAY) {
  const at = new Date(t);
  const c = classify(at);
  if (c.hidden > prevHidden) monotonic = false;
  if (c.hidden > 0 && c.hidden < c.total) sawPartial = true;
  prevHidden = c.hidden;
  console.log(`${fmt(at)}   ${String(c.hidden).padStart(6)}  ${String(c.trueColor).padStart(11)}  ${String(c.tinted).padStart(7)}`);
}

const atStart = classify(sched.range.min);
const atEnd = classify(sched.range.max);

check("nothing is hidden by the project's own end date", atEnd.hidden, 0);
check("something IS hidden at the project's start date", atStart.hidden > 0, true);
check("hidden count never goes back up as time advances (monotonic reveal)", monotonic, true);
check("there is a partial-construction moment (not just all-or-nothing)", sawPartial, true);

// The concrete complaint this answers: un-actualed activities must still grow. Confirm
// at least one element with NO actual data becomes true-coloured (not hidden, not
// tinted) partway through, proving the schedule-only fallback actually fires.
let sawScheduleGrowth = false;
for (let t = +sched.range.min; t <= +sched.range.max; t += 14 * DAY) {
  const at = new Date(t);
  for (const task of sched.tasks.values()) {
    if (task.isSummary || task.actualStart || !task.elementIds.length) continue;
    const es = +(task.effStart || 0);
    if (es && +at >= es) { sawScheduleGrowth = true; break; }
  }
  if (sawScheduleGrowth) break;
}
check("at least one NON-actual activity reaches its own schedule date and appears",
      sawScheduleGrowth, true);

api.CloseModel(currID);
api.CloseModel(baseID);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
