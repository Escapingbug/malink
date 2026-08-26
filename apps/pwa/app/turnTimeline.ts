import type { ChatMessage } from "./chatMessages";

/**
 * Tool activity stays at its original transcript position for its entire
 * lifecycle. Running and completed activity use the same presentation, so a
 * status update never moves the user's reading target.
 */
export function turnTimelineMessages(
  messages: readonly ChatMessage[],
): ChatMessage[] {
  return [...messages];
}

export function activeTurnToolMessage(
  messages: readonly ChatMessage[],
  running: boolean,
): ChatMessage | null {
  if (!running) return null;
  const latestPromptIndex = messages.findLastIndex(
    (message) => message.kind === "user",
  );
  const latestPrompt = messages[latestPromptIndex];
  return messages
    .slice(Math.max(0, latestPromptIndex + 1))
    .filter(
      (message) =>
        message.kind === "tool" &&
        message.toolGroup &&
        (!latestPrompt?.commandId ||
          !message.commandId ||
          message.commandId === latestPrompt.commandId),
    )
    .at(-1) ?? null;
}
