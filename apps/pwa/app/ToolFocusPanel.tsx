"use client";

import { useRef, useState } from "react";
import type {
  ToolGroupPresentation,
  ToolPhase,
  ToolPresentationItem,
} from "./presentation";
import { writeClipboardTextWithTimeout } from "./uiClipboard";

export function ToolFocusPanel({
  group,
}: {
  group: ToolGroupPresentation;
}) {
  const tool = focusedToolPresentation(group.tools);
  const [outputToolId, setOutputToolId] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<{
    toolId: string;
    state: "copying" | "copied" | "failed";
  } | null>(null);
  const copyInFlightRef = useRef(false);

  if (!tool) return null;
  const outputOpen = outputToolId === tool.id;
  const copyState = copyFeedback?.toolId === tool.id
    ? copyFeedback.state
    : "idle";
  const toolIndex = Math.max(
    0,
    group.tools.findIndex((candidate) => candidate.id === tool.id),
  );
  const phase = tool.isError ? "failed" : tool.phase;
  const invocation = tool.detail || tool.title || tool.name;

  async function copyInvocation() {
    if (copyInFlightRef.current) return;
    copyInFlightRef.current = true;
    setCopyFeedback({ toolId: tool.id, state: "copying" });
    try {
      await writeClipboardTextWithTimeout(invocation);
      setCopyFeedback({ toolId: tool.id, state: "copied" });
    } catch {
      setCopyFeedback({ toolId: tool.id, state: "failed" });
    } finally {
      copyInFlightRef.current = false;
    }
    const copiedToolId = tool.id;
    window.setTimeout(
      () =>
        setCopyFeedback((current) =>
          current?.toolId === copiedToolId ? null : current,
        ),
      1_600,
    );
  }

  return (
    <aside
      className={`tool-focus-panel phase-${phase}`}
      aria-label={`Current tool call, ${tool.name}`}
    >
      <header>
        <FocusState phase={phase} />
        <span className="tool-focus-identity">
          <strong>{tool.name}</strong>
          <small>
            {toolIndex + 1}/{group.tools.length}
          </small>
        </span>
        <span className="tool-focus-actions">
          <button
            type="button"
            aria-label={
              copyState === "copied"
                ? "Tool call copied"
                : copyState === "copying"
                  ? "Copying tool call"
                : copyState === "failed"
                  ? "Tool call could not be copied"
                  : "Copy tool call"
            }
            title={
              copyState === "copied"
                ? "Copied"
                : copyState === "copying"
                  ? "Copying…"
                : copyState === "failed"
                  ? "Copy failed"
                  : "Copy"
            }
            disabled={copyState === "copying"}
            aria-busy={copyState === "copying"}
            onClick={() => void copyInvocation()}
          >
            {copyState === "copied" ? <CheckIcon /> : <CopyIcon />}
          </button>
          {tool.result && (
            <button
              type="button"
              className={outputOpen ? "is-active" : ""}
              aria-label={outputOpen ? "Show tool call" : "Show captured output"}
              aria-pressed={outputOpen}
              onClick={() =>
                setOutputToolId((current) => current === tool.id ? null : tool.id)
              }
            >
              <TerminalIcon />
            </button>
          )}
        </span>
      </header>

      <div className="tool-focus-content" key={tool.id}>
        {outputOpen && tool.result ? (
          <ToolOutput tool={tool} />
        ) : (
          <pre className="tool-focus-invocation">{invocation}</pre>
        )}
      </div>
    </aside>
  );
}

export function ToolOutput({ tool }: { tool: ToolPresentationItem }) {
  if (!tool.result) return null;
  if (tool.category === "edit" || tool.category === "write") {
    return (
      <pre className="tool-result-view diff-output">
        {tool.result.split("\n").map((line, index) => (
          <span
            className={
              line.startsWith("+") && !line.startsWith("+++")
                ? "is-added"
                : line.startsWith("-") && !line.startsWith("---")
                  ? "is-removed"
                  : ""
            }
            key={`${index}:${line}`}
          >
            {line || " "}
            {"\n"}
          </span>
        ))}
      </pre>
    );
  }
  return (
    <pre
      className={`tool-result-view ${tool.category === "execute" ? "terminal-output" : "source-output"}`}
    >
      {tool.result}
    </pre>
  );
}

function FocusState({ phase }: { phase: ToolPhase }) {
  return (
    <span className={`tool-focus-state phase-${phase}`} role="status" aria-label={phaseLabel(phase)}>
      {phase === "completed" ? <CheckIcon /> : phase === "failed" ? "!" : ""}
    </span>
  );
}

export function focusedToolPresentation(
  tools: readonly ToolPresentationItem[],
): ToolPresentationItem | undefined {
  return (
    [...tools]
      .reverse()
      .find((tool) => tool.phase === "started" || tool.phase === "updated") ??
    tools.at(-1)
  );
}

function phaseLabel(phase: ToolPhase): string {
  return phase === "started" || phase === "updated"
    ? "Running"
    : phase === "failed"
      ? "Failed"
      : "Completed";
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="6.5" y="6.5" width="9" height="9" rx="1.5" />
      <path d="M4 13.5H3.5A1.5 1.5 0 0 1 2 12V3.5A1.5 1.5 0 0 1 3.5 2H12a1.5 1.5 0 0 1 1.5 1.5V4" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m4 10.3 3.7 3.5L16 5.9" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
      <path d="m5.5 7 2.3 2-2.3 2M10 12h4" />
    </svg>
  );
}
