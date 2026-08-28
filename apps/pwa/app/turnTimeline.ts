import type { ChatMessage } from "./chatMessages";

/**
 * Tool activity stays at its original transcript position for its entire
 * lifecycle. This function preserves the verified transcript order; the UI's
 * result-first layer may later fold completed work without rewriting history.
 */
export function turnTimelineMessages(
  messages: readonly ChatMessage[],
): ChatMessage[] {
  return [...messages];
}

export type ActiveTurnToolFocus = {
  toolMessage: ChatMessage;
  contextMessage: ChatMessage | null;
};

/**
 * The transcript can contain a completed tool snapshot while the same turn is
 * still running. Tool focus is active only when the latest attention-bearing
 * event is a tool. As soon as visible Agent text or a permission request
 * follows, attention returns to that newer event.
 */
export function activeTurnToolFocus(
  messages: readonly ChatMessage[],
  running: boolean,
): ActiveTurnToolFocus | null {
  if (!running) return null;
  const latestPromptIndex = messages.findLastIndex(
    (message) => message.kind === "user",
  );
  if (latestPromptIndex < 0) return null;
  const latestPrompt = messages[latestPromptIndex];
  const turnMessages = messages.slice(latestPromptIndex);
  const attentionEvents = turnMessages.flatMap((message, index) =>
    belongsToPrompt(message, latestPrompt) &&
    (message.kind === "agent" ||
      message.kind === "error" ||
      message.kind === "permission" ||
      message.kind === "tool")
      ? [{ message, index, activityAt: messageActivityAt(message) }]
      : [],
  );
  const latestAttention = attentionEvents.reduce<
    (typeof attentionEvents)[number] | undefined
  >((latest, candidate) =>
    !latest ||
    candidate.activityAt > latest.activityAt ||
    (candidate.activityAt === latest.activityAt && candidate.index > latest.index)
      ? candidate
      : latest,
  undefined);
  const toolMessage = latestAttention?.message;
  if (toolMessage?.kind !== "tool" || !toolMessage.toolGroup) {
    return null;
  }

  const contextMessage = turnMessages.reduce<ChatMessage | null>(
    (latest, message) => {
      if (
        !belongsToPrompt(message, latestPrompt) ||
        (message.kind !== "user" && message.kind !== "agent")
      ) {
        return latest;
      }
      return !latest || messageActivityAt(message) >= messageActivityAt(latest)
        ? message
        : latest;
    },
    null,
  );

  return { toolMessage, contextMessage };
}

export function activeTurnToolMessage(
  messages: readonly ChatMessage[],
  running: boolean,
): ChatMessage | null {
  return activeTurnToolFocus(messages, running)?.toolMessage ?? null;
}

function belongsToPrompt(
  message: ChatMessage,
  prompt: ChatMessage,
): boolean {
  return (
    !prompt.commandId ||
    !message.commandId ||
    message.commandId === prompt.commandId
  );
}

function messageActivityAt(message: ChatMessage): number {
  if (message.kind !== "tool") return message.timestamp ?? 0;
  return Math.max(
    message.timestamp ?? 0,
    ...(message.toolGroup?.tools.map((tool) => tool.updatedAt) ?? []),
  );
}
