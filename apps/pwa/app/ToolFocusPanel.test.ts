import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolFocusPanel } from "./ToolFocusPanel";
import type { ToolGroupPresentation } from "./presentation";

describe("ToolFocusPanel", () => {
  it("shows the current invocation in full without exposing captured output", () => {
    const invocation = `pnpm exec vitest run \\\napps/pwa/app/turnTimeline.test.ts \\\napps/pwa/app/ToolFocusPanel.test.ts --reporter=verbose --tail-marker`;
    const html = renderToStaticMarkup(
      createElement(ToolFocusPanel, {
        group: group([
          tool("read", "Read", "completed", "apps/pwa/app/MalinkApp.tsx"),
          tool("test", "Bash", "updated", invocation, "12 tests passed"),
        ]),
      }),
    );

    expect(html).toContain("tool-focus-panel phase-updated");
    expect(html).toContain("tool-focus-invocation");
    expect(html).toContain("--tail-marker");
    expect(html).toContain("2/2");
    expect(html).toContain('aria-label="Show captured output"');
    expect(html).not.toContain("12 tests passed");
  });

  it("focuses the latest call after a completed group", () => {
    const html = renderToStaticMarkup(
      createElement(ToolFocusPanel, {
        group: group([
          tool("read", "Read", "completed", "src/a.ts"),
          tool("edit", "Edit", "completed", "src/b.ts"),
        ]),
      }),
    );

    expect(html).toContain("src/b.ts");
    expect(html).not.toContain("src/a.ts");
    expect(html).toContain('aria-label="Copy tool call"');
  });
});

function group(
  tools: ToolGroupPresentation["tools"],
): ToolGroupPresentation {
  return {
    kind: "tool_group",
    version: 1,
    groupId: "turn-tools",
    tools,
  };
}

function tool(
  id: string,
  name: string,
  phase: "updated" | "completed",
  detail: string,
  result?: string,
): ToolGroupPresentation["tools"][number] {
  return {
    id,
    name,
    title: name,
    detail,
    ...(result ? { result } : {}),
    category: name === "Bash" ? "execute" : "read",
    phase,
    isError: false,
    startedAt: 1,
    updatedAt: phase === "updated" ? 4 : 2,
  };
}
