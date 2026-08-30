"use client";

import React from "react";
import type { GatewayUpdateStatus } from "@malink/protocol";

const GATEWAY_RESTART_COMMAND =
  "for service in com.malink.matrix-gateway io.malink.gateway; do launchctl kickstart -k \"gui/$(id -u)/$service\" 2>/dev/null && break; done";

export function GatewayNoReplyHelp({
  gatewayLabel,
  consecutiveNoReplies,
  onExportDiagnostics,
}: {
  gatewayLabel: string;
  consecutiveNoReplies: number | undefined;
  onExportDiagnostics(): void;
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
        <button type="button" className="secondary-button" onClick={onExportDiagnostics}>
          Export client diagnostics
        </button>
      </div>
    </details>
  );
}

export function GatewayUpdateFailureHelp({
  gatewayLabel,
  status,
  onExportDiagnostics,
}: {
  gatewayLabel: string;
  status: GatewayUpdateStatus;
  onExportDiagnostics(): void;
}) {
  const repairRequired = status.phase === "repair_required";
  return (
    <details className="gateway-no-reply-help gateway-update-failure-help">
      <summary>{repairRequired ? "Repair this Gateway" : "Review update failure"}</summary>
      <div>
        <p>
          {repairRequired
            ? `The update supervisor on ${gatewayLabel} could not prove either activation or rollback healthy. Repeating the update request will not repair this state.`
            : `The update stopped on ${gatewayLabel}. Its active build was not replaced by an unverified candidate.`}
        </p>
        {repairRequired ? (
          <ol>
            <li>
              Restart the Gateway once on that Mac:
              <code>{GATEWAY_RESTART_COMMAND}</code>
            </li>
            <li>
              Check again. If repair is still required, collect
              <code>~/.config/malink/gateway.error.log</code> and
              <code>~/.local/share/malink-matrix/update-supervisor.error.log</code>.
            </li>
          </ol>
        ) : (
          <p>
            Open the maintenance session when available to review the failed build or validation
            step. Retry only after the reported cause has changed.
          </p>
        )}
        <button type="button" className="secondary-button" onClick={onExportDiagnostics}>
          Export client diagnostics
        </button>
      </div>
    </details>
  );
}
