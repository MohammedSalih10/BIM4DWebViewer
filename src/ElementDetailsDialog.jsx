import React from "react";

// Short date format, matching the Gantt's own -- no time-of-day, since the schedule
// only ever carries day-level precision (see ifcSchedule.js's clock-time note).
function fmt(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Small floating panel shown after a click-to-select in the 3D view: the ACTIVITY
 * that builds the clicked element as the heading (its own name/code and Critical
 * badge), the element's own content name as a subtitle underneath, and the
 * activity's full set of dates (current, baseline once one is loaded, actual).
 *
 * Closing it only hides the panel -- see the note in SimpleViewer.jsx's effect for why
 * it deliberately does NOT also clear the 3D highlight or the Gantt-row selection.
 */
export default function ElementDetailsDialog({ details, onClose, placement = "bottomRight" }) {
  if (!details) return null;
  const { name, task, hasBaseline, note, timeless, category, level, taskLabel } = details;

  // 3D View: a larger card -- Name / Category / Level / Activity (linked task's name
  // only), no dates or other schedule data.
  if (timeless) {
    const rows = [["Name", name], ["Category", category], ["Level", level], ["Activity", taskLabel]];
    return (
      <div style={{
        position: "absolute", width: 380,
        ...(placement === "divider"
          ? { left: "50%", bottom: 10, transform: "translateX(-50%)" }
          : { right: 10, bottom: 10 }),
        background: "var(--paper)", border: "1px solid var(--line-strong)",
        boxShadow: "var(--elev-3)", zIndex: 8, fontSize: 13,
      }}>
        <div style={{ padding: "12px 14px 10px", borderBottom: "1px solid var(--line-soft)", display: "flex",
                      justifyContent: "space-between", alignItems: "center", gap: 10 }}>
          <span style={{ fontWeight: 600, fontSize: 15, color: "var(--ink-700)" }}>Element Details</span>
          <button
            onClick={onClose} title="Close"
            style={{ fontFamily: "inherit", fontSize: 14, background: "transparent", border: 0,
                     color: "var(--ink-400)", cursor: "pointer", flexShrink: 0, padding: "0 2px" }}
          >
            ✕
          </button>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", margin: "4px 0 8px" }}>
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <td style={{ color: "var(--ink-400)", padding: "6px 0 6px 14px", width: 78, verticalAlign: "top" }}>{k}</td>
                <td style={{ color: "var(--ink-700)", fontWeight: 500, padding: "6px 14px 6px 8px",
                             wordBreak: "break-word" }}>{v || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div style={{
      position: "absolute", width: 292,
      ...(placement === "divider"
        ? { left: "50%", bottom: 10, transform: "translateX(-50%)" }
        : { right: 10, bottom: 10 }),
      background: "var(--paper)", border: "1px solid var(--line-strong)",
      boxShadow: "var(--elev-3)", zIndex: 8, fontSize: 12,
    }}>
      <div style={{ padding: "11px 12px 9px", borderBottom: "1px solid var(--line-soft)", display: "flex",
                    justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          {/* No task -- fall back to the element's own name, since there is nothing
              else to head the dialog with. */}
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}
               title={task ? task.name : name}>
            <span style={{ fontWeight: 600, fontSize: 14.5, color: "var(--ink-700)", overflow: "hidden",
                          textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {task ? task.name : name}
            </span>
            {task?.code && <span style={{ fontSize: 12, color: "var(--ink-400)" }}>({task.code})</span>}
            {task && (
              <span style={{ fontSize: 12.5, fontWeight: 600,
                            color: task.critical ? "var(--status-delayed)" : "var(--ink-400)" }}>
                {task.critical ? "Critical" : "Non-critical"}
              </span>
            )}
          </div>
          {task && (
            <div style={{ color: "var(--ink-400)", fontSize: 11, fontFamily: "var(--font-mono)",
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                          marginTop: 2 }} title={name}>
              {name}
            </div>
          )}
        </div>
        <button
          onClick={onClose} title="Close"
          style={{ fontFamily: "inherit", fontSize: 13, background: "transparent", border: 0,
                   color: "var(--ink-400)", cursor: "pointer", flexShrink: 0, padding: "0 2px" }}
        >
          ✕
        </button>
      </div>

      <div style={{ padding: "2px 12px 11px" }}>
        {!task ? (
          <div style={{ color: "var(--ink-400)", padding: "8px 0" }}>
            {note || "No activity assigned to this element."}
          </div>
        ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <tbody>
                <tr>
                  <td style={{ color: "var(--ink-700)", fontSize: 12, padding: "3px 0" }}>Start</td>
                  <td style={{ fontSize: 12.5, fontWeight: 500, color: "var(--ink-700)" }}>{fmt(task.curStart)}</td>
                  <td style={{ color: "var(--ink-700)", fontSize: 12, paddingLeft: 10 }}>Finish</td>
                  <td style={{ fontSize: 12.5, fontWeight: 500, color: "var(--ink-700)" }}>{fmt(task.curFinish)}</td>
                </tr>
                {/* task.start/finish are the BASELINE dates whenever a baseline IFC has
                    been merged (withBaseline overwrites them in place -- see
                    ifcSchedule.js). Shown unconditionally, not just when hasBaseline:
                    without one they still hold the file's OWN planned dates, which
                    is the split view's Planned pane's entire situation -- that pane's
                    schedule is never merged with itself, so hasBaseline is always
                    false there even though task.start/finish are perfectly real. */}
                <tr>
                  <td style={{ color: "var(--aar-blue-deep)", fontSize: 12, padding: "3px 0" }}>BL Start</td>
                  <td style={{ fontSize: 12.5, fontWeight: 500, color: "var(--ink-700)" }}>{fmt(task.start)}</td>
                  <td style={{ color: "var(--aar-blue-deep)", fontSize: 12, paddingLeft: 10 }}>BL Finish</td>
                  <td style={{ fontSize: 12.5, fontWeight: 500, color: "var(--ink-700)" }}>{fmt(task.finish)}</td>
                </tr>
                <tr>
                  <td style={{ color: "var(--status-ontime)", fontSize: 12, padding: "3px 0" }}>Actual Start</td>
                  <td style={{ fontSize: 12.5, fontWeight: 500, color: "var(--ink-700)" }}>{fmt(task.actualStart)}</td>
                  <td style={{ color: "var(--status-ontime)", fontSize: 12, paddingLeft: 10 }}>Actual Finish</td>
                  <td style={{ fontSize: 12.5, fontWeight: 500, color: "var(--ink-700)" }}>{fmt(task.actualFinish)}</td>
                </tr>
                <tr>
                  <td style={{ color: "var(--ink-400)", fontSize: 12, padding: "3px 0" }}>Complete</td>
                  <td style={{ fontSize: 12.5, fontWeight: 500, color: "var(--ink-700)" }}>
                    {task.completion != null ? `${task.completion}%` : "—"}
                  </td>
                  <td style={{ color: "var(--ink-400)", fontSize: 12, paddingLeft: 10 }}>Float</td>
                  <td style={{ fontSize: 12.5, fontWeight: 500, color: "var(--ink-700)" }}>
                    {task.totalFloat != null ? `${task.totalFloat}d` : "—"}
                  </td>
                </tr>
                {hasBaseline && (
                  <tr>
                    <td style={{ color: "var(--ink-400)", fontSize: 12, padding: "3px 0" }}>Variance</td>
                    <td colSpan={3} style={{
                      fontSize: 12.5, fontWeight: 600,
                      color: task.varianceDays > 0 ? "var(--status-delayed)" : "var(--status-ontime)",
                    }}>
                      {task.varianceDays > 0 ? `+${task.varianceDays}d late`
                        : task.varianceDays < 0 ? `${Math.abs(task.varianceDays)}d early`
                        : "on time"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
        )}
      </div>
    </div>
  );
}
