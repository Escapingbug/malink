import type { CommandCompletion } from "./commandLifecycle";
import type { ChatMessage } from "./chatMessages";

export type ObservedCommandCompletion = CommandCompletion & {
  observedOrder: number;
};

export type TurnResultPresentation = {
  commandId: string;
  outcome: CommandCompletion["outcome"];
};

export type CompletedTurnProcess = TurnResultPresentation & {
  firstMessageId: string;
  messageIds: ReadonlySet<string>;
  stepCount: number;
  failedStepCount: number;
  attachmentCount: number;
};

export type CompletedTurnPresentation = {
  processByMessageId: ReadonlyMap<string, CompletedTurnProcess>;
  resultByMessageId: ReadonlyMap<string, TurnResultPresentation>;
};

/**
 * Builds a result-first presentation from the verified command lifecycle.
 *
 * Agent and tool output remains ordinary transcript data. Once a prompt has a
 * terminal command result, the newest visible Agent/error message becomes its
 * primary result and the other work messages become one collapsible process.
 * We intentionally do not infer completion from a following user message: a
 * user may queue another prompt while the current turn is still running.
 */
export function completedTurnPresentation(
  messages: readonly ChatMessage[],
  completions: readonly ObservedCommandCompletion[],
  sessionId: string | null,
): CompletedTurnPresentation {
  const processByMessageId = new Map<string, CompletedTurnProcess>();
  const resultByMessageId = new Map<string, TurnResultPresentation>();
  if (!sessionId) return { processByMessageId, resultByMessageId };

  const terminalByCommand = new Map<string, ObservedCommandCompletion>();
  for (const completion of completions) {
    if (completion.sessionId !== sessionId) continue;
    const current = terminalByCommand.get(completion.commandId);
    if (!current || completion.observedOrder > current.observedOrder) {
      terminalByCommand.set(completion.commandId, completion);
    }
  }

  const workByCommand = new Map<string, ChatMessage[]>();
  for (const message of messages) {
    if (!message.commandId || !isTurnWorkMessage(message)) continue;
    const commandMessages = workByCommand.get(message.commandId) ?? [];
    commandMessages.push(message);
    workByCommand.set(message.commandId, commandMessages);
  }

  for (const [commandId, completion] of terminalByCommand) {
    const work = workByCommand.get(commandId);
    if (!work?.length) continue;
    const result = findResultMessage(work, completion.outcome);
    if (!result) continue;

    const resultPresentation: TurnResultPresentation = {
      commandId,
      outcome: completion.outcome,
    };
    resultByMessageId.set(result.id, resultPresentation);

    const processMessages = work.filter((message) => message.id !== result.id);
    if (processMessages.length === 0) continue;
    const process: CompletedTurnProcess = {
      ...resultPresentation,
      firstMessageId: processMessages[0]!.id,
      messageIds: new Set(processMessages.map((message) => message.id)),
      stepCount: processMessages.reduce(
        (count, message) => count + messageStepCount(message),
        0,
      ),
      failedStepCount: processMessages.reduce(
        (count, message) => count + messageFailedStepCount(message),
        0,
      ),
      attachmentCount: processMessages.reduce(
        (count, message) => count + (message.attachments?.length ?? 0),
        0,
      ),
    };
    for (const message of processMessages) {
      processByMessageId.set(message.id, process);
    }
  }

  return { processByMessageId, resultByMessageId };
}

function isTurnWorkMessage(message: ChatMessage): boolean {
  return (
    message.kind === "agent" ||
    message.kind === "error" ||
    message.kind === "permission" ||
    message.kind === "tool"
  );
}

function findResultMessage(
  work: readonly ChatMessage[],
  outcome: CommandCompletion["outcome"],
): ChatMessage | undefined {
  if (outcome === "failed") {
    const error = work.findLast((message) => message.kind === "error");
    if (error) return error;
  }
  return work.findLast(
    (message) => message.kind === "agent" || message.kind === "error",
  );
}

function messageStepCount(message: ChatMessage): number {
  if (message.kind !== "tool") return 1;
  return Math.max(1, message.toolGroup?.tools.length ?? 0);
}

function messageFailedStepCount(message: ChatMessage): number {
  if (message.kind === "error") return 1;
  if (message.kind !== "tool") return 0;
  return (
    message.toolGroup?.tools.filter(
      (tool) => tool.phase === "failed" || tool.isError,
    ).length ?? 0
  );
}
