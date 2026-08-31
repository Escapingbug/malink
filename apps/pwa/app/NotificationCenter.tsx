"use client";

import { useRef } from "react";
import { useDialogFocus } from "./dialogFocus";
import { OperationProgress } from "./OperationProgress";
import type { UiNoticeSeverity } from "./uiNotices";

export type NotificationCenterAction = {
  label: string;
  primary?: boolean;
  disabled?: boolean;
  onClick(): void;
};

export type NotificationCenterItem = {
  key: string;
  severity: UiNoticeSeverity;
  title: string;
  detail: string;
  active?: boolean;
  meta?: string;
  actions?: NotificationCenterAction[];
};

type Props = {
  open: boolean;
  items: NotificationCenterItem[];
  onClose(): void;
};

export function NotificationCenter(props: Props) {
  if (!props.open) return null;
  return <NotificationCenterContent {...props} />;
}

function NotificationCenterContent({ open, items, onClose }: Props) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useDialogFocus({
    open,
    containerRef: panelRef,
    initialFocusRef: closeRef,
    onEscape: onClose,
  });

  return (
    <div
      className="notification-center-backdrop"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        ref={panelRef}
        className="notification-center"
        role="dialog"
        aria-modal="true"
        aria-labelledby="notification-center-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="eyebrow">Workspace</span>
            <h2 id="notification-center-title">Notifications &amp; issues</h2>
            <p>
              Hidden messages stay here while their operation is still relevant.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close notifications"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="notification-center-list">
          {items.length === 0 ? (
            <div className="notification-center-empty">
              <span aria-hidden="true">✓</span>
              <strong>Nothing needs your attention</strong>
              <p>New errors, updates, and interrupted actions will appear here.</p>
            </div>
          ) : items.map((item) => (
            <article
              key={item.key}
              className={`notification-center-item notification-center-item-${item.severity}${item.active ? " notification-center-item-active" : ""}`}
              role={item.severity === "error" ? "alert" : "status"}
              aria-live={item.active ? "polite" : undefined}
              aria-atomic={item.active ? "true" : undefined}
            >
              {item.active ? (
                <OperationProgress className="notification-center-item-icon" />
              ) : (
                <span className="notification-center-item-icon" aria-hidden="true">
                  {item.severity === "error"
                    ? "!"
                    : item.severity === "success"
                      ? "✓"
                      : item.severity === "warning"
                        ? "!"
                        : "i"}
                </span>
              )}
              <div>
                <strong>{item.title}</strong>
                <p>{item.detail}</p>
                {item.meta && <small>{item.meta}</small>}
                {item.actions && item.actions.length > 0 && (
                  <div className="notification-center-item-actions">
                    {item.actions.map((action) => (
                      <button
                        key={action.label}
                        type="button"
                        className={action.primary ? "primary" : "secondary"}
                        disabled={action.disabled}
                        onClick={action.onClick}
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </article>
          ))}
        </div>

        <footer>
          <small>Closing this panel never cancels a Gateway or Agent operation.</small>
          <button type="button" onClick={onClose}>Close</button>
        </footer>
      </section>
    </div>
  );
}
