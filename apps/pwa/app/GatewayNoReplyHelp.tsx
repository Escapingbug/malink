"use client";

import React from "react";
import type { GatewayUpdateStatus } from "@malink/protocol";
import type { GatewayUpdateRecoveryAction } from "./gatewayUpdateRecovery";

const GATEWAY_RESTART_COMMAND =
  "for service in com.malink.matrix-gateway io.malink.gateway; do launchctl kickstart -k \"gui/$(id -u)/$service\" 2>/dev/null && break; done";
const GATEWAY_UPDATE_ISSUE_URL =
  "https://github.com/Escapingbug/malink/issues/new?labels=bug&title=Gateway%20update%20failure";
const GATEWAY_FORWARD_UPDATE_DOC_URL =
  "https://github.com/Escapingbug/malink/blob/main/docs/gateway-online-updates.md#bootstrap-an-older-supervisor-across-a-protected-state-boundary";

export function GatewayNoReplyHelp({
  gatewayLabel,
  consecutiveNoReplies,
  onExportDiagnostics,
  diagnosticExportBusy = false,
}: {
  gatewayLabel: string;
  consecutiveNoReplies: number | undefined;
  onExportDiagnostics(): void;
  diagnosticExportBusy?: boolean;
}) {
  const persistent = (consecutiveNoReplies ?? 1) >= 2;
  return (
    <details className="gateway-no-reply-help">
      <summary>{persistent ? "Diagnose this Gateway" : "What should I do?"}</summary>
      <div>
        <p>
          {persistent
            ? `The client is connected to Matrix, but ${gatewayLabel} has repeatedly failed to return a signed health result.`
            : "One missed check is not enough to prove a fault. Wait a moment and check once more before changing anything."}
        </p>
        <ol>
          <li>On {gatewayLabel}, confirm the Mac is awake and connected to the internet.</li>
          <li>
            If the next check also fails, restart the Gateway once from Terminal:
            <code>{GATEWAY_RESTART_COMMAND}</code>
          </li>
          <li>
            If it still does not reply, collect
            <code>~/.config/malink/gateway.error.log</code> and
            <code>~/.local/share/malink-matrix/update-supervisor.error.log</code>
            from that Mac.
          </li>
        </ol>
        <p>
          Malink cannot remotely restart a Gateway that is not answering. The exported report
          records what this client observed; startup failures also require the Gateway logs above.
        </p>
        <button
          type="button"
          className="secondary-button"
          disabled={diagnosticExportBusy}
          aria-busy={diagnosticExportBusy}
          onClick={onExportDiagnostics}
        >
          {diagnosticExportBusy ? "Exporting diagnostics…" : "Export client diagnostics"}
        </button>
      </div>
    </details>
  );
}

export function GatewayUpdateFailureHelp({
  gatewayLabel,
  status,
  recovery,
  onExportDiagnostics,
  diagnosticExportBusy = false,
}: {
  gatewayLabel: string;
  status: GatewayUpdateStatus;
  recovery: GatewayUpdateRecoveryAction;
  onExportDiagnostics(): void;
  diagnosticExportBusy?: boolean;
}) {
  const repairRequired = status.phase === "repair_required";
  const externalRequired = recovery.kind === "external";
  const [expanded, setExpanded] = React.useState(
    repairRequired || externalRequired,
  );
  return (
    <details
      className="gateway-no-reply-help gateway-update-failure-help"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        {repairRequired
          ? "Repair this Gateway"
          : externalRequired
            ? "Complete update on Gateway Mac"
            : "Diagnose update failure"}
      </summary>
      <div>
        <p>
          {repairRequired
            ? `The update supervisor on ${gatewayLabel} could not prove either activation or rollback healthy.`
            : externalRequired
              ? `The release changes protected data on ${gatewayLabel}, so this installed supervisor stopped before staging or migration.`
              : `The update stopped on ${gatewayLabel}. Its active build was not replaced by an unverified candidate.`}
        </p>
        {repairRequired ? (
          <ol>
            <li>
              Restart the Gateway once on that Mac:
              <code>{GATEWAY_RESTART_COMMAND}</code>
            </li>
            <li>
              If repair is still required after that, collect
              <code>~/.config/malink/gateway.error.log</code> and
              <code>~/.local/share/malink-matrix/update-supervisor.error.log</code>.
            </li>
          </ol>
        ) : externalRequired ? (
          <>
            <p>{recovery.explanation}</p>
            <ol>
              <li>Let every active Agent task finish; do not force-restart the Gateway.</li>
              <li>On the Gateway Mac, make and verify an offline backup of the Gateway data and supervisor state.</li>
              <li>
                From the target source checkout, run
                <code>pnpm forward-update:matrix-gateway:macos -- …</code>
                with the signed release/build IDs and this Mac&apos;s Gateway paths.
                Do not point the old Gateway at data already opened by the new release.
              </li>
              <li>Verify the new build, Matrix synchronization, command journal, inbox, and outbox before resuming work.</li>
            </ol>
            <a
              className="secondary-button"
              href={GATEWAY_FORWARD_UPDATE_DOC_URL}
              target="_blank"
              rel="noreferrer"
            >
              Open exact bootstrap procedure
            </a>
          </>
        ) : (
          <p>{recovery.explanation}</p>
        )}
        {repairRequired && (
          <p>
            Repeating the update request will not repair this state. Malink will
            recognize the installed build automatically after local health is restored.
          </p>
        )}
        <button
          type="button"
          className="secondary-button"
          disabled={diagnosticExportBusy}
          aria-busy={diagnosticExportBusy}
          onClick={onExportDiagnostics}
        >
          {diagnosticExportBusy ? "Exporting diagnostics…" : "Export client diagnostics"}
        </button>
        <a
          className="secondary-button"
          href={GATEWAY_UPDATE_ISSUE_URL}
          target="_blank"
          rel="noreferrer"
        >
          Report update issue
        </a>
      </div>
    </details>
  );
}
