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
    ? "Sign out of this Android app?"
    : deviceKind === "browser"
      ? "Sign out of this browser?"
      : "Clear this device’s local setup?";

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
        <span className="eyebrow">This device</span>
        <h2 id="gateway-forget-title">{title}</h2>
        <p id="gateway-forget-description">
          {deviceKind
            ? `Malink will remove this ${deviceKind === "android" ? "Android app" : "browser"} account, authorization, pending commands, and cached conversation history. It also makes a short best-effort request to revoke the Matrix login.`
            : "This disconnects Malink and removes the saved connection, approved computer, and locally cached conversation history from this device."}
        </p>
        <div id="gateway-forget-boundary" className="delete-boundary-note">
          {deviceKind
            ? "Your Workspace, Gateways, and server history remain available on your other signed-in devices. Matrix being offline will not block local sign-out; use a new invitation to sign in again."
            : "Your sessions and data on the computer or server are not deleted."}
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
              : "Keep local setup"}
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
                ? "Sign out"
                : "Clear local setup"}
          </button>
        </footer>
      </section>
    </div>
  );
}

export type { Props as GatewayForgetDialogProps };
