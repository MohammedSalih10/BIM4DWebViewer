// Baseline-vs-actual variance report, read straight from the STEP bytes of two exports.
//
//   node tools/variance-report.mjs <baseline.ifc> <progressed.ifc>
//
// WHY TWO FILES: Synchro's task grid holds six date columns (BL Start/Finish, Planned
// Start/Finish, Actual Start/Finish), but its IFC2X3 writer only emits the Schedule and
// Actual pairs of IfcScheduleTimeControl -- and it writes Actual as a verbatim copy of
// Schedule, so a single export carries no variance at all. Proven by accounting for every
// IfcDateAndTime in the file: all 153 are referenced by those six fields, zero orphans.
// The baseline therefore has to come from a separate plan-only export, joined on the
// activity code in IfcTask.TaskId. This is the same join `withBaseline()` does in
// src/ifcSchedule.js, done offline so the numbers can be checked by hand.
//
// Variance sign convention: POSITIVE = late (slipped), NEGATIVE = early (ahead).
import fs from "node:fs";
import path from "node:path";

const [baseFile, currFile] = process.argv.slice(2);
if (!baseFile || !currFile) {
  console.error("usage: node tools/variance-report.mjs <baseline.ifc> <progressed.ifc>");
  process.exit(2);
}

// ---------------------------------------------------------------- STEP parsing
function splitAttrs(s) {
  const out = []; let depth = 0, cur = "", inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") inStr = !inStr;
    if (!inStr) {
      if (c === "(") depth++;
      if (c === ")") depth--;
      if (c === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    }
    cur += c;
  }
  out.push(cur);
  return out.map(x => x.trim());
}
const unq = (s) => (s || "").replace(/^'|'$/g, "");
const refOf = (a) => { const r = /^#(\d+)$/.exec(a || ""); return r ? Number(r[1]) : null; };

// IfcScheduleTimeControl attribute order (IFC2X3).
const F = ["GlobalId", "OwnerHistory", "Name", "Description", "ObjectType",
  "ActualStart", "EarlyStart", "LateStart", "ScheduleStart", "ActualFinish",
  "EarlyFinish", "LateFinish", "ScheduleFinish", "ScheduleDuration", "ActualDuration",
  "RemainingTime", "FreeFloat", "TotalFloat", "IsCritical", "StatusTime", "StartFloat",
  "FinishFloat", "Completion"];

function readTasks(file) {
  const text = fs.readFileSync(file, "utf8");
  const entities = new Map();
  const re = /#(\d+)=\s*([A-Z0-9_]+)\s*\(([^;]*)\)\s*;/g;
  let m;
  while ((m = re.exec(text))) entities.set(Number(m[1]), { type: m[2], raw: m[3] });

  // Resolve an attribute that should reference IfcDateAndTime -> a real JS Date.
  const date = (attr) => {
    const id = refOf(attr); if (id == null) return null;
    const e = entities.get(id); if (!e || e.type !== "IFCDATEANDTIME") return null;
    const [d, t] = splitAttrs(e.raw);
    const dd = entities.get(refOf(d)); if (!dd) return null;
    const [day, mon, yr] = splitAttrs(dd.raw).map(Number);
    let hh = 0, mi = 0;
    const tt = entities.get(refOf(t));
    if (tt) { const ta = splitAttrs(tt.raw); hh = Number(ta[0]) || 0; mi = Number(ta[1]) || 0; }
    return new Date(Date.UTC(yr, mon - 1, day, hh, mi));
  };

  // Elements per task, via IfcRelAssignsToProcess (RelatedObjects -> RelatingProcess).
  const elemCount = new Map();
  for (const [, r] of entities) {
    if (r.type !== "IFCRELASSIGNSTOPROCESS") continue;
    const a = splitAttrs(r.raw);
    const taskId = refOf(a[6]);
    if (taskId == null) continue;
    const n = [...(a[4] || "").matchAll(/#(\d+)/g)].length;
    elemCount.set(taskId, (elemCount.get(taskId) || 0) + n);
  }

  // Which tasks are summaries? Anything that appears as a child in IfcRelNests /
  // IfcRelAssignsToProcess-style decomposition. IFC2X3 Synchro uses IfcRelNests.
  const isParent = new Set();
  for (const [, r] of entities) {
    if (r.type !== "IFCRELNESTS" && r.type !== "IFCRELAGGREGATES") continue;
    const a = splitAttrs(r.raw);
    const p = refOf(a[4]);
    if (p != null && entities.get(p)?.type === "IFCTASK") isParent.add(p);
  }

  const tasks = new Map();
  for (const [, rel] of entities) {
    if (rel.type !== "IFCRELASSIGNSTASKS") continue;
    const a = splitAttrs(rel.raw);
    const ctrl = entities.get(refOf(a[7]));
    if (!ctrl || ctrl.type !== "IFCSCHEDULETIMECONTROL") continue;
    const ca = splitAttrs(ctrl.raw);
    const g = (n) => ca[F.indexOf(n)];
    for (const tRef of (a[4] || "").matchAll(/#(\d+)/g)) {
      const id = Number(tRef[1]);
      const t = entities.get(id);
      if (!t || t.type !== "IFCTASK") continue;
      const ta = splitAttrs(t.raw);
      const code = ta.map(unq).find(x => /^[A-Z]{1,3}\d{3,5}$/.test(x));
      if (!code) continue;                       // summary rows carry no activity code
      tasks.set(code, {
        code, id, name: unq(ta[2]),
        schedStart: date(g("ScheduleStart")), schedFinish: date(g("ScheduleFinish")),
        actStart: date(g("ActualStart")), actFinish: date(g("ActualFinish")),
        early: date(g("EarlyStart")),
        completion: Number(unq(g("Completion"))) || 0,
        elements: elemCount.get(id) || 0,
        isSummary: isParent.has(id),
      });
    }
  }
  const stamp = text.match(/FILE_NAME\s*\(\s*'[^']*'\s*,\s*'([^']+)'/)?.[1] ?? "?";
  return { tasks, stamp };
}

// ---------------------------------------------------------------- date helpers
const DAY = 86400000;
const fmt = (d) => (d ? d.toISOString().slice(0, 10) : "--");
const calDays = (a, b) => Math.round((b - a) / DAY);
function workDays(a, b) {                          // signed, Mon-Fri
  if (!a || !b) return null;
  const sign = b < a ? -1 : 1;
  let [s, e] = b < a ? [b, a] : [a, b];
  s = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()));
  e = new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth(), e.getUTCDate()));
  let n = 0;
  for (let d = new Date(s); d < e; d = new Date(d.getTime() + DAY)) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) n++;
  }
  return sign * n;
}
const sgn = (n) => (n == null ? "--" : n > 0 ? `+${n}` : String(n));

// ---------------------------------------------------------------- report
const base = readTasks(baseFile);
const curr = readTasks(currFile);

console.log(`baseline   : ${path.basename(baseFile)}  (exported ${base.stamp})  ${base.tasks.size} coded activities`);
console.log(`progressed : ${path.basename(currFile)}  (exported ${curr.stamp})  ${curr.tasks.size} coded activities`);

const codes = [...curr.tasks.keys()].sort();
const rows = [];
for (const c of codes) {
  const b = base.tasks.get(c), t = curr.tasks.get(c);
  if (!b) { rows.push({ code: c, name: t.name, missing: true }); continue; }

  // Baseline = the plan-only export's Schedule pair. Actual = the progressed export's
  // Actual pair where it exists; otherwise EarlyStart is Synchro's forecast start.
  const blS = b.schedStart, blF = b.schedFinish;
  const isDone = !!(t.actStart && t.actFinish);
  const acS = isDone ? t.actStart : (t.early || null);
  const acF = isDone ? t.actFinish : null;

  rows.push({
    code: c, name: t.name, elements: t.elements, done: isDone,
    completion: t.completion, blS, blF, acS, acF,
    dS: acS && blS ? workDays(blS, acS) : null,
    dF: acF && blF ? workDays(blF, acF) : null,
    dSc: acS && blS ? calDays(blS, acS) : null,
    dFc: acF && blF ? calDays(blF, acF) : null,
  });
}

// ---- completed activities: the trustworthy numbers -------------------------------
const done = rows.filter(r => r.done);
console.log(`\n${"=".repeat(104)}`);
console.log("COMPLETED ACTIVITIES  -  baseline vs actual   (variance in WORKING days; + = late, - = early)");
console.log("=".repeat(104));
console.log("code     activity                       BL start    BL finish   Act start   Act finish   dStart  dFinish   el");
for (const r of done) {
  console.log(
    r.code.padEnd(9) + r.name.slice(0, 30).padEnd(31) +
    fmt(r.blS).padEnd(12) + fmt(r.blF).padEnd(12) +
    fmt(r.acS).padEnd(12) + fmt(r.acF).padEnd(13) +
    sgn(r.dS).padStart(6) + sgn(r.dF).padStart(9) + String(r.elements).padStart(5));
}
const slipped = done.filter(r => (r.dF ?? 0) > 0);
const early = done.filter(r => (r.dF ?? 0) < 0);
const onTime = done.filter(r => (r.dF ?? 0) === 0);
const elLate = slipped.reduce((s, r) => s + r.elements, 0);
const worst = [...done].sort((a, b) => (b.dF ?? 0) - (a.dF ?? 0))[0];
console.log("-".repeat(104));
console.log(`${done.length} complete: ${slipped.length} late, ${onTime.length} on time, ${early.length} early`);
if (worst) console.log(`worst slip: ${worst.code} ${worst.name} ${sgn(worst.dF)} working days (${sgn(worst.dFc)} calendar)`);
console.log(`elements owned by late activities: ${elLate}  (these are what render RED)`);
const sumS = done.reduce((s, r) => s + (r.dS ?? 0), 0);
const sumF = done.reduce((s, r) => s + (r.dF ?? 0), 0);
console.log(`total start variance ${sgn(sumS)} wd, total finish variance ${sgn(sumF)} wd, ` +
  `mean finish variance ${done.length ? (sumF / done.length).toFixed(1) : "0"} wd`);

// ---- in-progress / not started ---------------------------------------------------
const open = rows.filter(r => !r.done && !r.missing);
console.log(`\n${"=".repeat(104)}`);
console.log("NOT YET COMPLETE  -  baseline vs forecast start (EarlyStart)");
console.log("=".repeat(104));
console.log("code     activity                       BL start    BL finish   Forecast     dStart   el  %");
for (const r of open) {
  console.log(
    r.code.padEnd(9) + r.name.slice(0, 30).padEnd(31) +
    fmt(r.blS).padEnd(12) + fmt(r.blF).padEnd(12) + fmt(r.acS).padEnd(13) +
    sgn(r.dS).padStart(7) + String(r.elements).padStart(5) + String(r.completion || 0).padStart(4));
}
const missing = rows.filter(r => r.missing);
if (missing.length) {
  console.log(`\n${missing.length} activity code(s) not present in the baseline file: ` +
    missing.map(r => `${r.code} ${r.name}`).join(", "));
}
const gone = [...base.tasks.keys()].filter(c => !curr.tasks.has(c));
if (gone.length) console.log(`${gone.length} baseline activity code(s) dropped from the progressed file: ${gone.join(", ")}`);
