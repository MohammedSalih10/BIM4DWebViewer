// What does the viewer actually get from ONE IFC, with no baseline? Runs the real
// production readSchedule so this is what the app will show, not an approximation.
//
//   node tools/check-single-file.mjs newsynchro.ifc
//
// Same harness as check-bl-merge.mjs: readSchedule only touches
// loader.ifcManager.state.api and .idsByType, so a small fake loader drives it in Node.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import WebIFC from "web-ifc";

const file = process.argv[2];
if (!file) {
  console.error("usage: node tools/check-single-file.mjs <model.ifc>");
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "single-"));
fs.copyFileSync(path.join("src", "ifcSchedule.js"), path.join(tmp, "ifcSchedule.mjs"));
const { readSchedule } = await import(pathToFileURL(path.join(tmp, "ifcSchedule.mjs")).href);

const api = new WebIFC.IfcAPI();
api.SetWasmPath(path.join("node_modules", "web-ifc") + path.sep, true);
await api.Init();
const modelID = api.OpenModel(new Uint8Array(fs.readFileSync(file)));
const loader = {
  ifcManager: {
    state: { api },
    idsByType: async (m, cls) => {
      const v = api.GetLineIDsWithType(m, WebIFC[cls.toUpperCase()]);
      return { size: () => v.size(), get: (i) => v.get(i) };
    },
  },
};

const fmt = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "--");
const s = await readSchedule(loader, modelID);

console.log(`${file}\n`);
if (!s?.hasSchedule) { console.log("no schedule in file"); process.exit(1); }

const real = [...s.tasks.values()].filter(t => !t.isSummary);
const withEl = real.filter(t => t.elementIds.length > 0);
const done = real.filter(t => t.actualFinish);
const started = real.filter(t => t.actualStart && !t.actualFinish);
const varied = real.filter(t => t.varianceDays !== 0);
const variedWithEl = varied.filter(t => t.elementIds.length > 0);

console.log("WHAT THE VIEWER GETS");
console.log(`  tasks                        ${s.tasks.size} (${real.length} real, ${s.tasks.size - real.length} summary)`);
console.log(`  tasks owning geometry        ${withEl.length}`);
console.log(`  dependency links             ${s.links.length}`);
console.log(`  critical path                ${s.criticalIds.size}`);
console.log(`  timeline                     ${fmt(s.range?.min)} -> ${fmt(s.range?.max)}`);
console.log(`  data date                    ${fmt(s.dataDate)}`);
console.log(`  complete / in progress       ${done.length} / ${started.length}`);

console.log("\nWHAT IT CANNOT SHOW");
console.log(`  tasks with variance != 0     ${varied.length}`);
console.log(`  ...of those, owning geometry ${variedWithEl.length}   <- what could render RED`);
if (varied.length) {
  for (const t of varied.slice(0, 5))
    console.log(`     ${(t.code || "?").padEnd(8)} ${(t.name || "").slice(0, 28).padEnd(29)}` +
                `${t.varianceDays > 0 ? "+" : ""}${t.varianceDays}d, ${t.elementIds.length} elements`);
}

console.log("\nGANTT DATE COLUMNS (first 8 real tasks)");
console.log("  code     activity                     Planned start  Planned finish  Act start   Act finish");
for (const t of real.slice(0, 8))
  console.log(`  ${(t.code || "?").padEnd(8)} ${(t.name || "").slice(0, 27).padEnd(28)}` +
              `${fmt(t.start).padEnd(15)}${fmt(t.finish).padEnd(16)}` +
              `${fmt(t.actualStart).padEnd(12)}${fmt(t.actualFinish)}`);

console.log(`\n  Headers read "Planned", not "BL": hasBaseline = ${!!s.hasBaseline}`);
api.CloseModel(modelID);
fs.rmSync(tmp, { recursive: true, force: true });
