import { describe, expect, it } from "vitest";
import type { Mlp3Command, Mlp3Event } from "@malink/protocol";
import {
  MATRIX_MLP3_PROJECTION_STATE_VERSION,
  MatrixMlp3Projection,
} from "./matrixMlp3Projection";
import { toIncomingMessage, toLegacyCompletion } from "./matrixMlp3Connection";

describe("MatrixMlp3Projection", () => {
  it("converges per session despite out-of-order events and physical relation changes", () => {
    const projection = new MatrixMlp3Projection();
    projection.applyCommand(createCommand("a"), "$root-original", 1);
    projection.applyEvent(turnEvent("completed", 4, "idle"), "$physical-completed");
    projection.applyEvent(turnEvent("started", 3, "working"), "$physical-started");
    expect(projection.sessions.get("session-a")).toMatchObject({
      activity: "idle",
      stateVersion: 4,
      threadRootEventId: "$root-original",
    });
    expect(projection.sessions.get("session-a")?.activeTurnId).toBeUndefined();
  });

  it("deduplicates command retries and retains history beyond an arbitrary sync window", () => {
    const projection = new MatrixMlp3Projection();
    const command = createCommand("a");
    expect(projection.applyCommand(command, "$root-1", 1)).toBe(true);
    expect(projection.applyCommand(command, "$root-rewritten", 2)).toBe(false);
    for (let index = 0; index < 500; index += 1) {
      projection.applyEvent(messageEvent(index), `$physical-${index}`);
    }
    expect(projection.sessionMessages("session-a")).toHaveLength(500);
  });

  it("settles a client-created project command from its routed result", () => {
    const projection = new MatrixMlp3Projection();
    projection.applyEvent({
      kind: "malink.event",
      version: 3,
      eventId: "project-created-event",
      workspaceId: "workspace-1",
      projectId: "bootstrap-project",
      occurredAt: 2,
      causationCommandId: "project-create-command",
      payload: {
        type: "project.created",
        gatewayNodeId: "gateway-node-1",
        projectId: "new-project",
        roomId: "!new-project:example.org",
        conversationId: "!new-project:example.org",
        name: "Remote project",
        cwd: "/srv/projects/remote",
      },
    }, "$project-created");

    expect(projection.completions.get("project-create-command")).toMatchObject({
      outcome: "succeeded",
      event: { payload: { type: "project.created", projectId: "new-project" } },
    });
  });

  it("settles an interrupted durable command from an authoritative reconciliation", () => {
    const projection = new MatrixMlp3Projection();
    projection.applyEvent({
      kind: "malink.event",
      version: 3,
      eventId: "command-reconciled-command-1-terminal",
      workspaceId: "workspace-1",
      projectId: "project-1",
      sessionId: "session-a",
      occurredAt: 8,
      causationCommandId: "command-1",
      payload: {
        type: "command.reconciled",
        commandId: "command-1",
        state: "terminal",
        acceptedAt: 2,
        dispatchedAt: 3,
        terminalAt: 7,
        outcome: "interrupted",
        error: {
          code: "gateway_restarted",
          message: "The Gateway restarted after dispatch.",
          retryable: true,
        },
      },
    }, "$command-reconciled");

    const completion = projection.completions.get("command-1");
    expect(completion).toMatchObject({
      commandId: "command-1",
      outcome: "interrupted",
    });
    expect(toLegacyCompletion(completion!)).toMatchObject({
      commandId: "command-1",
      outcome: "failed",
      error: {
        code: "gateway_restarted",
        message: "The Gateway restarted after dispatch.",
        retryable: true,
      },
    });
  });

  it("tombstones only the targeted session without a global inventory revision", () => {
    const projection = new MatrixMlp3Projection();
    projection.applyCommand(createCommand("a"), "$root-a");
    projection.applyCommand(createCommand("b"), "$root-b");
    projection.applyEvent(lifecycleEvent("session-a", "deleted"), "$delete-a");
    expect(projection.visibleSessions().map(session => session.sessionId)).toEqual(["session-b"]);
  });

  it("removes a deleted project's local materialized view and settles the command", () => {
    const projection = new MatrixMlp3Projection();
    projection.applyCommand(createCommand("a"), "$root-a");
    projection.applyEvent(projectSnapshot(), "$project-snapshot");
    projection.applyEvent({
      kind: "malink.event",
      version: 3,
      eventId: "project-deleted-1",
      workspaceId: "workspace-1",
      projectId: "project-1",
      occurredAt: 3,
      causationCommandId: "project-delete-command",
      payload: {
        type: "project.deleted",
        projectId: "project-1",
        name: "Project",
      },
    }, "$project-deleted");

    expect(projection.project).toBeNull();
    expect(projection.visibleSessions()).toEqual([]);
    expect(projection.completions.get("project-delete-command")?.outcome).toBe("succeeded");
  });

  it("restores the complete materialized view without depending on the current sync window", () => {
    const first = new MatrixMlp3Projection();
    first.applyCommand(createCommand("a"), "$root-a");
    first.applyEvent(messageEvent(1), "$message-a");
    const restored = new MatrixMlp3Projection();
    restored.restore(first.durableState());
    expect(restored.visibleSessions()).toEqual(first.visibleSessions());
    expect(restored.sessionMessages("session-a")).toEqual(first.sessionMessages("session-a"));
    expect(restored.applyEvent(messageEvent(1), "$duplicate")).toBe(false);
  });

  it("tracks the active turn across durable restore and clears it on completion", () => {
    const first = new MatrixMlp3Projection();
    first.applyCommand(createCommand("a"), "$root-a");
    first.applyEvent(turnQueuedEvent(), "$queued-a");
    first.applyEvent(turnEvent("started", 3, "working"), "$started-a");

    expect(first.sessions.get("session-a")?.activeTurnId).toBe("prompt-a");

    const restored = new MatrixMlp3Projection();
    restored.restore(first.durableState());
    expect(restored.sessions.get("session-a")?.activeTurnId).toBe("prompt-a");

    restored.applyEvent(turnEvent("completed", 4, "idle"), "$completed-a");
    expect(restored.sessions.get("session-a")?.activeTurnId).toBeUndefined();
  });

  it("accepts an authoritative idle recovery at the same state version", () => {
    const projection = new MatrixMlp3Projection();
    projection.applyCommand(createCommand("a"), "$root-a");
    projection.applyCommand(promptCommand("a"), "$prompt-a");
    projection.applyEvent(turnQueuedEvent("a"), "$queued-a");
    projection.applyEvent(turnEvent("started", 3, "working", "a"), "$started-a");

    expect(projection.sessions.get("session-a")?.activeTurnId).toBe("prompt-a");

    projection.applyEvent({
      kind: "malink.event",
      version: 3,
      eventId: "gateway-recovery-runtime-2",
      workspaceId: "workspace-1",
      projectId: "project-1",
      sessionId: "session-a",
      occurredAt: 10,
      payload: {
        type: "session.ready",
        provider: "test",
        permissionMode: "default",
        projection: {
          title: "A",
          lifecycle: "active",
          activity: "idle",
          updatedAt: 3,
          stateVersion: 3,
        },
      },
    }, "$gateway-recovery");

    expect(projection.sessions.get("session-a")).toMatchObject({
      activity: "idle",
      stateVersion: 3,
    });
    expect(projection.sessions.get("session-a")?.activeTurnId).toBeUndefined();
  });

  it("settles two interrupted sessions after a Gateway restart despite stale event order", () => {
    const projection = new MatrixMlp3Projection();
    for (const suffix of ["a", "b"]) {
      projection.applyCommand(createCommand(suffix), `$root-${suffix}`);
      projection.applyCommand(promptCommand(suffix), `$prompt-${suffix}`);
      projection.applyEvent(turnQueuedEvent(suffix), `$queued-${suffix}`);
    }

    projection.applyEvent(interruptedEvent("a", 10), "$interrupted-a");
    projection.applyEvent(interruptedEvent("b", 11), "$interrupted-b");

    // Matrix can deliver the older working projection after the terminal
    // event. A durable completion must still win for each independent turn.
    projection.applyEvent(turnEvent("started", 3, "working", "a"), "$late-started-a");
    projection.applyEvent(turnEvent("started", 3, "working", "b"), "$late-started-b");

    expect(projection.sessions.get("session-a")).toMatchObject({
      activity: "idle",
      updatedAt: 10,
    });
    expect(projection.sessions.get("session-b")).toMatchObject({
      activity: "idle",
      updatedAt: 11,
    });
    expect(projection.sessions.get("session-a")?.activeTurnId).toBeUndefined();
    expect(projection.sessions.get("session-b")?.activeTurnId).toBeUndefined();
    expect(projection.completions.get("prompt-a")?.outcome).toBe("interrupted");
    expect(projection.completions.get("prompt-b")?.outcome).toBe("interrupted");
    expect(toIncomingMessage(projection.messages.get("command-rejected:prompt-a")!)).toMatchObject({
      kind: "error",
      text: "The Gateway restarted after dispatch. The command was not executed again.",
    });
  });

  it("repairs a version-four cache that already persisted an interrupted turn as working", () => {
    const first = new MatrixMlp3Projection();
    first.applyCommand(createCommand("a"), "$root-a");
    first.applyCommand(promptCommand("a"), "$prompt-a");
    first.applyEvent(turnQueuedEvent("a"), "$queued-a");
    first.applyEvent(interruptedEvent("a", 10), "$interrupted-a");

    const legacy = first.durableState() as unknown as {
      version: number;
      sessions: Array<Record<string, unknown>>;
    };
    legacy.version = 4;
    Object.assign(legacy.sessions[0]!, {
      activity: "working",
      activeTurnId: "prompt-a",
      updatedAt: 3,
    });

    const restored = new MatrixMlp3Projection();
    restored.restore(legacy);

    expect(restored.sessions.get("session-a")).toMatchObject({
      activity: "idle",
      updatedAt: 10,
    });
    expect(restored.sessions.get("session-a")?.activeTurnId).toBeUndefined();
    expect(restored.durableState().version).toBe(MATRIX_MLP3_PROJECTION_STATE_VERSION);
  });

  it("preserves the prompt origin through local and Gateway projections", () => {
    const projection = new MatrixMlp3Projection();
    projection.applyCommand(createCommand("a"), "$root-a");
    projection.applyCommand(promptCommand(), "$local-prompt", 2);

    const local = projection.messages.get("user:prompt-a");
    expect(local).toMatchObject({ originDeviceId: "device-1" });
    expect(toIncomingMessage(local!).originDeviceId).toBe("device-1");

    projection.applyEvent(turnQueuedEvent(), "$gateway-prompt");
    const canonical = projection.messages.get("user:prompt-a");
    expect(canonical).toMatchObject({
      originDeviceId: "device-1",
      physicalEventId: "$gateway-prompt",
    });
    expect(toIncomingMessage(canonical!).originDeviceId).toBe("device-1");

    const restored = new MatrixMlp3Projection();
    restored.restore(projection.durableState());
    expect(restored.messages.get("user:prompt-a")?.originDeviceId).toBe("device-1");
  });

  it("repairs a version-three running projection from its unresolved prompt", () => {
    const first = new MatrixMlp3Projection();
    first.applyCommand(createCommand("a"), "$root-a");
    first.applyEvent(turnQueuedEvent(), "$queued-a");
    const legacy = first.durableState() as unknown as {
      version: number;
      sessions: Array<Record<string, unknown>>;
    };
    legacy.version = 3;
    for (const session of legacy.sessions) delete session.activeTurnId;

    const restored = new MatrixMlp3Projection();
    restored.restore(legacy);

    expect(restored.sessions.get("session-a")?.activeTurnId).toBe("prompt-a");
  });

  it("discovers a session from the latest event in a paged Matrix thread", () => {
    const projection = new MatrixMlp3Projection();
    projection.applyEvent(lifecycleEvent("session-c", "active"), "$latest-c", "$root-c");
    expect(projection.visibleSessions()).toEqual([
      expect.objectContaining({ sessionId: "session-c", threadRootEventId: "$root-c" }),
    ]);
  });

  it("persists the newest authenticated workspace capability catalog", () => {
    const projection = new MatrixMlp3Projection();
    projection.applyEvent(workspaceSnapshot(2, "gpt-5.6-sol"), "$workspace-2");
    projection.applyEvent(workspaceSnapshot(1, "stale-model"), "$workspace-1");

    expect(projection.workspace).toEqual(expect.objectContaining({
      snapshotVersion: 2,
      clientReleases: [expect.objectContaining({ versionCode: 42 })],
      capabilities: expect.objectContaining({
        models: [expect.objectContaining({ id: "gpt-5.6-sol" })],
      }),
    }));

    const restored = new MatrixMlp3Projection();
    restored.restore(projection.durableState());
    expect(restored.workspace).toEqual(projection.workspace);
  });

  it("accepts a newer account release from a lower-version project snapshot", () => {
    const projection = new MatrixMlp3Projection();
    projection.applyEvent(workspaceSnapshot(10, "project-a-model", 42), "$workspace-a");
    projection.applyEvent(workspaceSnapshot(1, "project-b-model", 43), "$workspace-b");

    expect(projection.workspace).toMatchObject({
      snapshotVersion: 10,
      capabilities: { models: [{ id: "project-a-model" }] },
      clientReleases: [{ versionCode: 43 }],
    });
  });

  it("persists the latest Gateway update status in the workspace projection", () => {
    const projection = new MatrixMlp3Projection();
    projection.applyEvent(workspaceSnapshot(1, "gpt-5.6-sol"), "$workspace");
    projection.applyEvent({
      kind: "malink.event",
      version: 3,
      eventId: "gateway-update-staged-1",
      workspaceId: "workspace-1",
      projectId: "project-1",
      causationCommandId: "gateway-update-stage-1",
      occurredAt: 20,
      payload: {
        type: "gateway.update.status",
        status: {
          version: 1,
          phase: "staged",
          releaseId: "release-2",
          targetBuildId: "build-2",
          currentBuildId: "build-1",
          updatedAt: 20,
        },
      },
    }, "$gateway-update-staged");

    expect(projection.workspace?.gatewayUpdate).toMatchObject({
      phase: "staged",
      releaseId: "release-2",
    });
    expect(toLegacyCompletion(
      projection.completions.get("gateway-update-stage-1")!,
    )).toMatchObject({
      commandId: "gateway-update-stage-1",
      outcome: "succeeded",
      result: {
        version: 1,
        phase: "staged",
        releaseId: "release-2",
        targetBuildId: "build-2",
        currentBuildId: "build-1",
        updatedAt: 20,
      },
    });
    const restored = new MatrixMlp3Projection();
    restored.restore(projection.durableState());
    expect(restored.workspace?.gatewayUpdate).toEqual(projection.workspace?.gatewayUpdate);
  });

  it("converges shared Gateway status observations without a client command", () => {
    const projection = new MatrixMlp3Projection();
    projection.applyEvent(workspaceSnapshot(1, "gpt-5.6-sol"), "$workspace");
    const nodeStatus = (observedAt: number, phase: "staged" | "committed"): Mlp3Event => ({
      kind: "malink.event",
      version: 3,
      eventId: `gateway-node-status-${observedAt}`,
      workspaceId: "workspace-1",
      projectId: "project-1",
      occurredAt: observedAt,
      payload: {
        type: "gateway.update.status",
        status: {
          version: 1,
          phase,
          currentBuildId: phase === "committed" ? "build-2" : "build-1",
          targetBuildId: "build-2",
          updatedAt: observedAt,
        },
      },
    });

    expect(projection.applyEvent(nodeStatus(20, "staged"), "$status-20")).toBe(true);
    expect(projection.applyEvent(nodeStatus(19, "staged"), "$status-19")).toBe(false);
    expect(projection.applyEvent(nodeStatus(21, "committed"), "$status-21")).toBe(true);
    expect(projection.workspace?.gatewayUpdate).toMatchObject({
      phase: "committed",
      currentBuildId: "build-2",
    });
    expect(projection.gatewayUpdateObservation).toMatchObject({
      observedAt: 21,
      status: { phase: "committed", currentBuildId: "build-2" },
    });

    const restored = new MatrixMlp3Projection();
    restored.restore(projection.durableState());
    expect(restored.gatewayUpdateObservation).toEqual(projection.gatewayUpdateObservation);

    const historyFirst = new MatrixMlp3Projection();
    expect(historyFirst.applyEvent(nodeStatus(22, "committed"), "$status-22")).toBe(true);
    expect(historyFirst.applyEvent(workspaceSnapshot(2, "gpt-5.6-sol"), "$workspace-2"))
      .toBe(true);
    expect(historyFirst.workspace?.gatewayUpdate).toMatchObject({
      phase: "committed",
      currentBuildId: "build-2",
    });
  });

  it("projects extension defaults and resolves an interaction on every device", () => {
    const projection = new MatrixMlp3Projection();
    projection.applyEvent(projectSnapshot(), "$project");
    projection.applyCommand(createCommand("a"), "$root-a");
    projection.applyEvent(extensionInteraction("requested"), "$request");
    projection.applyEvent(extensionInteraction("resolved"), "$resolved");

    expect(projection.project).toMatchObject({
      defaultExtensions: [{ id: "prefix-transform" }],
      installedExtensions: [{ id: "prefix-transform" }],
    });
    expect(projection.messages.get("decision:extension-request-1")).toMatchObject({
      resolvedActionId: "continue",
      physicalEventId: "$resolved",
      version: 2,
    });
  });

  it("persists workspace inbox files without assigning them to a session", () => {
    const projection = new MatrixMlp3Projection();
    projection.applyEvent(inboxFileEvent(), "$workspace-file");

    expect(projection.visibleInboxFiles()).toEqual([
      expect.objectContaining({
        fileId: "workspace-file-1",
        caption: "Generated report",
        sourceLabel: "review-agent",
      }),
    ]);
    expect(projection.messages.size).toBe(0);

    const restored = new MatrixMlp3Projection();
    restored.restore(projection.durableState());
    expect(restored.visibleInboxFiles()).toEqual(projection.visibleInboxFiles());
  });

  it("uses the MLP logical ID across clients while retaining Matrix IDs as migration aliases", () => {
    const projection = new MatrixMlp3Projection();
    projection.applyEvent(messageEvent(1), "$matrix-version-1");
    const first = projection.messages.get("assistant:message-1:0");
    expect(first).toBeDefined();

    const firstIncoming = toIncomingMessage(first!);
    expect(firstIncoming.eventId).toBe("assistant:message-1:0");
    expect(firstIncoming.replacesEventId).toBe("$matrix-version-1");

    projection.applyEvent(messageEvent(1, 2), "$matrix-version-2");
    const second = projection.messages.get("assistant:message-1:0");
    expect(second).toBeDefined();
    const secondIncoming = toIncomingMessage(second!, "$matrix-version-1");
    expect(secondIncoming.eventId).toBe(firstIncoming.eventId);
    expect(secondIncoming.replacesEventId).toBe("$matrix-version-1");
  });

  it("labels presentation delivery without changing the projected message identity", () => {
    const projection = new MatrixMlp3Projection();
    projection.applyEvent(messageEvent(1), "$matrix-version-1");
    const projected = projection.messages.get("assistant:message-1:0");
    expect(projected).toBeDefined();

    expect(toIncomingMessage(projected!)).toMatchObject({
      eventId: "assistant:message-1:0",
      deliveryMode: "live",
    });
    expect(toIncomingMessage(projected!, undefined, "catchup")).toMatchObject({
      eventId: "assistant:message-1:0",
      deliveryMode: "catchup",
    });
    expect(toIncomingMessage(projected!, undefined, "history")).toMatchObject({
      eventId: "assistant:message-1:0",
      deliveryMode: "history",
      historical: true,
    });
  });

  it("keeps streamed Agent and tool messages in one order after projection restore", () => {
    const projection = new MatrixMlp3Projection();
    projection.applyEvent(messageEvent(1, 1, 100), "$agent-v1");
    projection.applyEvent(toolPresentationMessageEvent(200), "$tool");
    projection.applyEvent(messageEvent(1, 2, 300), "$agent-v2");

    expect(projection.sessionMessages("session-a").map(message => message.logicalId)).toEqual([
      "assistant:message-1:0",
      "assistant:tool-message-1:0",
    ]);
    expect(projection.messages.get("assistant:message-1:0")).toMatchObject({
      body: "message 1 v2",
      timestamp: 100,
      version: 2,
    });

    const restored = new MatrixMlp3Projection();
    restored.restore(projection.durableState());
    expect(restored.sessionMessages("session-a").map(message => message.logicalId)).toEqual([
      "assistant:message-1:0",
      "assistant:tool-message-1:0",
    ]);

    const newestFirst = new MatrixMlp3Projection();
    newestFirst.applyEvent(messageEvent(1, 2, 300), "$agent-v2-first");
    newestFirst.applyEvent(toolPresentationMessageEvent(200), "$tool-second");
    newestFirst.applyEvent(messageEvent(1, 1, 100), "$agent-v1-last");
    expect(newestFirst.sessionMessages("session-a").map(message => message.logicalId)).toEqual([
      "assistant:message-1:0",
      "assistant:tool-message-1:0",
    ]);
    expect(newestFirst.messages.get("assistant:message-1:0")).toMatchObject({
      body: "message 1 v2",
      timestamp: 100,
      version: 2,
    });
  });

  it("classifies assistant messages with a tool presentation as tool messages", () => {
    const projection = new MatrixMlp3Projection();
    projection.applyEvent(toolPresentationMessageEvent(), "$tool-message");

    const projected = projection.messages.get("assistant:tool-message-1:0");
    expect(projected).toBeDefined();
    expect(toIncomingMessage(projected!)).toMatchObject({
      kind: "tool",
      text: "Read file",
      toolGroup: {
        kind: "tool_group",
        groupId: "tool-call-1",
        tools: [{ id: "tool-call-1", phase: "completed" }],
      },
    });
  });

  it("synthesizes a tool presentation for native MLP tool activity events", () => {
    const projection = new MatrixMlp3Projection();
    projection.applyEvent(toolActivityEvent(), "$tool-activity");

    const projected = projection.messages.get("tool:tool-call-2");
    expect(projected).toBeDefined();
    expect(toIncomingMessage(projected!)).toMatchObject({
      kind: "tool",
      toolGroup: {
        groupId: "tool-call-2",
        tools: [{
          id: "tool-call-2",
          name: "Search",
          phase: "started",
          category: "unknown",
        }],
      },
    });
  });
});

function toolPresentationMessageEvent(
  timestamp = 1_700_000_000_000,
): Mlp3Event {
  return {
    kind: "malink.event",
    version: 3,
    eventId: "tool-message-event-1",
    workspaceId: "workspace-1",
    projectId: "project-1",
    sessionId: "session-a",
    occurredAt: timestamp,
    payload: {
      type: "assistant.message",
      messageId: "tool-message-1",
      messageVersion: 1,
      body: "Read file",
      format: "plain",
      final: true,
      projection: {
        title: "A",
        lifecycle: "active",
        activity: "working",
        updatedAt: timestamp,
        stateVersion: 2,
      },
      ui: {
        kind: "tool_group",
        version: 1,
        groupId: "tool-call-1",
        tools: [{
          id: "tool-call-1",
          name: "Read",
          title: "Read file",
          detail: "/workspace/file.ts",
          category: "read",
          phase: "completed",
          isError: false,
          startedAt: timestamp - 10,
          updatedAt: timestamp,
        }],
      },
    },
  };
}

function toolActivityEvent(): Mlp3Event {
  const timestamp = 1_700_000_000_100;
  return {
    kind: "malink.event",
    version: 3,
    eventId: "tool-activity-event-1",
    workspaceId: "workspace-1",
    projectId: "project-1",
    sessionId: "session-a",
    occurredAt: timestamp,
    payload: {
      type: "tool.activity",
      toolCallId: "tool-call-2",
      toolVersion: 1,
      name: "Search",
      phase: "started",
      projection: {
        title: "A",
        lifecycle: "active",
        activity: "working",
        updatedAt: timestamp,
        stateVersion: 2,
      },
    },
  };
}

function inboxFileEvent(): Mlp3Event {
  return {
    kind: "malink.event",
    version: 3,
    eventId: "workspace-file-event-1",
    workspaceId: "workspace-1",
    projectId: "project-1",
    occurredAt: 5,
    payload: {
      type: "inbox.file.received",
      fileId: "workspace-file-1",
      caption: "Generated report",
      source: { kind: "local-cli", label: "review-agent" },
      attachment: {
        id: "attachment-1",
        name: "report.pdf",
        mimeType: "application/pdf",
        size: 12,
        sha256: "A".repeat(43),
        media: {
          url: "mxc://example.org/report",
          key: "B".repeat(43),
          iv: "C".repeat(16),
          sha256: "D".repeat(43),
          size: 28,
        },
      },
    },
  };
}

function workspaceSnapshot(
  snapshotVersion: number,
  model: string,
  releaseVersion = 42,
): Mlp3Event {
  return {
    kind: "malink.event",
    version: 3,
    eventId: `workspace-${snapshotVersion}`,
    workspaceId: "workspace-1",
    projectId: "project-1",
    occurredAt: snapshotVersion,
    payload: {
      type: "workspace.snapshot",
      protocolMin: 3,
      protocolMax: 3,
      gatewayKeyId: "gateway-key-1",
      clientReleases: [{
        platform: "android",
        channel: "alpha",
        architecture: "arm64-v8a",
        packageName: "id.my.anciety.malink",
        versionCode: releaseVersion,
        versionName: `0.1.0-alpha.${releaseVersion}`,
        buildId: `build-${releaseVersion}`,
        publishedAt: releaseVersion,
        minimumAndroid: 26,
        nativeBridgeMinimum: 1,
        nativeBridgeMaximum: 1,
        importance: "recommended",
        releaseNotes: ["Test release"],
        artifact: {
          url: `https://rd.anciety.my.id/native-updates/releases/android/alpha/${releaseVersion}/malink.apk`,
          size: 1_024,
          sha256: "a".repeat(64),
          signingCertificateSha256: "b".repeat(64),
        },
      }],
      capabilities: {
        models: [{
          id: model,
          name: model,
          default_reasoning_level: "high",
          supported_reasoning_levels: [{ effort: "high" }],
        }],
        permission_modes: [{ id: "default", name: "Default" }],
        can_create_session: true,
        can_select_session: false,
        can_archive_session: true,
        can_delete_session: true,
        session_extensions: [],
      },
      snapshotVersion,
    },
  };
}

function projectSnapshot(): Mlp3Event {
  return {
    kind: "malink.event",
    version: 3,
    eventId: "project-snapshot-1",
    workspaceId: "workspace-1",
    projectId: "project-1",
    occurredAt: 1,
    payload: {
      type: "project.snapshot",
      name: "Project",
      cwd: "/repo",
      provider: "test",
      permissionMode: "default",
      installedExtensions: [{
        id: "prefix-transform",
        name: "Prefix transform",
        description: "Adds a prefix.",
        version: "1",
        settings: [],
      }],
      defaultExtensions: [{ id: "prefix-transform" }],
      extensionDefaultsRevision: 2,
      snapshotVersion: 2,
    },
  };
}

function extensionInteraction(stage: "requested" | "resolved"): Mlp3Event {
  const common = {
    kind: "malink.event" as const,
    version: 3 as const,
    eventId: `extension-${stage}-1`,
    workspaceId: "workspace-1",
    projectId: "project-1",
    sessionId: "session-a",
    occurredAt: stage === "requested" ? 2 : 3,
  };
  const projection = {
    title: "A",
    lifecycle: "active" as const,
    activity: "attention" as const,
    updatedAt: 2,
    stateVersion: 2,
  };
  return stage === "requested" ? {
    ...common,
    payload: {
      type: "extension.interaction.requested",
      requestId: "extension-request-1",
      extension: { id: "prefix-transform", name: "Prefix transform", version: "1" },
      cancelActionId: "cancel",
      view: {
        version: 1,
        title: "Review transformed input",
        elements: [{ type: "readonly_textarea", label: "Agent input", value: "SAFE: hello" }],
        actions: [
          { id: "continue", label: "Continue", style: "primary" },
          { id: "cancel", label: "Cancel", style: "secondary" },
        ],
      },
      projection,
    },
  } : {
    ...common,
    causationCommandId: "answer-1",
    payload: {
      type: "extension.interaction.resolved",
      requestId: "extension-request-1",
      extensionId: "prefix-transform",
      actionId: "continue",
      projection: { ...projection, activity: "working", updatedAt: 3, stateVersion: 3 },
    },
  };
}

function createCommand(suffix: string): Mlp3Command {
  return {
    kind: "malink.command",
    version: 3,
    commandId: `create-${suffix}`,
    workspaceId: "workspace-1",
    projectId: "project-1",
    sessionId: `session-${suffix}`,
    deviceId: "device-1",
    certificateId: "certificate-1",
    createdAt: 1,
    operation: "session.create",
    payload: { operation: "session.create", title: suffix.toUpperCase() },
  };
}

function promptCommand(suffix = "a"): Mlp3Command {
  return {
    kind: "malink.command",
    version: 3,
    commandId: `prompt-${suffix}`,
    workspaceId: "workspace-1",
    projectId: "project-1",
    sessionId: `session-${suffix}`,
    deviceId: "device-1",
    certificateId: "certificate-1",
    createdAt: 2,
    operation: "prompt.submit",
    payload: { operation: "prompt.submit", text: "hello" },
  };
}

function turnEvent(
  stage: "started" | "completed",
  stateVersion: number,
  activity: "working" | "idle",
  suffix = "a",
): Mlp3Event {
  return {
    kind: "malink.event",
    version: 3,
    eventId: `turn-${stage}-${suffix}`,
    workspaceId: "workspace-1",
    projectId: "project-1",
    sessionId: `session-${suffix}`,
    occurredAt: stateVersion,
    causationCommandId: `prompt-${suffix}`,
    payload: stage === "started" ? {
      type: "turn.started",
      turnId: `prompt-${suffix}`,
      projection: { title: "A", lifecycle: "active", activity, updatedAt: stateVersion, stateVersion },
    } : {
      type: "turn.completed",
      turnId: `prompt-${suffix}`,
      outcome: "succeeded",
      projection: { title: "A", lifecycle: "active", activity, updatedAt: stateVersion, stateVersion },
    },
  };
}

function turnQueuedEvent(suffix = "a"): Mlp3Event {
  return {
    kind: "malink.event",
    version: 3,
    eventId: `turn-queued-${suffix}`,
    workspaceId: "workspace-1",
    projectId: "project-1",
    sessionId: `session-${suffix}`,
    occurredAt: 2,
    causationCommandId: `prompt-${suffix}`,
    payload: {
      type: "turn.queued",
      turnId: `prompt-${suffix}`,
      originDeviceId: "device-1",
      text: "hello",
      projection: {
        title: "A",
        lifecycle: "active",
        activity: "queued",
        updatedAt: 2,
        stateVersion: 2,
      },
    },
  };
}

function interruptedEvent(suffix: string, occurredAt: number): Mlp3Event {
  return {
    kind: "malink.event",
    version: 3,
    eventId: `turn-interrupted-${suffix}`,
    workspaceId: "workspace-1",
    projectId: "project-1",
    sessionId: `session-${suffix}`,
    occurredAt,
    causationCommandId: `prompt-${suffix}`,
    payload: {
      type: "command.rejected",
      commandId: `prompt-${suffix}`,
      code: "execution_interrupted",
      message: "The Gateway restarted after dispatch. The command was not executed again.",
      retryable: true,
    },
  };
}

function messageEvent(
  index: number,
  messageVersion = 1,
  occurredAt = index + 2,
): Mlp3Event {
  return {
    kind: "malink.event",
    version: 3,
    eventId: messageVersion === 1
      ? `event-${index}`
      : `event-${index}-v${messageVersion}`,
    workspaceId: "workspace-1",
    projectId: "project-1",
    sessionId: "session-a",
    occurredAt,
    payload: {
      type: "assistant.message",
      messageId: `message-${index}`,
      messageVersion,
      body: `message ${index} v${messageVersion}`,
      format: "markdown",
      final: true,
      projection: { title: "A", lifecycle: "active", activity: "working", updatedAt: occurredAt, stateVersion: 2 },
    },
  };
}

function lifecycleEvent(
  sessionId: string,
  state: "active" | "archived" | "deleted",
): Mlp3Event {
  return {
    kind: "malink.event",
    version: 3,
    eventId: `lifecycle-${sessionId}-${state}`,
    workspaceId: "workspace-1",
    projectId: "project-1",
    sessionId,
    occurredAt: 3,
    causationCommandId: `delete-${sessionId}`,
    payload: {
      type: "session.lifecycle",
      state,
      projection: { title: sessionId, lifecycle: state, activity: "idle", updatedAt: 3, stateVersion: 2 },
    },
  };
}
