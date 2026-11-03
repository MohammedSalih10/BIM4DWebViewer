// Does this IFC export actually contain a BASELINE, separate from the actuals?
//
//   node tools/check-ifc-baseline.mjs <file.ifc>
//
// Run this on each new Synchro export while hunting for the right export setting. It
// answers one question and answers it from the raw STEP bytes, with no dependency on
// the app's own reader, so it cannot be fooled by a bug on our side.
//
// The decisive test is the DATE COUNT PER TASK. A task that carries both a baseline and
// an actual needs six dates (planned start/finish, schedule start/finish, actual
// start/finish). Synchro 5's IFC2X3 exporter writes at most four, and fills the Actual
// pair with a verbatim copy of the Schedule pair -- so "4 dates max, actual == schedule"
// is the signature of an export with NO baseline in it.
import fs from "node:fs";
import path from "node:path";

const file = process.argv[2];
if (!file) {
  console.error("usage: node tools/check-ifc-baseline.mjs <file.ifc>");
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error(`no such file: ${file}`);
  process.exit(2);
}

const text = fs.readFileSync(file, "utf8");

// --- header ------------------------------------------------------------------------
const schema = text.match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/)?.[1] ?? "?";
const stamp = text.match(/FILE_NAME\s*\(\s*'[^']*'\s*,\s*'([^']+)'/)?.[1] ?? "?";
const app = text.match(/IFCAPPLICATION\([^,]*,'([^']*)','([^']*)'/);
console.log(`file    : ${path.basename(file)}`);
console.log(`schema  : ${schema}`);
console.log(`exported: ${stamp}`);
console.log(`exporter: ${app ? `${app[2]} (v${app[1]})` : "?"}`);

// --- parse every STEP entity ---------------------------------------------------------
const entities = new Map();
const re = /#(\d+)=\s*([A-Z0-9_]+)\s*\(([^;]*)\)\s*;/g;
let m;
while ((m = re.exec(text))) entities.set(Number(m[1]), { type: m[2], raw: m[3] });

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

function resolveDate(attr) {
  const id = refOf(attr);
  if (id == null) return null;
  const e = entities.get(id);
  if (!e) return null;
  if (e.type === "IFCDATEANDTIME") {
    const [d, t] = splitAttrs(e.raw);
    const dd = entities.get(refOf(d));
    if (!dd) return null;
    const a = splitAttrs(dd.raw).map(Number);            // day, month, year
    let hh = 0, mi = 0;
    const tt = entities.get(refOf(t));
    if (tt) { const ta = splitAttrs(tt.raw); hh = Number(ta[0]) || 0; mi = Number(ta[1]) || 0; }
    return `${a[2]}-${String(a[1]).padStart(2, "0")}-${String(a[0]).padStart(2, "0")}` +
           ` ${String(hh).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
  }
  if (e.type === "IFCCALENDARDATE") {
    const a = splitAttrs(e.raw).map(Number);
    return `${a[2]}-${String(a[1]).padStart(2, "0")}-${String(a[0]).padStart(2, "0")}`;
  }
  return null;
}

// IfcScheduleTimeControl attribute order (IFC2X3).
const F = ["GlobalId", "OwnerHistory", "Name", "Description", "ObjectType",
  "ActualStart", "EarlyStart", "LateStart", "ScheduleStart", "ActualFinish",
  "EarlyFinish", "LateFinish", "ScheduleFinish", "ScheduleDuration", "ActualDuration",
  "RemainingTime", "FreeFloat", "TotalFloat", "IsCritical", "StatusTime", "StartFloat",
  "FinishFloat", "Completion"];

// --- walk tasks ----------------------------------------------------------------------
let nTasks = 0, nWithActual = 0, nDiffer = 0, maxDates = 0;
const differing = [];
for (const [, rel] of entities) {
  if (rel.type !== "IFCRELASSIGNSTASKS") continue;
  const a = splitAttrs(rel.raw);
  const ctrlId = refOf(a[7]);
  if (ctrlId == null) continue;
  const ctrl = entities.get(ctrlId);
  if (!ctrl || ctrl.type !== "IFCSCHEDULETIMECONTROL") continue;
  const ca = splitAttrs(ctrl.raw);
  const get = (name) => ca[F.indexOf(name)];

  const nDates = ca.filter(x => entities.get(refOf(x))?.type === "IFCDATEANDTIME").length;
  maxDates = Math.max(maxDates, nDates);

  for (const tRef of (a[4] || "").matchAll(/#(\d+)/g)) {
    const t = entities.get(Number(tRef[1]));
    if (!t || t.type !== "IFCTASK") continue;
    nTasks++;
    const ta = splitAttrs(t.raw);
    const name = unq(ta[2]);
    const code = ta.map(x => unq(x)).find(x => /^[A-Z]{1,3}\d{3,5}$/.test(x)) || "";

    const ss = resolveDate(get("ScheduleStart")), sf = resolveDate(get("ScheduleFinish"));
    const as = resolveDate(get("ActualStart")), af = resolveDate(get("ActualFinish"));
    if (as || af) nWithActual++;
    const differs = (as && ss && as !== ss) || (af && sf && af !== sf);
    if (differs) { nDiffer++; differing.push({ code, name, ss, sf, as, af }); }
  }
}

console.log(`\ntasks with a time control : ${nTasks}`);
console.log(`tasks with actual dates   : ${nWithActual}`);
console.log(`max dates on any one task : ${maxDates}`);
console.log(`tasks where actual != schedule : ${nDiffer}`);

if (differing.length) {
  console.log("\ncode    activity                      schedule                 actual");
  for (const d of differing.slice(0, 40)) {
    console.log(`${(d.code || "?").padEnd(7)} ${(d.name || "").slice(0, 28).padEnd(29)}` +
                ` ${(d.ss || "--").padEnd(17)}->${(d.sf || "--").padEnd(17)}` +
                ` ${(d.as || "--").padEnd(17)}->${(d.af || "--")}`);
  }
}

console.log("\n" + "=".repeat(72));
if (nDiffer > 0) {
  console.log(`RESULT: BASELINE PRESENT. ${nDiffer} task(s) have actual dates that differ`);
  console.log("from the schedule dates. Load this file on its own -- no baseline file needed.");
} else if (nWithActual === 0) {
  console.log("RESULT: NO PROGRESS. This export has no actual dates at all, so it is a");
  console.log("pure plan. The 4D build-up will run; there is nothing to compare against.");
} else {
  console.log("RESULT: NO VARIANCE. Actual dates exist but are a verbatim copy of the");
  console.log("schedule dates, so there is no slippage to read -- the exporter wrote the");
  console.log("current schedule into both. The viewer is single-file by design, so this");
  console.log("is expected: the 4D build-up, % complete and started/finished states all");
  console.log("still work. The traffic lights stay green unless 'Demo variance' is on.");
}
console.log("=".repeat(72));
