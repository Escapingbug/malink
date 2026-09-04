"use client";

import { useState } from "react";
import type { GatewayEnrollmentPending } from "@malink/protocol";
import { writeClipboardTextWithTimeout } from "./uiClipboard";
import { BusyActionLabel } from "./OperationProgress";

export type GeneratedGatewayEnrollment = {
  link: string;
  expiresAt: number;
};

export type GatewayEnrollmentBusyState =
  | { kind: "create" }
  | { kind: "approve"; enrollmentId: string }
  | null;

export function GatewayEnrollmentPanel({
  invitation,
  pending,
  approvedEnrollmentIds,
  busy,
  error,
  onCreate,
  onApprove,
  onCancel,
  onClear,
}: {
  invitation: GeneratedGatewayEnrollment | null;
  pending: GatewayEnrollmentPending[];
  approvedEnrollmentIds: ReadonlySet<string>;
  busy: GatewayEnrollmentBusyState;
  error: string | null;
  onCreate(): void;
  onApprove(enrollmentId: string, approverProjectId?: string): void;
  onCancel(request: GatewayEnrollmentPending): void;
  onClear(): void;
}) {
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [copyBusy, setCopyBusy] = useState(false);
  const operationBusy = busy !== null;
  const command = invitation
    ? `malink gateway join '${invitation.link}' --gateway-data-dir ~/.malink/gateway --activate-host`
    : "";

  return (
    <section className="gateway-enrollment-panel" aria-live="polite">
      <header>
        <span>
          <strong>Add a Workspace computer</strong>
          <small>The new computer will run projects and Agents for every authorized device.</small>
        </span>
        <button type="button" disabled={operationBusy} onClick={onClear}>Close</button>
      </header>

      {!invitation && (
        <div className="gateway-enrollment-empty">
          <p>
            {pending.length > 0
              ? "Review the request below, or create a separate setup command for another computer."
              : "Create a one-time setup command, run it on the new computer, then approve the matching verification code here."}
          </p>
          <button type="button" className="connect-button" disabled={operationBusy} onClick={onCreate}>
            {busy?.kind === "create"
              ? <BusyActionLabel>Creating setup link…</BusyActionLabel>
              : pending.length > 0
                ? "Set up another computer"
                : "Create computer setup command"}
          </button>
        </div>
      )}

      {invitation && (
        <div className="generated-device-invitation">
          <div>
            <strong>1. Run this on the new computer</strong>
            <p>
              The command tells it which Matrix Workspace to contact and sends
              an access request. The computer cannot join until you approve it here.
            </p>
          </div>
          <label>
            <span>One-time setup command</span>
            <textarea value={command} readOnly rows={4} spellCheck={false} />
          </label>
          <div className="pairing-actions">
            <button
              type="button"
              className="scan-button"
              disabled={copyBusy || operationBusy}
              onClick={() => {
                setCopyStatus(null);
                setCopyBusy(true);
                void writeClipboardTextWithTimeout(command)
                  .then(() => setCopyStatus("Gateway setup command copied."))
                  .catch(() => setCopyStatus("Copy was blocked; select the command manually."))
                  .finally(() => setCopyBusy(false));
              }}
            >
              {copyBusy ? <BusyActionLabel>Copying…</BusyActionLabel> : "Copy computer setup command"}
            </button>
            <button type="button" disabled={operationBusy || copyBusy} onClick={onCreate}>
              {busy?.kind === "create"
                ? <BusyActionLabel>Creating new link…</BusyActionLabel>
                : "Create a new link"}
            </button>
          </div>
          <small>Expires {formatExpiry(invitation.expiresAt)}</small>
          {copyStatus && <p role="status">{copyStatus}</p>}
        </div>
      )}

      {pending.map(request => {
        const approved = approvedEnrollmentIds.has(request.enrollmentId);
        const approvingThisRequest = busy?.kind === "approve"
          && busy.enrollmentId === request.enrollmentId;
        return (
          <article className="gateway-enrollment-request" key={request.enrollmentId}>
            <span className="gateway-device-mark" aria-hidden="true">G</span>
            <span>
              <strong>
                {approved
                  ? `Approved ${request.gatewayName}`
                  : `2. Approve computer · ${request.gatewayName}`}
              </strong>
              <small>
                {approved
                  ? "Approval was delivered. Keep Malink open while the new computer starts and publishes its projects."
                  : "Confirm this code is also shown on the new Gateway"}
              </small>
              <code>{request.verificationCode}</code>
            </span>
            {approved
              ? (
                <span className="gateway-enrollment-approved" role="status">
                  <strong>Approved</strong>
                  <small>Finishing setup on the new computer…</small>
                </span>
              )
              : (
                <div className="pairing-actions">
                  <button
                    type="button"
                    className="connect-button"
                    disabled={operationBusy}
                    onClick={() => onApprove(request.enrollmentId, request.approverProjectId)}
                  >
                    {approvingThisRequest
                      ? <BusyActionLabel>Sending approval…</BusyActionLabel>
                      : "Approve computer"}
                  </button>
                  <button
                    type="button"
                    disabled={operationBusy}
                    onClick={() => onCancel(request)}
                  >
                    Abandon request
                  </button>
                </div>
              )}
          </article>
        );
      })}

      {error && <p className="pairing-inline-error" role="alert">{error}</p>}
    </section>
  );
}

function formatExpiry(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}
