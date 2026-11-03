import React, { useEffect, useRef, useState } from "react";

// Lucide-style 24x24 stroke paths for the floating view controls (inline, so no icon
// dependency is needed).
export const VP_ICONS = {
  layers: "M12 2 2 7l10 5 10-5-10-5ZM2 17l10 5 10-5M2 12l10 5 10-5",
  chevUp: "m18 15-6-6-6 6",
  chevDown: "m6 9 6 6 6-6",
  scan: "M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2",
  maximize: "M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7",
  minimize: "m14 10 7-7M20 10h-6V4M3 21l7-7M4 14h6v6",
  palette: "M12 22a10 10 0 1 1 10-10c0 2.8-2.2 4-4 4h-2a2 2 0 0 0-1.5 3.3c.5.6.1 1.7-.8 1.7H12ZM7.5 10.5h.01M12 7.5h.01M16.5 10.5h.01",
  calendar: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM12 14v3l2 1",
  mountain: "m8 3 4 8 5-5 5 15H2L8 3Z",
  box: "M21 8 12 3 3 8v8l9 5 9-5V8ZM3.3 7 12 12l8.7-5M12 22V12",
  chart: "M12 20V10M18 20V4M6 20v-4",
  highlighter: "m9 11-6 6v3h9l3-3M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4",
  link: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
};

export function VpIcon({ d, size = 16, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

// One row of the Display popover: icon, label, switch.
export function DisplayRow({ icon, label, checked, onChange, title }) {
  return (
    <label title={title} className={"vp-row" + (checked ? " on" : "")}>
      <VpIcon d={icon} color={checked ? "var(--aar-blue)" : "var(--ink-300)"} />
      <span className="vp-row-label">{label}</span>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)}
             style={{ display: "none" }} />
      <span className="vp-switch" />
    </label>
  );
}

export function DisplaySection({ label, children }) {
  return (
    <div className="vp-sect">
      <div className="vp-sect-label">{label}</div>
      {children}
    </div>
  );
}

/**
 * The floating view controls shared by the single viewer and Planned vs Actual: a compact
 * toolbar (Display popover, Fit view, Fullscreen) that sits top-right of its positioned
 * parent. `children` is the popover body (DisplaySection / DisplayRow).
 *
 * `fullscreenRef` is the element Fullscreen expands; `onFit` re-frames the camera(s).
 */
export default function FloatingViewControls({ onReset, onFit, fullscreenRef, children, top = 12 }) {
  const rootRef = useRef();
  const [open, setOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!fullscreenRef.current && document.fullscreenElement === fullscreenRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [fullscreenRef]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else fullscreenRef.current?.requestFullscreen?.();
  };

  return (
    <div ref={rootRef} style={{ position: "absolute", right: 12, top, zIndex: 8 }}>
      <div className="vp-toolbar">
        <button className={"vp-display" + (open ? " open" : "")} onClick={() => setOpen(o => !o)}
                title="Display options">
          <VpIcon d={VP_ICONS.layers} />
          Display
          <VpIcon d={open ? VP_ICONS.chevUp : VP_ICONS.chevDown} size={14} />
        </button>
        <span className="vp-sep" />
        <button className="vp-iconbtn" onClick={onFit} title="Fit view">
          <VpIcon d={VP_ICONS.scan} />
        </button>
        <button className="vp-iconbtn" onClick={toggleFullscreen}
                title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}>
          <VpIcon d={isFullscreen ? VP_ICONS.minimize : VP_ICONS.maximize} />
        </button>
      </div>

      {open && (
        <div className="vp-popover">
          <div className="vp-pop-head">
            <span>Display options</span>
            <button onClick={onReset}>Reset</button>
          </div>
          {children}
        </div>
      )}
    </div>
  );
}
