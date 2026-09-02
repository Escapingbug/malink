import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolActivityCard } from "./ToolActivityCard";
import type {
  ToolCategory,
  ToolGroupPresentation,
  ToolPhase,
} from "./presentation";

describe("ToolActivityCard", () => {
  it("summarizes work by task outcome instead of raw call count", () => {
    const html = renderToStaticMarkup(
      createElement(ToolActivityCard, {
        group: group([
          tool("read-1", "Read", "read", "completed", "src/a.ts"),
          tool("read-2", "Read", "read", "completed", "src/b.ts"),
          tool("edit-1", "Edit", "edit", "completed", "src/a.ts"),
          tool("test-1", "Bash", "execute", "completed", "pnpm test", "4 passed"),
        ]),
        time: "16:20",
      }),
    );

    expect(html).toContain("Activity completed");
    expect(html).toContain("Read 2 files · Changed 1 file · Verification passed");
    expect(html).toContain('aria-label="Completed"');
    expect(html).not.toContain("4 tool calls");
  });

  it("keeps invocation visible and captured output behind an explicit action", () => {
    const html = renderToStaticMarkup(
      createElement(ToolActivityCard, {
        defaultExpanded: true,
        live: true,
        fullText: "Tool transcript\n\nraw agent output",
        group: group([
          tool("read-1", "Read", "read", "completed", "src/a.ts"),
          tool("edit-1", "Edit", "edit", "completed", "src/a.ts", "+new line"),
          tool(
            "test-1",
            "Bash",
            "execute",
            "updated",
            "pnpm test",
            "Running test suite…",
          ),
        ]),
      }),
    );

    expect(html).toContain("tool-activity-card is-live");
    expect(html).toContain("Agent working");
    expect(html).toContain("Explore");
    expect(html).toContain("Change");
    expect(html).toContain("Verify");
    expect(html).toContain('aria-label="Running"');
    expect(html).toContain("tool-call-invocation");
    expect(html).toContain("pnpm test");
    expect(html).toContain('aria-label="Show captured output"');
    expect(html).not.toContain("terminal-output");
    expect(html).not.toContain("Running test suite…");
    expect(html).toContain("Diagnostics · Raw transcript");
    expect(html).toContain("raw agent output");
  });

  it("keeps failures visible even while another call is running", () => {
    const failed = tool("test-1", "Bash", "execute", "failed", "pnpm test", "failed");
    failed.isError = true;
    const html = renderToStaticMarkup(
      createElement(ToolActivityCard, {
        live: true,
        group: group([
          failed,
          tool("read-1", "Read", "read", "updated", "src/a.ts"),
        ]),
      }),
    );

    expect(html).toContain("tool-activity-card is-live has-error");
    expect(html).toContain("1 failed · Running");
    expect(html).toContain("phase-failed");
  });

  it("settles a stale running command after the turn succeeds", () => {
    const html = renderToStaticMarkup(
      createElement(ToolActivityCard, {
        defaultExpanded: true,
        terminalOutcome: "succeeded",
        group: group([
          tool("command-1", "Bash", "execute", "updated", "echo ready"),
        ]),
      }),
    );

    expect(html).toContain("Activity completed");
    expect(html).toContain("1 command completed");
    expect(html).toContain('aria-label="Completed"');
    expect(html).not.toContain("Command running");
    expect(html).not.toContain('aria-label="Running"');
  });

  it("settles a stale running command as failed after a failed turn", () => {
    const html = renderToStaticMarkup(
      createElement(ToolActivityCard, {
        terminalOutcome: "failed",
        group: group([
          tool("command-1", "Bash", "execute", "started", "echo ready"),
        ]),
      }),
    );

    expect(html).toContain("tool-activity-card is-complete has-error");
    expect(html).toContain("Command failed");
    expect(html).toContain('aria-label="1 failed"');
  });
});

function group(
  tools: ToolGroupPresentation["tools"],
): ToolGroupPresentation {
  return {
    kind: "tool_group",
    version: 1,
    groupId: "turn-1",
    tools,
  };
}

function tool(
  id: string,
  name: string,
  category: ToolCategory,
  phase: ToolPhase,
  detail: string,
  result?: string,
): ToolGroupPresentation["tools"][number] {
  return {
    id,
    name,
    title: name,
    detail,
    ...(result ? { result } : {}),
    category,
    phase,
    isError: false,
    startedAt: 1_000,
    updatedAt: 3_000,
  };
}
