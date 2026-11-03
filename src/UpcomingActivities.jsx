import React, { useMemo } from "react";
import { TASK_STATUS } from "./ifcSchedule";

const STATUS_ORDER = ["delayed", "onTime", "ahead", "inProgress"];
const css = color => `#${color.toString(16).padStart(6, "0")}`;
const statusColor = (key, colors) => colors?.[key] || css(TASK_STATUS[key].color);

function fmt(d) {
  if (!d) return "";
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${m}-${day}`;
}

// Forecast variance is useful before work begins: compare the current/forecast dates
// against the merged BL Start and BL Finish, independently of the playhead.
function upcomingStatus(task, hasBaseline) {
  if (task.actualStart && !task.actualFinish) return "inProgress";
  if (!hasBaseline || task.baselineMatched === false) return null;

  const baseStart = +(task.start || 0);
  const baseFinish = +(task.finish || 0);
  const expectedStart = +(task.effStart || 0);
  const expectedFinish = +(task.effFinish || 0);
  if (!baseStart || !baseFinish || !expectedStart || !expectedFinish) return null;
  if (expectedStart > baseStart || expectedFinish > baseFinish) return "delayed";
  if (expectedStart < baseStart || expectedFinish < baseFinish) return "ahead";
  return "onTime";
}

/**
 * A baseline-aware list of current and future leaf activities. Future work is
 * coloured by forecast versus baseline; activity already under way is blue.
 * Completed activities and summary rows are excluded.
 */
export default function UpcomingActivities({ schedule, asOf, selectedTaskId, onSelectTask,
                                            statusColors, limit = 30 }) {
  // Memoized, and hoisted above the early return below so the hook itself always
  // runs (React hooks can't follow a conditional return). Without this, every render
  // of this panel -- including every ~120ms playback tick while it's open -- rescanned,
  // mapped, filtered and sorted the WHOLE task list from scratch, even on ticks where
  // the upcoming list hadn't actually changed.
  const upcoming = useMemo(() => {
    if (!schedule?.hasSchedule || !asOf) return [];
    const t = +asOf;
    return [...schedule.tasks.values()]
      .filter(task => !task.isSummary && !task.actualFinish)
      .map(task => {
        if (task.actualStart) return { task, start: +task.actualStart, status: "inProgress" };
        const start = +(task.effStart || task.start || 0);
        if (!start || start <= t) return null;
        return { task, start, status: upcomingStatus(task, schedule.hasBaseline) };
      })
      .filter(Boolean)
      .sort((a, b) => a.start - b.start)
      .slice(0, limit);
  }, [schedule, asOf, limit]);

  if (!schedule?.hasSchedule || !asOf) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px", flexWrap: "wrap",
                    fontSize: 11.5, color: "var(--ink-600)", borderBottom: "1px solid var(--paper-cool)",
                    flexShrink: 0 }}>
        <span style={{ color: "var(--ink-400)" }}>Forecast vs BL</span>
        {STATUS_ORDER.map(key => (
          <span key={key} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 7, height: 7, background: statusColor(key, statusColors),
                          display: "inline-block" }} />
            {TASK_STATUS[key].label}
          </span>
        ))}
      </div>

      <div style={{ overflowY: "auto", flex: 1 }}>
        {upcoming.length === 0 && (
          <div style={{ padding: 10, fontSize: 11.5, color: "var(--ink-400)" }}>
            Nothing current or upcoming -- every activity has finished or has no forward date.
          </div>
        )}
        {upcoming.map(({ task, status }) => {
          const sel = task.id === selectedTaskId;
          const statusLabel = status ? TASK_STATUS[status].label : "No baseline";
          return (
            <div
              key={task.id}
              onClick={() => onSelectTask(sel ? null : task.id)}
              title={`${task.name} — ${statusLabel}`}
              style={{
                display: "flex", alignItems: "center", gap: 9, padding: "8px 12px",
                fontSize: 11.5, cursor: "pointer", borderBottom: "1px solid var(--paper-cool)",
                background: sel ? "var(--aar-blue-fog)" : "transparent",
              }}
            >
              <span style={{ width: 8, height: 8, flexShrink: 0,
                             background: status ? statusColor(status, statusColors) : "var(--ink-300)",
                             display: "inline-block" }} />
              {task.code && (
                <span style={{ color: "var(--ink-400)", fontFamily: "var(--font-mono)", fontSize: 11,
                               flexShrink: 0 }}>
                  {task.code}
                </span>
              )}
              <span style={{ flex: 1, fontWeight: 500, color: "var(--ink-700)", overflow: "hidden",
                             textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {task.name}
              </span>
              <span style={{ color: "var(--ink-400)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
                {fmt(task.effStart || task.start)}
              </span>
              <span style={{ color: status ? statusColor(status, statusColors) : "var(--ink-400)",
                             fontWeight: 600, fontSize: 11.5, whiteSpace: "nowrap",
                             textAlign: "right", flexShrink: 0 }}>
                {statusLabel}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
