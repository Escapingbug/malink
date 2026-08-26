"use client";

import { useState } from "react";
import type { GatewayEnrollmentPending } from "@malink/protocol";

export type GeneratedGatewayEnrollment = {
  link: string;
  expiresAt: number;
};

export function GatewayEnrollmentPanel({
  invitation,
  pending,
  approvedEnrollmentIds,
  busy,
  error,
  onCreate,
  onApprove,
  onClear,
}: {
  invitation: GeneratedGatewayEnrollment | null;
  pending: GatewayEnrollmentPending[];
  approvedEnrollmentIds: ReadonlySet<string>;
  busy: boolean;
  error: string | null;
  onCreate(): void;
  onApprove(enrollmentId: string, approverProjectId?: string): void;
  onClear(): void;
}) {
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const command = invitation
    ? `malink gateway join '${invitation.link}' --gateway-data-dir ~/.malink/gateway`
    : "";

  return (
    <section className="gateway-enrollment-panel" aria-live="polite">
      <header>
        <span>
          <strong>Add a Gateway</strong>
          <small>One approval connects it to every authorized client.</small>
        </span>
        <button type="button" disabled={busy} onClick={onClear}>Close</button>
      </header>

      {!invitation && pending.length === 0 && (
        <div className="gateway-enrollment-empty">
          <p>
            Create a one-time setup command, run it on the new Gateway, then
            approve the matching verification code here. No Workspace key or
            existing Gateway credential needs to be copied.
          </p>
          <button type="button" className="connect-button" disabled={busy} onClick={onCreate}>
            {busy ? "Creating setup link…" : "Create Gateway setup link"}
          </button>
        </div>
      )}

      {invitation && (
        <div className="generated-device-invitation">
          <div>
            <strong>1. Run this on the new Gateway</strong>
            <p>
              The command tells it which Matrix Workspace to contact and sends
              an access request. Change the data folder if needed.
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
              onClick={() => {
                setCopyStatus(null);
                void navigator.clipboard.writeText(command)
                  .then(() => setCopyStatus("Gateway setup command copied."))
                  .catch(() => setCopyStatus("Copy was blocked; select the command manually."));
              }}
            >
              Copy setup command
            </button>
            <button type="button" disabled={busy} onClick={onCreate}>Create a new link</button>
          </div>
          <small>Expires {formatExpiry(invitation.expiresAt)}</small>
          {copyStatus && <p role="status">{copyStatus}</p>}
        </div>
      )}

      {pending.map(request => {
        const approved = approvedEnrollmentIds.has(request.enrollmentId);
        return (
          <article className="gateway-enrollment-request" key={request.enrollmentId}>
            <span className="gateway-device-mark" aria-hidden="true">G</span>
            <span>
              <strong>
                {approved
                  ? `Approved ${request.gatewayName}`
                  : `2. Approve ${request.gatewayName}`}
              </strong>
              <small>
                {approved
                  ? "Waiting for this Gateway to finish setup. You can safely send the approval again."
                  : "Confirm this code is also shown on the new Gateway"}
              </small>
              <code>{request.verificationCode}</code>
            </span>
            <button
              type="button"
              className="connect-button"
              disabled={busy}
              onClick={() => onApprove(request.enrollmentId, request.approverProjectId)}
            >
              {busy
                ? "Sending approval…"
                : approved
                  ? "Send approval again"
                  : "Approve Gateway"}
            </button>
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
