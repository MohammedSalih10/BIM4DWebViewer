import React, { useEffect, useRef, useState } from "react";
import { TASK_STATUS, STATUS_ORDER } from "./ifcSchedule";

/**
 * A small popover for picking the four traffic-light colours, or reverting to the
 * app's defaults. Lives next to each viewer's "Colour coding" checkbox.
 *
 * Deliberately NOT the on/off switch itself -- "system colours" (no colour coding at
 * all) is already what that checkbox unchecked means, so this only has to offer
 * customising the colours used WHEN it's on, not a second way to turn it off.
 */
export default function ColorCodingSettings({ colors, onChange, onReset }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef();

  // Click-away dismiss, same pattern as any other lightweight popover.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={boxRef} style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      <button
        onClick={() => setOpen(o => !o)}
        title="Choose the delayed / on time / ahead / in-progress colours"
        style={{
          display: "inline-flex", alignItems: "center", gap: 3, fontFamily: "inherit", fontSize: 11.5,
          padding: "4px 7px", cursor: "pointer", background: open ? "var(--aar-blue-fog)" : "var(--paper)",
          border: "1px solid " + (open ? "var(--aar-blue)" : "var(--line-soft)"),
        }}
      >
        {STATUS_ORDER.map(k => (
          <span key={k} style={{ width: 11, height: 11, background: colors[k], display: "inline-block" }} />
        ))}
        <span style={{ fontSize: 10.5, color: "var(--ink-400)" }}>▾</span>
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 20,
          background: "var(--paper)", border: "1px solid var(--line-strong)",
          boxShadow: "var(--elev-2)", width: 238,
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                        padding: "9px 11px", borderBottom: "1px solid var(--line-soft)" }}>
            <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em",
                          textTransform: "uppercase", color: "var(--ink-700)" }}>
              Status colours
            </span>
            <button
              onClick={onReset}
              style={{ fontFamily: "inherit", fontSize: 11, background: "transparent", border: 0,
                       color: "var(--aar-blue)", cursor: "pointer", padding: 0 }}
            >
              Reset
            </button>
          </div>
          {STATUS_ORDER.map(k => (
            <div key={k} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 11px",
                                  borderBottom: "1px solid var(--paper-cool)" }}>
              <input
                type="color"
                value={colors[k]}
                onChange={e => onChange(k, e.target.value)}
                style={{ width: 26, height: 22, padding: 0, border: "1px solid var(--line-strong)",
                         background: "none", cursor: "pointer", flexShrink: 0 }}
              />
              <span style={{ flex: 1, fontSize: 12, fontWeight: 500, color: "var(--ink-700)" }}>
                {TASK_STATUS[k].label}
              </span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--ink-400)",
                            textTransform: "uppercase" }}>
                {colors[k]}
              </span>
            </div>
          ))}
          <div style={{ padding: "8px 11px", fontSize: 11.5, lineHeight: 1.45, color: "var(--ink-400)",
                        background: "var(--paper-2)" }}>
            Applies to the model, schedule bars and the Upcoming activities panel.
          </div>
        </div>
      )}
    </div>
  );
}
