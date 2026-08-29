"use client";

import { useRef } from "react";
import type { GatewaySessionSummary } from "./gatewayState";
import { useDialogFocus } from "./dialogFocus";

type Props = {
  session: GatewaySessionSummary | null;
  busy: boolean;
  onClose(): void;
  onConfirm(): void;
};

export function SessionDeleteDialog({
  session,
  busy,
  onClose,
  onConfirm,
}: Props) {
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useDialogFocus({
    open: session !== null,
    containerRef: dialogRef,
    initialFocusRef: cancelRef,
    escapeDisabled: busy,
    onEscape: onClose,
  });

  if (!session) return null;

  return (
    <div
      className="new-session-backdrop"
      role="presentation"
      onMouseDown={() => {
        if (!busy) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="session-delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="session-delete-title"
        aria-describedby="session-delete-description"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="danger-symbol" aria-hidden="true">
          !
        </div>
        <span className="eyebrow">Permanent action</span>
        <h2 id="session-delete-title">Delete “{session.title}”?</h2>
        <p id="session-delete-description">
          This removes the session from Malink on every connected device
          {session.status === "archived"
            ? "."
            : " and stops its agent if it is still running."}
        </p>
        <div className="delete-boundary-note">
          Copies already stored by your account provider or coding agent are
          not erased.
        </div>
        <footer>
          <button
            ref={cancelRef}
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="danger-button"
            disabled={busy}
            aria-busy={busy}
            onClick={onConfirm}
          >
            {busy ? "Deleting…" : "Delete session"}
          </button>
        </footer>
      </section>
    </div>
  );
}
