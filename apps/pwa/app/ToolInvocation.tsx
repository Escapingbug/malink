import type { ReactNode } from "react";
import { refractor } from "refractor/core";
import bash from "refractor/bash";
import type { ToolPresentationItem } from "./presentation";

if (!refractor.registered("bash")) refractor.register(bash);

type HighlightNode =
  | { type: "text"; value: string }
  | {
      type: "element";
      properties?: { className?: Array<string> | string };
      children: HighlightNode[];
    };

export function ToolInvocation({
  tool,
  className,
}: {
  tool: ToolPresentationItem;
  className: string;
}) {
  const invocation = tool.detail || tool.title || tool.name;
  if (!isBashTool(tool)) {
    return <pre className={className}>{invocation}</pre>;
  }

  const tree = refractor.highlight(invocation, "bash");
  return (
    <pre
      className={`${className} syntax-highlight language-bash`}
      data-language="bash"
    >
      <code>{(tree.children as HighlightNode[]).map(renderHighlightNode)}</code>
    </pre>
  );
}

function renderHighlightNode(node: HighlightNode, index: number): ReactNode {
  if (node.type === "text") return node.value;
  const rawClassName = node.properties?.className;
  const className = Array.isArray(rawClassName)
    ? rawClassName.join(" ")
    : rawClassName;
  return (
    <span className={className} key={index}>
      {node.children.map(renderHighlightNode)}
    </span>
  );
}

function isBashTool(tool: ToolPresentationItem): boolean {
  if (tool.category !== "execute") return false;
  const normalized = tool.name.trim().toLowerCase();
  return normalized === "bash" || normalized === "shell";
}
