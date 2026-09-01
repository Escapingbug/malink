import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolInvocation, tokenizeCommandLine } from "./ToolInvocation";
import type { ToolPresentationItem } from "./presentation";

describe("ToolInvocation", () => {
  it("highlights a Bash command without changing its text", () => {
    const invocation = 'MODE=test pnpm exec vitest --filter "$PKG" | tee ./out.log # verify';
    const tokens = tokenizeCommandLine(invocation);
    const html = renderToStaticMarkup(
      createElement(ToolInvocation, {
        className: "tool-call-invocation",
        tool: tool("Bash", "execute", invocation),
      }),
    );

    expect(tokens.map((token) => token.text).join("")).toBe(invocation);
    expect(html).toContain('data-language="bash"');
    expect(html).toContain("token-assignment");
    expect(html).toContain("token-command");
    expect(html).toContain("token-option");
    expect(html).toContain("token-string");
    expect(html).toContain("token-variable");
    expect(html).toContain("token-operator");
    expect(html).toContain("token-path");
    expect(html).toContain("token-comment");
  });

  it("uses conservative command highlighting for a non-Bash executor", () => {
    const html = renderToStaticMarkup(
      createElement(ToolInvocation, {
        className: "tool-focus-invocation",
        tool: tool("Python runner", "execute", "python -m pytest"),
      }),
    );

    expect(html).toContain('data-language="command"');
    expect(html).toContain("token-command");
    expect(html).toContain("token-option");
    expect(html).not.toContain('data-language="bash"');
  });

  it("keeps non-execution details as plain text", () => {
    const html = renderToStaticMarkup(
      createElement(ToolInvocation, {
        className: "tool-call-invocation",
        tool: tool("Read", "read", "src/app.ts"),
      }),
    );

    expect(html).not.toContain("command-invocation");
    expect(html).not.toContain("command-token");
    expect(html).toContain("src/app.ts");
  });
});

function tool(
  name: string,
  category: ToolPresentationItem["category"],
  detail: string,
): ToolPresentationItem {
  return {
    id: `tool-${name}`,
    name,
    title: name,
    detail,
    category,
    phase: "updated",
    isError: false,
    startedAt: 1,
    updatedAt: 2,
  };
}
