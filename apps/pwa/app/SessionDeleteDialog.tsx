"use client";

import { useRef } from "react";
import type { GatewaySessionSummary } from "./gatewayState";
import { useDialogFocus } from "./dialogFocus";
import { BusyActionLabel } from "./OperationProgress";

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
        <span className="eyebrow">删除后无法直接恢复</span>
        <h2 id="session-delete-title">删除「{session.title}」？</h2>
        <p id="session-delete-description">
          此会话将从所有设备移除，无法从「已归档会话」恢复。
          {session.status !== "archived" && "如果 Agent 仍在运行，也会将其停止。"}
          {session.scope === "scratch" && "临时工作目录中的文件也将删除。"}
        </p>
        <div className="delete-boundary-note">
          如需以后快速继续，请使用「归档」。删除后只能在 Agent 仍保留历史的情况下，从「Agent 历史记录」重新接续。
        </div>
        <footer>
          <button
            ref={cancelRef}
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            className="danger-button"
            disabled={busy}
            aria-busy={busy}
            onClick={onConfirm}
          >
            {busy ? <BusyActionLabel>正在删除…</BusyActionLabel> : "删除会话"}
          </button>
        </footer>
      </section>
    </div>
  );
}
