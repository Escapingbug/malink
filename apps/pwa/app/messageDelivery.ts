import type { CommandCompletion } from "./commandLifecycle";
import type { GatewaySessionSummary } from "./gatewayState";
import type { PersistedChatMessage } from "./messageHistory";

export type MessageDeliveryState =
  | NonNullable<PersistedChatMessage["deliveryState"]>
  | "received";

export type MessageDeliveryPresentation = Readonly<{
  state: MessageDeliveryState;
  label: string;
  symbol: string;
}>;

type CausalMessage = Pick<PersistedChatMessage, "kind" | "commandId" | "raw">;
type PromptCompletion = Pick<
  CommandCompletion,
  "commandId" | "outcome" | "sessionId"
>;
type ActiveSession = Pick<
  GatewaySessionSummary,
  "activeTurnId" | "activityPhase"
>;

/**
 * Derives the prompt commands that have crossed the second receipt boundary:
 * the authenticated Gateway has started the Agent turn. A queued prompt is
 * deliberately excluded even though it is already durable on Matrix.
 */
export function agentReceivedCommandIds(input: {
  sessionId: string | null;
  session: ActiveSession | null;
  messages: readonly CausalMessage[];
  completions: readonly PromptCompletion[];
}): ReadonlySet<string> {
  const received = new Set<string>();
  for (const message of input.messages) {
    if (
      message.commandId &&
      (message.kind === "agent" ||
        message.kind === "tool" ||
        message.kind === "permission" ||
        (message.kind === "error" && message.raw?.type === "turn.failed"))
    ) {
      received.add(message.commandId);
    }
  }
  for (const completion of input.completions) {
    if (
      completion.sessionId === input.sessionId &&
      (completion.outcome === "succeeded" || completion.outcome === "cancelled")
    ) {
      received.add(completion.commandId);
    }
  }
  if (
    input.session?.activeTurnId &&
    (input.session.activityPhase === "working" ||
      input.session.activityPhase === "stopping")
  ) {
    received.add(input.session.activeTurnId);
  }
  return received;
}

export function userMessageDeliveryState(
  deliveryState: PersistedChatMessage["deliveryState"],
  commandId: string | undefined,
  agentReceived: ReadonlySet<string>,
): MessageDeliveryState | undefined {
  return deliveryState === "sent" && commandId && agentReceived.has(commandId)
    ? "received"
    : deliveryState;
}

export function messageDeliveryPresentation(
  state: MessageDeliveryState | undefined,
): MessageDeliveryPresentation | null {
  switch (state) {
    case "queued":
      return { state, label: "Waiting for session creation", symbol: "◷" };
    case "sending":
      return { state, label: "Sending", symbol: "…" };
    case "sent":
      return { state, label: "Message sent successfully", symbol: "✓" };
    case "received":
      return { state, label: "Agent received and started", symbol: "✓✓" };
    case "failed":
      return { state, label: "Send failed", symbol: "!" };
    case undefined:
      return null;
  }
}
