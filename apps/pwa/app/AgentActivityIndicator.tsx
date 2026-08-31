import { useEffect, useState } from "react";
import {
  formatAgentActivityAge,
  type AgentActivity,
} from "./agentActivity";

export function AgentActivityIndicator({
  activity,
  updatedAt,
}: {
  activity: AgentActivity;
  updatedAt?: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  const validUpdatedAt =
    typeof updatedAt === "number" &&
    Number.isSafeInteger(updatedAt) &&
    updatedAt >= 0
      ? updatedAt
      : undefined;

  useEffect(() => {
    if (validUpdatedAt === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [validUpdatedAt]);

  const activityTitle = `${activity.label}${
    activity.detail ? ` · ${activity.detail}` : ""
  }`;
  const updateTime = validUpdatedAt === undefined
    ? null
    : new Date(validUpdatedAt);
  const exactTime = updateTime
    ? formatAgentActivityTime(updateTime, new Date(now))
    : null;
  const updateLabel = exactTime
    ? `Last Agent activity ${exactTime} · ${formatAgentActivityAge(validUpdatedAt!, now)}`
    : "No Agent activity received yet";

  return (
    <div
      className={`agent-activity activity-${activity.phase}`}
      title={`${activityTitle} · ${updateLabel}`}
    >
      <span className="activity-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="activity-copy">
        <span
          className="activity-state"
          role="status"
          aria-label={activityTitle}
          aria-live="polite"
          aria-atomic="true"
        >
          <strong>{activity.label}</strong>
          {activity.detail && <small>{activity.detail}</small>}
        </span>
        <small className="activity-last-update">
          {updateTime && (
            <time dateTime={updateTime.toISOString()}>{updateLabel}</time>
          )}
          {!updateTime && updateLabel}
        </small>
      </span>
    </div>
  );
}

function formatAgentActivityTime(timestamp: Date, now: Date): string {
  const sameDay = timestamp.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat(undefined, sameDay
    ? {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }
    : {
        month: "short",
        day: "numeric",
        ...(timestamp.getFullYear() === now.getFullYear()
          ? {}
          : { year: "numeric" as const }),
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(timestamp);
}
