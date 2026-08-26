"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ToolCategory,
  ToolGroupPresentation,
  ToolPhase,
  ToolPresentationItem,
} from "./presentation";

type ToolStageKind = "explore" | "change" | "execute" | "delegate" | "other";

type ToolStage = {
  kind: ToolStageKind;
  label: string;
  tools: ToolPresentationItem[];
  phase: ToolPhase;
  stateLabel: string;
};

export function ToolActivityCard({
  group,
  time,
  fullText,
  live = false,
  defaultExpanded = false,
}: {
  group: ToolGroupPresentation;
  time?: string;
  fullText?: string;
  live?: boolean;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [selectedStageKind, setSelectedStageKind] =
    useState<ToolStageKind | null>(null);
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const userControlledExpansionRef = useRef(false);
  const followLatestRef = useRef(true);
  const stages = useMemo(() => toolStages(group.tools), [group.tools]);
  const latest = currentTool(group.tools);
  const latestToolId = latest?.id;
  const defaultStage =
    stages.find((stage) => stage.tools.some((tool) => tool.id === latest?.id)) ??
    stages[0];
  const selectedStage =
    stages.find((stage) => stage.kind === selectedStageKind) ?? defaultStage;
  const selectedTool =
    selectedStage?.tools.find((tool) => tool.id === selectedToolId) ??
    currentTool(selectedStage?.tools ?? []);
  const summary = toolStateSummary(group.tools);
  const detailsId = useMemo(
    () => `tool-activity-${safeDomId(group.groupId)}`,
    [group.groupId],
  );

  useEffect(() => {
    if (
      live &&
      !userControlledExpansionRef.current &&
      !window.matchMedia("(max-width: 900px)").matches
    ) {
      setExpanded(true);
    }
  }, [live]);

  useEffect(() => {
    if (!live || !followLatestRef.current || !latestToolId) return;
    const stage = stages.find((candidate) =>
      candidate.tools.some((tool) => tool.id === latestToolId),
    );
    setSelectedStageKind(stage?.kind ?? null);
    setSelectedToolId(latestToolId);
  }, [latestToolId, live, stages]);

  async function copyDetails() {
    const structuredDetails = group.tools
      .map((tool) =>
        [tool.name, tool.detail || tool.title, tool.result]
          .filter(Boolean)
          .join("\n"),
      )
      .join("\n\n");
    const value = fullText?.trim() || structuredDetails;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    window.setTimeout(() => setCopyState("idle"), 1_600);
  }

  function selectStage(stage: ToolStage) {
    followLatestRef.current = false;
    setSelectedStageKind(stage.kind);
    setSelectedToolId(currentTool(stage.tools)?.id ?? null);
  }

  function selectTool(tool: ToolPresentationItem) {
    followLatestRef.current = false;
    setSelectedToolId(tool.id);
  }

  return (
    <article
      className={`tool-activity-card ${live ? "is-live" : "is-complete"} ${summary.failed > 0 ? "has-error" : ""}`}
      aria-label={`Agent activity, ${summary.label}`}
    >
      <button
        type="button"
        className="tool-activity-summary"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => {
          userControlledExpansionRef.current = true;
          setExpanded((current) => !current);
        }}
      >
        <ActivityStateMark phase={summary.phase} />
        <span className="tool-activity-copy">
          <strong>{live ? "Agent working" : "Activity completed"}</strong>
          <small>{toolActivityDescription(group.tools)}</small>
        </span>
        <span className="tool-activity-meta">
          <ToolState phase={summary.phase} label={summary.label} />
          <time>{formatDuration(group.tools)}</time>
        </span>
        <span className="tool-activity-chevron" aria-hidden="true">
          {expanded ? "−" : "+"}
        </span>
      </button>

      {expanded && selectedStage && (
        <div
          className="tool-activity-details"
          id={detailsId}
          role="region"
          aria-label="Agent activity details"
        >
          <nav className="tool-stage-nav" aria-label="Activity stages">
            <ol>
              {stages.map((stage) => (
                <li key={stage.kind}>
                  <button
                    type="button"
                    className={stage.kind === selectedStage.kind ? "is-selected" : ""}
                    aria-pressed={stage.kind === selectedStage.kind}
                    onClick={() => selectStage(stage)}
                  >
                    <span className={`tool-stage-icon stage-${stage.kind}`} aria-hidden="true">
                      {stageIcon(stage.kind)}
                    </span>
                    <span className="tool-stage-copy">
                      <strong>{stage.label}</strong>
                      <small>{stageDescription(stage)}</small>
                    </span>
                    <ToolState
                      phase={stage.phase}
                      label={stage.stateLabel}
                      compact
                    />
                  </button>
                </li>
              ))}
            </ol>
          </nav>

          <section className="tool-stage-panel" aria-label={`${selectedStage.label} details`}>
            <header>
              <span>
                <small>Stage</small>
                <strong>{selectedStage.label}</strong>
              </span>
              <span>{selectedStage.tools.length} {selectedStage.tools.length === 1 ? "call" : "calls"}</span>
            </header>

            <ol className="tool-call-list" aria-label={`${selectedStage.label} tool calls`}>
              {selectedStage.tools.map((tool) => (
                <li key={tool.id}>
                  <button
                    type="button"
                    className={`${tool.id === selectedTool?.id ? "is-selected" : ""} ${tool.isError || tool.phase === "failed" ? "has-error" : ""}`}
                    aria-pressed={tool.id === selectedTool?.id}
                    onClick={() => selectTool(tool)}
                  >
                    <span className={`tool-call-icon category-${tool.category}`} aria-hidden="true">
                      {toolIcon(tool.category)}
                    </span>
                    <span>
                      <strong>{tool.name}</strong>
                      <small>{tool.detail || tool.title}</small>
                    </span>
                    <ToolState
                      phase={tool.isError ? "failed" : tool.phase}
                      label={toolPhaseLabel(tool.isError ? "failed" : tool.phase)}
                      compact
                    />
                  </button>
                </li>
              ))}
            </ol>

            {selectedTool && <ToolCallDetail tool={selectedTool} />}
          </section>

          {fullText?.trim() && (
            <details className="tool-raw-transcript">
              <summary>Diagnostics · Raw transcript</summary>
              <pre>{fullText}</pre>
            </details>
          )}
          <footer className="tool-activity-footer">
            <span>
              {time && <time>{time}</time>}
              <small>{formatDuration(group.tools)} total</small>
            </span>
            <button type="button" onClick={() => void copyDetails()}>
              {copyState === "copied"
                ? "Copied"
                : copyState === "failed"
                  ? "Copy failed"
                  : "Copy details"}
            </button>
          </footer>
        </div>
      )}
    </article>
  );
}

function ToolCallDetail({ tool }: { tool: ToolPresentationItem }) {
  const active = tool.phase === "started" || tool.phase === "updated";
  return (
    <div className={`tool-call-detail category-${tool.category}`}>
      <div className="tool-call-command">
        <span>{tool.name}</span>
        <code>{tool.detail || tool.title}</code>
      </div>
      {tool.result ? (
        tool.category === "edit" || tool.category === "write" ? (
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
        ) : (
          <pre
            className={`tool-result-view ${tool.category === "execute" ? "terminal-output" : "source-output"}`}
          >
            {tool.result}
          </pre>
        )
      ) : (
        <div className={`tool-result-empty ${active ? "is-waiting" : ""}`}>
          {active ? "Waiting for output…" : "No output was captured for this call."}
        </div>
      )}
    </div>
  );
}

function ActivityStateMark({ phase }: { phase: ToolPhase }) {
  return (
    <span className={`tool-activity-state-mark phase-${phase}`} aria-hidden="true">
      {phase === "completed" ? "✓" : phase === "failed" ? "!" : ""}
    </span>
  );
}

function ToolState({
  phase,
  label,
  compact = false,
}: {
  phase: ToolPhase;
  label: string;
  compact?: boolean;
}) {
  return (
    <span
      className={`tool-state phase-${phase} ${compact ? "compact" : ""}`}
      role="status"
      aria-label={label}
      title={label}
    >
      <i aria-hidden="true">
        {phase === "completed" ? "✓" : phase === "failed" ? "×" : ""}
      </i>
      {!compact && <span>{label}</span>}
    </span>
  );
}

function toolStages(tools: readonly ToolPresentationItem[]): ToolStage[] {
  const groups = new Map<ToolStageKind, ToolPresentationItem[]>();
  for (const tool of tools) {
    const kind = toolStageKind(tool.category);
    const existing = groups.get(kind) ?? [];
    existing.push(tool);
    groups.set(kind, existing);
  }

  return (["explore", "change", "execute", "delegate", "other"] as const)
    .flatMap((kind) => {
      const stageTools = groups.get(kind);
      if (!stageTools?.length) return [];
      const summary = toolStateSummary(stageTools);
      return [{
        kind,
        label: stageLabel(kind, stageTools),
        tools: stageTools,
        phase: summary.phase,
        stateLabel: summary.label,
      }];
    });
}

function toolStateSummary(tools: readonly ToolPresentationItem[]): {
  completed: number;
  failed: number;
  running: number;
  phase: ToolPhase;
  label: string;
} {
  const failed = tools.filter(
    (tool) => tool.phase === "failed" || tool.isError,
  ).length;
  const running = tools.filter(
    (tool) => tool.phase === "started" || tool.phase === "updated",
  ).length;
  const completed = tools.length - failed - running;
  if (failed > 0) {
    return {
      completed,
      failed,
      running,
      phase: "failed",
      label: running > 0
        ? `${failed} failed · Running`
        : failed === 1 ? "1 failed" : `${failed} failed`,
    };
  }
  if (running > 0) {
    return { completed, failed, running, phase: "updated", label: "Running" };
  }
  return { completed, failed, running, phase: "completed", label: "Completed" };
}

function toolActivityDescription(tools: readonly ToolPresentationItem[]): string {
  const readTools = tools.filter((tool) => tool.category === "read");
  const searchTools = tools.filter((tool) => tool.category === "search");
  const changedTools = tools.filter(
    (tool) => tool.category === "edit" || tool.category === "write",
  );
  const executeTools = tools.filter((tool) => tool.category === "execute");
  const delegatedTools = tools.filter((tool) => tool.category === "agent");
  const parts: string[] = [];

  if (readTools.length > 0) {
    const count = distinctTargets(readTools);
    parts.push(`Read ${count} ${count === 1 ? "file" : "files"}`);
  }
  if (searchTools.length > 0) {
    parts.push(`${searchTools.length} ${searchTools.length === 1 ? "search" : "searches"}`);
  }
  if (changedTools.length > 0) {
    const count = distinctTargets(changedTools);
    parts.push(`Changed ${count} ${count === 1 ? "file" : "files"}`);
  }
  if (executeTools.length > 0) {
    const state = toolStateSummary(executeTools);
    const verification = executeTools.every(isVerificationTool);
    parts.push(
      state.failed > 0
        ? `${verification ? "Verification" : "Command"} failed`
        : state.running > 0
          ? `${verification ? "Verification" : "Command"} running`
          : `${verification ? "Verification passed" : `${executeTools.length} ${executeTools.length === 1 ? "command" : "commands"} completed`}`,
    );
  }
  if (delegatedTools.length > 0) {
    parts.push(`${delegatedTools.length} delegated ${delegatedTools.length === 1 ? "task" : "tasks"}`);
  }
  return parts.join(" · ") || `${tools.length} tool ${tools.length === 1 ? "call" : "calls"}`;
}

function stageDescription(stage: ToolStage): string {
  const active = currentTool(stage.tools);
  const target = active?.detail || active?.title;
  return target
    ? `${stage.tools.length} ${stage.tools.length === 1 ? "call" : "calls"} · ${target}`
    : `${stage.tools.length} ${stage.tools.length === 1 ? "call" : "calls"}`;
}

function stageLabel(
  kind: ToolStageKind,
  tools: readonly ToolPresentationItem[],
): string {
  switch (kind) {
    case "explore":
      return "Explore";
    case "change":
      return "Change";
    case "execute":
      return tools.every(isVerificationTool) ? "Verify" : "Run";
    case "delegate":
      return "Delegate";
    case "other":
      return "Other";
  }
}

function toolStageKind(category: ToolCategory): ToolStageKind {
  switch (category) {
    case "read":
    case "search":
      return "explore";
    case "edit":
    case "write":
      return "change";
    case "execute":
      return "execute";
    case "agent":
      return "delegate";
    case "unknown":
      return "other";
  }
}

function isVerificationTool(tool: ToolPresentationItem): boolean {
  return /(?:^|\s|[/:-])(test|tests|lint|check|typecheck|verify|build|gradle)(?:\s|$|[/:-])/i.test(
    `${tool.name} ${tool.detail ?? ""} ${tool.title}`,
  );
}

function distinctTargets(tools: readonly ToolPresentationItem[]): number {
  return new Set(tools.map((tool) => tool.detail || tool.title || tool.name)).size;
}

function currentTool(
  tools: readonly ToolPresentationItem[],
): ToolPresentationItem | undefined {
  return (
    [...tools]
      .reverse()
      .find((tool) => tool.phase === "started" || tool.phase === "updated") ??
    tools.at(-1)
  );
}

function formatDuration(tools: readonly ToolPresentationItem[]): string {
  const startedAt = Math.min(...tools.map((tool) => tool.startedAt));
  const updatedAt = Math.max(...tools.map((tool) => tool.updatedAt));
  const milliseconds = Math.max(0, updatedAt - startedAt);
  if (milliseconds < 1_000) return "<1s";
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function toolPhaseLabel(phase: ToolPhase): string {
  switch (phase) {
    case "started":
    case "updated":
      return "Running";
    case "failed":
      return "Failed";
    case "completed":
      return "Completed";
  }
}

function stageIcon(kind: ToolStageKind): string {
  switch (kind) {
    case "explore":
      return "⌕";
    case "change":
      return "±";
    case "execute":
      return ">_";
    case "delegate":
      return "◇";
    case "other":
      return "•";
  }
}

function toolIcon(category: ToolCategory): string {
  switch (category) {
    case "execute":
      return ">_";
    case "edit":
      return "±";
    case "write":
      return "+";
    case "read":
      return "◫";
    case "search":
      return "⌕";
    case "agent":
      return "◇";
    case "unknown":
      return "•";
  }
}

function safeDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}
