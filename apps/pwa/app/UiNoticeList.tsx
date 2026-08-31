"use client";

import { OperationProgress } from "./OperationProgress";
import type { UiNotice } from "./uiNotices";

export function UiNoticeList({
  notices,
  className,
  onDismiss,
}: {
  notices: UiNotice[];
  className?: string;
  onDismiss(key: string): void;
}) {
  if (notices.length === 0) return null;
  return (
    <div className={`ui-notice-list ${className ?? ""}`}>
      {notices.map((notice) => (
        <div
          key={notice.key}
          className={`ui-notice ui-notice-${notice.severity}${notice.active ? " ui-notice-active" : ""}`}
          role={notice.severity === "error" ? "alert" : "status"}
          aria-live={notice.active ? "polite" : undefined}
          aria-atomic={notice.active ? "true" : undefined}
        >
          {notice.active ? (
            <OperationProgress />
          ) : (
            <span aria-hidden="true">
              {notice.severity === "error"
                ? "!"
                : notice.severity === "success"
                  ? "✓"
                  : "i"}
            </span>
          )}
          <p>{notice.message}</p>
          <button
            type="button"
            aria-label="Dismiss message"
            onClick={() => onDismiss(notice.key)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
