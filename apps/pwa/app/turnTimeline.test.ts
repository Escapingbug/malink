import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./chatMessages";
import {
  activeTurnToolFocus,
  activeTurnToolMessage,
  turnTimelineMessages,
} from "./turnTimeline";

describe("turnTimelineMessages", () => {
  it("keeps activity at its original transcript position", () => {
    const messages = [
      message("prompt", "user", "turn-1"),
      message("progress-1", "agent", "turn-1"),
      toolMessage("tools", "turn-1"),
      message("progress-2", "agent", "turn-1"),
      message("result", "agent", "turn-1"),
    ];

    expect(turnTimelineMessages(messages).map(({ id }) => id)).toEqual([
      "prompt",
      "progress-1",
      "tools",
      "progress-2",
      "result",
    ]);
  });

  it("keeps active activity in the same timeline", () => {
    const messages = [
      message("prompt", "user", "turn-1"),
      message("progress", "agent", "turn-1"),
      toolMessage("tools", "turn-1"),
    ];

    expect(turnTimelineMessages(messages).map(({ id }) => id)).toEqual([
      "prompt",
      "progress",
      "tools",
    ]);
  });

  it("keeps multiple completed groups in their original order", () => {
    const messages = [
      message("prompt", "user", "turn-1"),
      toolMessage("tools-1", "turn-1"),
      message("progress", "agent", "turn-1"),
      toolMessage("tools-2", "turn-1"),
      message("result", "agent", "turn-1"),
    ];

    expect(turnTimelineMessages(messages).map(({ id }) => id)).toEqual([
      "prompt",
      "tools-1",
      "progress",
      "tools-2",
      "result",
    ]);
  });

  it("does not mutate the caller's message array", () => {
    const messages = [
      message("prompt", "user"),
      toolMessage("tools"),
      message("result", "agent"),
      message("next-prompt", "user"),
    ];

    const timeline = turnTimelineMessages(messages);

    expect(timeline.map(({ id }) => id)).toEqual([
      "prompt",
      "tools",
      "result",
      "next-prompt",
    ]);
    expect(timeline).not.toBe(messages);
  });
});

describe("activeTurnToolMessage", () => {
  it("only selects activity belonging to the currently running prompt", () => {
    const messages = [
      message("prompt-1", "user", "turn-1"),
      toolMessage("tools-1", "turn-1"),
      message("result-1", "agent", "turn-1"),
      message("prompt-2", "user", "turn-2"),
    ];

    expect(activeTurnToolMessage(messages, true)).toBeNull();
    expect(
      activeTurnToolMessage(
        [...messages, toolMessage("tools-2", "turn-2")],
        true,
      )?.id,
    ).toBe("tools-2");
    expect(
      activeTurnToolMessage(
        [...messages, toolMessage("tools-2", "turn-2")],
        false,
      ),
    ).toBeNull();
  });

  it("returns attention to Agent text that follows a tool group", () => {
    const messages = [
      message("prompt", "user", "turn-1", 1),
      toolMessage("tools", "turn-1", 2),
      message("explanation", "agent", "turn-1", 3),
    ];

    expect(activeTurnToolMessage(messages, true)).toBeNull();
  });

  it("uses the latest tool update even when its bubble keeps an older timeline position", () => {
    const messages = [
      message("prompt", "user", "turn-1", 1),
      toolMessage("tools", "turn-1", 4),
      message("explanation", "agent", "turn-1", 3),
    ];

    expect(activeTurnToolMessage(messages, true)?.id).toBe("tools");
  });
});

describe("activeTurnToolFocus", () => {
  it("selects the latest active tool without reducing the transcript", () => {
    const messages = [
      message("prompt", "user", "turn-1", 1),
      message("reasoning-1", "agent", "turn-1", 2),
      toolMessage("tools-1", "turn-1", 3),
      message("reasoning-2", "agent", "turn-1", 4),
      toolMessage("tools-2", "turn-1", 5),
    ];

    const focus = activeTurnToolFocus(messages, true);

    expect(focus?.toolMessage.id).toBe("tools-2");
    expect(turnTimelineMessages(messages).map(({ id }) => id)).toEqual([
      "prompt",
      "reasoning-1",
      "tools-1",
      "reasoning-2",
      "tools-2",
    ]);
  });
});

function message(
  id: string,
  kind: ChatMessage["kind"],
  commandId?: string,
  timestamp = id.length,
): ChatMessage {
  return { id, kind, commandId, text: id, timestamp };
}

function toolMessage(
  id: string,
  commandId?: string,
  updatedAt = 2,
): ChatMessage {
  return {
    ...message(id, "tool", commandId, Math.max(1, updatedAt - 1)),
    toolGroup: {
      kind: "tool_group",
      version: 1,
      groupId: id,
      tools: [
        {
          id: `${id}-read`,
          name: "Read",
          title: "Read",
          detail: "src/index.ts",
          category: "read",
          phase: "completed",
          isError: false,
          startedAt: 1,
          updatedAt,
        },
      ],
    },
  };
}
