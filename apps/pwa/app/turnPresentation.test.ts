import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./chatMessages";
import {
  completedTurnPresentation,
  type ObservedCommandCompletion,
} from "./turnPresentation";

describe("completedTurnPresentation", () => {
  it("keeps the terminal Agent message primary and groups earlier work", () => {
    const messages = [
      message("prompt", "user", "turn-a", 1),
      message("progress", "agent", "turn-a", 2),
      toolMessage("tools", "turn-a", 3, 2),
      message("result", "agent", "turn-a", 4),
    ];

    const presentation = completedTurnPresentation(
      messages,
      [completion("turn-a", "succeeded")],
      "session-a",
    );

    expect(presentation.resultByMessageId.get("result")).toEqual({
      commandId: "turn-a",
      outcome: "succeeded",
    });
    const process = presentation.processByMessageId.get("progress");
    expect(process?.firstMessageId).toBe("progress");
    expect([...process!.messageIds]).toEqual(["progress", "tools"]);
    expect(process?.stepCount).toBe(3);
  });

  it("does not collapse a turn until its authenticated completion arrives", () => {
    const presentation = completedTurnPresentation(
      [
        message("prompt", "user", "turn-a", 1),
        message("progress", "agent", "turn-a", 2),
        message("possible-result", "agent", "turn-a", 3),
        message("queued-prompt", "user", "turn-b", 4),
      ],
      [],
      "session-a",
    );

    expect(presentation.resultByMessageId.size).toBe(0);
    expect(presentation.processByMessageId.size).toBe(0);
  });

  it("uses the signed failure message as the primary result", () => {
    const presentation = completedTurnPresentation(
      [
        message("progress", "agent", "turn-a", 1),
        toolMessage("tools", "turn-a", 2, 1, true),
        message("failure", "error", "turn-a", 3),
      ],
      [completion("turn-a", "failed")],
      "session-a",
    );

    expect(presentation.resultByMessageId.get("failure")?.outcome).toBe(
      "failed",
    );
    expect(
      presentation.processByMessageId.get("progress")?.failedStepCount,
    ).toBe(1);
  });

  it("keeps attachment and cancellation context in the compact process", () => {
    const progress = message("progress", "agent", "turn-a", 1);
    progress.attachments = [attachment("artifact")];
    const presentation = completedTurnPresentation(
      [progress, message("cancelled", "agent", "turn-a", 2)],
      [completion("turn-a", "cancelled")],
      "session-a",
    );

    const process = presentation.processByMessageId.get("progress");
    expect(process?.attachmentCount).toBe(1);
    expect(presentation.resultByMessageId.get("cancelled")?.outcome).toBe(
      "cancelled",
    );
  });

  it("does not mix terminal results from another session", () => {
    const presentation = completedTurnPresentation(
      [message("result", "agent", "turn-a", 1)],
      [{ ...completion("turn-a", "succeeded"), sessionId: "session-b" }],
      "session-a",
    );

    expect(presentation.resultByMessageId.size).toBe(0);
  });

  it("groups one turn even when another prompt was queued in the middle", () => {
    const presentation = completedTurnPresentation(
      [
        message("prompt-a", "user", "turn-a", 1),
        message("progress-a-1", "agent", "turn-a", 2),
        message("prompt-b", "user", "turn-b", 3),
        toolMessage("tools-a", "turn-a", 4, 1),
        message("result-a", "agent", "turn-a", 5),
        message("result-b", "agent", "turn-b", 6),
      ],
      [
        completion("turn-a", "succeeded"),
        { ...completion("turn-b", "succeeded"), observedOrder: 2 },
      ],
      "session-a",
    );

    expect(
      [...presentation.processByMessageId.get("progress-a-1")!.messageIds],
    ).toEqual(["progress-a-1", "tools-a"]);
    expect(presentation.resultByMessageId.has("result-a")).toBe(true);
    expect(presentation.resultByMessageId.has("result-b")).toBe(true);
  });
});

function message(
  id: string,
  kind: ChatMessage["kind"],
  commandId: string,
  timestamp: number,
): ChatMessage {
  return {
    id,
    kind,
    commandId,
    sessionId: "session-a",
    text: id,
    timestamp,
  };
}

function toolMessage(
  id: string,
  commandId: string,
  timestamp: number,
  toolCount: number,
  failed = false,
): ChatMessage {
  return {
    ...message(id, "tool", commandId, timestamp),
    toolGroup: {
      kind: "tool_group",
      version: 1,
      groupId: id,
      tools: Array.from({ length: toolCount }, (_, index) => ({
        id: `${id}-${index}`,
        name: "Read",
        title: "Read",
        category: "read",
        phase: failed && index === 0 ? "failed" : "completed",
        isError: failed && index === 0,
        startedAt: timestamp,
        updatedAt: timestamp,
      })),
    },
  };
}

function completion(
  commandId: string,
  outcome: ObservedCommandCompletion["outcome"],
): ObservedCommandCompletion {
  return {
    commandId,
    observedOrder: 1,
    sessionId: "session-a",
    sequence: 1,
    revision: 1,
    outcome,
  };
}

function attachment(id: string): NonNullable<ChatMessage["attachments"]>[number] {
  return {
    id,
    name: `${id}.txt`,
    mimeType: "text/plain",
    size: 12,
    sha256: "A".repeat(43),
    media: {
      url: "mxc://example.org/artifact",
      key: "B".repeat(43),
      iv: "C".repeat(16),
      sha256: "D".repeat(43),
      size: 28,
    },
  };
}
