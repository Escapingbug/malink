"use client";

import { useRef } from "react";
import { useDialogFocus } from "./dialogFocus";
import {
  NATIVE_BACK_PRIORITY,
  useNativeBackHandler,
} from "./nativeBackNavigation";

type Props = {
  open: boolean;
  deviceKind: "android" | "browser" | null;
  busy: boolean;
  error?: string | null;
  onClose(): void;
  onConfirm(): void;
};

export function GatewayForgetDialog({
  open,
  deviceKind,
  busy,
  error,
  onClose,
  onConfirm,
}: Props) {
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const requestClose = () => {
    if (!busy) onClose();
  };

  useDialogFocus({
    open,
    containerRef: dialogRef,
    initialFocusRef: cancelRef,
    escapeDisabled: busy,
    onEscape: requestClose,
  });
  useNativeBackHandler(
    open,
    () => {
      requestClose();
      return true;
    },
    NATIVE_BACK_PRIORITY.nestedModal,
  );

  if (!open) return null;
  const title = deviceKind === "android"
    ? "Sign out on this phone?"
    : deviceKind === "browser"
      ? "Sign out in this browser?"
      : "Discard this incomplete setup?";

  return (
    <div
      className="new-session-backdrop"
      role="presentation"
      onMouseDown={requestClose}
    >
      <section
        ref={dialogRef}
        className="session-delete-dialog gateway-forget-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="gateway-forget-title"
        aria-describedby={
          `gateway-forget-description gateway-forget-boundary` +
          (error ? " gateway-forget-error" : "")
        }
        aria-busy={busy}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="danger-symbol" aria-hidden="true">
          !
        </div>
        <span className="eyebrow">Current app</span>
        <h2 id="gateway-forget-title">{title}</h2>
        <p id="gateway-forget-description">
          {deviceKind
            ? `Malink will remove this ${deviceKind === "android" ? "Android app's" : "browser's"} local account, authorization, pending commands, and cached conversation history. It will also try to invalidate this app's server login.`
            : "Malink will remove only the unfinished invitation and connection information stored on this device."}
        </p>
        <div id="gateway-forget-boundary" className="delete-boundary-note">
          {deviceKind
            ? "Your Workspace, computers, and server history remain available in your other authorized apps. Being offline will not block local sign-out; use a new invitation to authorize this app again."
            : "Your Workspace, computers, sessions, and server history are not deleted."}
        </div>
        {error && (
          <div id="gateway-forget-error" className="connection-error" role="alert">
            <strong>Sign-out needs attention</strong>
            <span>{error}</span>
          </div>
        )}
        <footer>
          <button
            ref={cancelRef}
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={requestClose}
          >
            {deviceKind
              ? "Stay signed in"
              : "Keep setup"}
          </button>
          <button
            type="button"
            className="danger-button"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy
              ? deviceKind
                ? "Signing out…"
                : "Removing…"
              : deviceKind
                ? deviceKind === "android"
                  ? "Sign out on this phone"
                  : "Sign out in this browser"
                : "Discard setup"}
          </button>
        </footer>
      </section>
    </div>
  );
}

export type { Props as GatewayForgetDialogProps };
