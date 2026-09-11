"use client";

import { FormEvent, useRef, useState } from "react";
import type { GatewaySessionSummary } from "./gatewayState";
import { useDialogFocus } from "./dialogFocus";
import { BusyActionLabel } from "./OperationProgress";

type Props = {
  session: GatewaySessionSummary;
  busy: boolean;
  error: string | null;
  onClose(): void;
  onConfirm(title: string): void;
};

export function SessionRenameDialog({
  session,
  busy,
  error,
  onClose,
  onConfirm,
}: Props) {
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(session.title);

  useDialogFocus({
    open: true,
    containerRef: dialogRef,
    initialFocusRef: inputRef,
    escapeDisabled: busy,
    onEscape: onClose,
  });

  const normalizedTitle = title.trim();
  const unchanged = normalizedTitle === session.title;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!normalizedTitle || unchanged || busy) return;
    onConfirm(normalizedTitle);
  }

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
        className="session-rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-rename-title"
        aria-describedby="session-rename-description"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="eyebrow">Conversation name</span>
        <h2 id="session-rename-title">Rename conversation</h2>
        <p id="session-rename-description">
          The new name will appear on your other approved devices after they sync.
        </p>
        <form onSubmit={submit}>
          <label>
            <span>Name</span>
            <input
              ref={inputRef}
              value={title}
              maxLength={512}
              disabled={busy}
              aria-invalid={Boolean(error) || undefined}
              aria-describedby={error ? "session-rename-error" : undefined}
              onChange={(event) => setTitle(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          {error && (
            <p id="session-rename-error" className="session-rename-error" role="alert">
              {error}
            </p>
          )}
          <footer>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="primary-button"
              disabled={!normalizedTitle || unchanged || busy}
              aria-busy={busy}
            >
              {busy ? <BusyActionLabel>Renaming…</BusyActionLabel> : "Save name"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
