import { describe, expect, it } from "vitest";
import {
  classifyGatewayStateProgress,
  gatewayMaintenanceSessionActivityOutcome,
  isIgnorableGatewayStateReplay,
  parseGatewayCapabilities,
  parseGatewayStateExtension,
} from "./gatewayState";

describe("Provider presentation", () => {
  it("presents legacy agent capabilities as Cursor without changing the provider id", () => {
    const capabilities = parseGatewayCapabilities({
      models: [],
      providers: [{
        id: "agent",
        name: "agent",
        models: [],
        can_list_sessions: true,
        can_inspect_sessions: true,
      }],
      permission_modes: [],
      can_create_session: true,
      can_select_session: false,
      session_extensions: [],
    });

    expect(capabilities.providers[0]).toMatchObject({
      id: "agent",
      name: "Cursor",
    });
  });

  it("preserves custom labels for agent-compatible profiles", () => {
    const capabilities = parseGatewayCapabilities({
      models: [],
      providers: [{
        id: "agent",
        name: "Cursor Work Account",
        models: [],
        can_list_sessions: true,
        can_inspect_sessions: true,
      }],
      permission_modes: [],
      can_create_session: true,
      can_select_session: false,
      session_extensions: [],
    });

    expect(capabilities.providers[0]?.name).toBe("Cursor Work Account");
  });
});

describe("Gateway state progress", () => {
  it("accepts a Matrix-native revision advance on current Gateway metadata", () => {
    expect(
      classifyGatewayStateProgress(
        { stateVersion: 1, revision: 0 },
        { stateVersion: 1, revision: 1 },
      ),
    ).toBe("advance");
  });

  it("accepts metadata-version and revision advances independently", () => {
    expect(
      classifyGatewayStateProgress(
        { stateVersion: 1, revision: 1 },
        { stateVersion: 2, revision: 1 },
      ),
    ).toBe("advance");
  });

  it("rejects a regression in either monotonic dimension", () => {
    expect(
      classifyGatewayStateProgress(
        { stateVersion: 2, revision: 3 },
        { stateVersion: 1, revision: 4 },
      ),
    ).toBe("stale");
    expect(
      classifyGatewayStateProgress(
        { stateVersion: 2, revision: 3 },
        { stateVersion: 3, revision: 2 },
      ),
    ).toBe("stale");
  });

  it("ignores authenticated older timeline state without accepting conflicts", () => {
    expect(isIgnorableGatewayStateReplay("retired")).toBe(true);
    expect(isIgnorableGatewayStateReplay("stale")).toBe(true);
    expect(isIgnorableGatewayStateReplay("current", "stale")).toBe(true);
    expect(isIgnorableGatewayStateReplay("conflict")).toBe(false);
    expect(isIgnorableGatewayStateReplay("current", "advance")).toBe(false);
  });
});

describe("Native Gateway state catalogs", () => {
  it("expands a shared ACP command catalog referenced by multiple sessions", () => {
    const session = (id: string) => ({
      id,
      title: id,
      updated_at: 1,
      state_version: 1,
      status: "idle",
      activity_phase: "idle",
      project_id: "project-1",
      project_name: "Project",
      cwd: "/workspace",
      provider: "codex",
      extensions: [],
      available_commands_ref: 0,
    });
    const workspace = {
      project_id: "project-1",
      project_name: "Project",
      cwd: "/workspace",
      provider: "codex",
      permission_mode: "default",
      capabilities_ref: 0,
    };
    const capabilities = {
      models: [],
      providers: [],
      permission_modes: [],
      can_create_session: true,
      can_select_session: false,
      session_extensions: [],
    };
    const parsed = parseGatewayStateExtension({
      kind: "gateway_state",
      version: 1,
      state_version: 1,
      revision: 0,
      revision_epoch: "matrix-native-v3",
      revision_epoch_generation: 1,
      active_device_count: 1,
      current_session_id: null,
      sessions: [session("session-1"), session("session-2")],
      session_array_catalogs: {
        available_commands: [[{
          name: "review",
          description: "Review the workspace",
          inputHint: null,
        }]],
      },
      workspace,
      projects: [workspace],
      project_capability_catalogs: [capabilities],
      capabilities,
    });

    expect(parsed?.sessions.map(value => value.availableCommands)).toEqual([
      [{ name: "review", description: "Review the workspace", inputHint: null }],
      [{ name: "review", description: "Review the workspace", inputHint: null }],
    ]);
    expect(parsed?.workspace.capabilities).toEqual(parsed?.capabilities);
    expect(parsed?.projects?.[0]?.capabilities).toEqual(parsed?.capabilities);
  });

  it("rejects an unknown ACP command catalog reference", () => {
    expect(() => parseGatewayStateExtension({
      kind: "gateway_state",
      version: 1,
      state_version: 1,
      revision: 0,
      revision_epoch: "matrix-native-v3",
      revision_epoch_generation: 1,
      active_device_count: 1,
      current_session_id: null,
      sessions: [{
        id: "session-1",
        title: "Session",
        updated_at: 1,
        state_version: 1,
        status: "idle",
        project_id: "project-1",
        project_name: "Project",
        cwd: "/workspace",
        provider: "codex",
        extensions: [],
        available_commands_ref: 1,
      }],
      session_array_catalogs: { available_commands: [[]] },
      workspace: {
        project_id: "project-1",
        project_name: "Project",
        cwd: "/workspace",
        provider: "codex",
        permission_mode: "default",
      },
      capabilities: {
        models: [],
        providers: [],
        permission_modes: [],
        can_create_session: true,
        can_select_session: false,
        session_extensions: [],
      },
    })).toThrow("command catalog reference is invalid");
  });
});

describe("Gateway maintenance session convergence", () => {
  it("settles only the exact node-scoped session after Agent maintenance", () => {
    const status = {
      version: 1 as const,
      phase: "committed" as const,
      maintenanceSessionId: "gateway-update-node-office-release-2",
      currentBuildId: "build-2",
      targetBuildId: "build-2",
      updatedAt: 20,
    };
    expect(gatewayMaintenanceSessionActivityOutcome(
      status,
      "gateway-update-node-office-release-2",
    )).toBe("idle");
    expect(gatewayMaintenanceSessionActivityOutcome(
      status,
      "gateway-update-node-server-release-2",
    )).toBeNull();
  });

  it("does not use ambiguous maintenance IDs from older multi-Gateway releases", () => {
    expect(gatewayMaintenanceSessionActivityOutcome({
      version: 1,
      phase: "committed",
      maintenanceSessionId: "gateway-update-shared-release-1",
      currentBuildId: "build-1",
      updatedAt: 20,
    }, "gateway-update-shared-release-1")).toBeNull();
  });
});
