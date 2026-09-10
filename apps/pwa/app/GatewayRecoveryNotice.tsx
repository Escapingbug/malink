import React, { useState } from "react";

export function gatewayRecoveryNoticeReason(input: {
  connected: boolean;
  hasRecovery: boolean;
  executionPhase?: string;
  deploymentPhase?: string;
  liveness?: string;
  consecutiveNoReplies?: number;
}): "failed" | "unreachable" | null {
  if (!input.connected || !input.hasRecovery) return null;
  if (input.executionPhase === "attention" || input.deploymentPhase === "repair_required") return "failed";
  if (input.executionPhase && input.executionPhase !== "steady") return null;
  return input.liveness === "unreachable" && (input.consecutiveNoReplies ?? 0) >= 2
    ? "unreachable" : null;
}

export function GatewayRecoveryNotice({ reason, onOpen }: {
  reason: "failed" | "unreachable";
  onOpen(): void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return <section className="gateway-recovery-notice" aria-label="Gateway recovery options">
    <div role="status">
      {reason === "failed" ? "The Gateway could not start normally."
        : "The Gateway has missed repeated checks. Its status could not be verified."}
      {!collapsed && <p>A retained version may help restore access. Review the available versions before switching.</p>}
    </div>
    <div className="gateway-recovery-notice-actions">
      <button type="button" className="secondary-button" onClick={onOpen}>View recovery options</button>
      <button type="button" className="secondary-button" aria-expanded={!collapsed}
        onClick={() => setCollapsed(value => !value)}>{collapsed ? "Show details" : "Hide details"}</button>
    </div>
  </section>;
}
