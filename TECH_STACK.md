# 4D BIM Web Viewer — Tech Stack & Architecture

_A snapshot of what this project is actually built on, as of 2026-08-07._

---

## 1. What this is

A browser-based 4D BIM viewer: load one or two IFC files (a progressed model and,
optionally, a plan-only baseline), read the embedded construction schedule, and watch
the building grow on a timeline with traffic-light colour coding (delayed / on time /
ahead / in progress). Three views share the same engine: a single **4D Simulation**
view, a chrome-free **3D View** for pure model/property inspection, and a side-by-side
**Planned vs Actual** comparison.

No backend. Everything — IFC parsing, schedule reading, 3D rendering, critical-path
maths — runs client-side in the browser.

---

## 2. Web stack (build tooling)

| Piece | Version | Role |
|---|---|---|
| **Vite** | ^8.1.5 | Dev server + production bundler. `npm run dev` / `npm run build` / `npm run preview`. |
| **@vitejs/plugin-react** | ^6.0.4 | JSX transform + Fast Refresh for Vite. |
| **React** | ^19.2.8 | UI layer — every panel, dialog and toolbar is a component. |
| **React DOM** | ^19.2.8 | Renders the component tree to the DOM (`src/main.jsx`). |

Plain JavaScript/JSX, no TypeScript. No CSS framework — one hand-written stylesheet
(`src/theme.css`) of CSS custom properties, everything else is inline React styles.

---

## 3. Open-source frameworks & libraries

| Library | Version | What it's used for |
|---|---|---|
| **three.js** | ^0.149.0 | All 3D rendering: scene graph, `WebGLRenderer`, `OrbitControls`, `PMREMGenerator` for image-based lighting, `EdgesGeometry` for outlines, shadow mapping. |
| **web-ifc** | ^0.0.77 | The underlying WASM IFC parser (by That Open Company / IFC.js). Ships as `public/wasm/web-ifc.wasm`, `web-ifc-mt.wasm`, `web-ifc-api-iife.js`. |
| **web-ifc-three** | ^0.0.126 | Bridges web-ifc into three.js: `IFCLoader`, the `IfcManager` subset/highlight API every colour and outline pass in this app is built on (`createSubset`/`removeSubset`). |
| **Google Fonts** — Golos Text, PT Serif | (CDN) | Body and display typefaces, loaded via `@import` in `theme.css`. No npm package — a plain `@font-face` fetch. |

**Verification tooling (not shipped, dev-only):** Playwright + a locally cached
Chromium build were used during this session to drive the real app in headless
Chrome and screenshot the result after each UI change — not a runtime dependency of
the app itself.

**Deliberately not used:** no state-management library (plain `useState`/`useEffect`),
no UI component library (every button/checkbox/popover is hand-rolled in
`theme.css`'s design language), no charting library (the Gantt chart is hand-drawn
`<div>`/`<svg>`), no CSS-in-JS library (plain inline `style={{...}}` objects).

---

## 4. In-house code

Everything under `src/` is custom to this project. Roughly two layers: **IFC/schedule
reading** (pure logic, framework-agnostic) and **React components** (the UI).

### 4a. IFC & schedule engine (`src/*.js`)

| File | Job |
|---|---|
| `ifcSchedule.js` | The one shared 4D-schedule reader. Pulls the WBS task tree, planned/actual/baseline dates, dependency links, and which elements each task builds, out of `IfcScheduleTimeControl` (not `IfcTask` directly — see the file's header for the IFC2X3 traps this had to work around). Also runs the critical-path (longest driving path, not just zero-float) calculation, and `withBaseline()` / merge logic for combining a progressed export with an earlier plan-only one. |
| `p6Xml.js` | Hand-parsed reader (no `DOMParser`, so it also runs under Node for the test harness) for Primavera P6's XML export — the **preferred** baseline source, since P6 XML carries true Planned/Actual/BL dates in one file where a Synchro IFC2X3 export cannot. |
| `ifcElements.js` | Builds the "Contents" panel tree — elements grouped as building elements (wall, slab, door), by storey then category then type, the way Synchro's own Contents panel presents them. |
| `ifcMaterials.js` | The opposite question: "what is this made of" — infers a plausible material/colour from element/type names for files (like Synchro's) that strip real IFC colour data, plus the shared status/highlight material factories every viewer uses. |
| `elementDetails.js` | On-demand, single-element fetch (name + owning task + dates) for the click-to-inspect popover — deliberately a third, separate pass from the two bulk reads above. |
| `viewFraming.js` | Shared camera-framing math (`buildingFrameBox`, `frameCamera`, `makeShadowGround`) — fits the camera to the *building*, excluding terrain/site outliers, measured rather than guessed. Used by every viewer so framing never drifts apart between them. |
| `shims/BufferGeometryUtils.js` | Small compatibility shim so `web-ifc-three` finds `mergeGeometries` regardless of which three.js version's export name it expects. |

### 4b. React components (`src/*.jsx`)

| File | Job |
|---|---|
| `App.jsx` | Top-level shell: header (branding, project name, the 3D View / 4D Simulation / Planned vs Actual tabs), the two-slot IFC upload row, and the footer. |
| `SimpleViewer.jsx` | The main engine: loads an IFC, drives the three.js scene, the 4D build-up/colour-coding effect, the Contents panel, and hosts the Gantt chart. Also renders **3D View** — same component, `viewMode` prop toggles the schedule-only chrome off. |
| `SplitCompareView.jsx` | **Planned vs Actual**: loads both files through one shared `IFCLoader` (a real web-ifc-three constraint — see the file's header), keeps two `Viewport3D` panes under one shared playhead and an optional camera lock. |
| `Viewport3D.jsx` | One render+build-up pane, used twice by `SplitCompareView` — no file loading of its own, just "given a loaded model, grow it." |
| `GanttChart.jsx` | The bottom schedule panel: WBS tree, time-scaled bars, dependency arrows, critical path, draggable playhead. One shared component for the single view and the split view's merged Gantt. |
| `ColorCodingSettings.jsx` | The status-colour swatch-editor popover. |
| `UpcomingActivities.jsx` | Forward-looking activity list, coloured by forecast-vs-baseline. |
| `ElementDetailsDialog.jsx` | The click-to-inspect popover (dates, variance, critical flag). |
| `Split4D.jsx` | Retired — the original side-by-side comparison, superseded by `SplitCompareView.jsx`. Unimported; kept only in case any of it is wanted back. |

### 4c. Design system (`src/theme.css`)

One hand-written stylesheet of CSS custom properties (colour scale, type scale, 8pt
spacing, sharp-corner radii) that every component's inline styles reference —
`color: 'var(--ink-700)'` etc. — so there is exactly one place that defines the
Aarvee Engineering Consultants brand look (`#0093D2` "Aarvee Blue", PT Serif display
type, Golos Text body). The logo mark lives at `src/assets/RV.svg`.

---

### 4d. Dev tooling (`tools/*.mjs`)

Node scripts (not bundled into the app) that exercise the IFC/schedule engine
headlessly against local sample files: `check-bl-merge`, `check-gantt-render`,
`check-growth`, `check-ifc-baseline`, `check-single-file`, `variance-report`.

### 4e. Repository hygiene (`.gitignore`)

Ignores `node_modules/`, build output (`dist/`), logs, `.env*`, editor/OS files,
Claude Code's `.claude/settings.local.json`, Playwright artifacts, and sample model
files (`*.ifc`, `*.ifczip`, `*.xer`) — large and may contain client data, so they stay
local. `package-lock.json` and `public/wasm/*` **are** tracked (the lockfile pins
versions; the WASM binaries are needed at runtime).

---

## 5. Data formats read

- **IFC2X3 / IFC4** — the model geometry, and (via `IfcScheduleTimeControl`) the
  embedded 4D schedule, read straight out of Synchro 4D Pro exports.
- **Primavera P6 XML** (`APIBusinessObjects` schema) — an optional, more reliable
  baseline/actuals source than a second IFC export.

## 6. What's notably *not* in this stack

No backend/API, no database, no auth, no build step beyond Vite, no design tool
integration beyond the one-time mockup import — the whole app is a static bundle that runs entirely in the browser.
