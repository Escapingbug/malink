import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolInvocation } from "./ToolInvocation";
import type { ToolPresentationItem } from "./presentation";

describe("ToolInvocation", () => {
  it("highlights a Bash command without changing its text", () => {
    const invocation = 'MODE=test pnpm exec vitest --filter "$PKG" | tee ./out.log # verify';
    const html = renderToStaticMarkup(
      createElement(ToolInvocation, {
        className: "tool-call-invocation",
        tool: tool("Bash", "execute", invocation),
      }),
    );

    expect(html).toContain('data-language="bash"');
    expect(html).toContain("syntax-highlight language-bash");
    expect(html).toContain('class="token function"');
    expect(html).toContain('class="token parameter variable"');
    expect(html).toContain('class="token string"');
    expect(html).toContain('class="token operator"');
    expect(html).toContain('class="token comment"');
    expect(html).toContain("MODE");
    expect(html).toContain("$PKG");
    expect(html).toContain("./out.log");
    expect(html).toContain("# verify");
    expect(renderedText(html)).toBe(invocation);
  });

  it("does not apply Bash grammar to a non-Bash executor", () => {
    const html = renderToStaticMarkup(
      createElement(ToolInvocation, {
        className: "tool-focus-invocation",
        tool: tool("Python runner", "execute", "python -m pytest"),
      }),
    );

    expect(html).not.toContain("syntax-highlight");
    expect(html).not.toContain("class=\"token");
    expect(html).not.toContain('data-language="bash"');
    expect(html).toContain("python -m pytest");
  });

  it("uses the Bash grammar for an explicitly labelled shell", () => {
    const html = renderToStaticMarkup(
      createElement(ToolInvocation, {
        className: "tool-focus-invocation",
        tool: tool("Shell", "execute", "if test -f app.ts; then echo ready; fi"),
      }),
    );

    expect(html).toContain('data-language="bash"');
    expect(html).toContain('class="token keyword"');
    expect(html).toContain('class="token builtin class-name"');
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

function renderedText(html: string): string {
  return html
    .replace(/<[^>]+>/gu, "")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}
