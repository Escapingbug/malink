import { describe, expect, it } from "vitest";
import type { GatewayCapabilities, GatewayWorkspaceState } from "./gatewayState";
import { gatewayProjectOwner } from "./projectCatalog";
import {
  buildProviderHistorySources,
  firstMatchingProviderHistorySource,
  providerHistoryCommandKey,
  providerHistoryRequestMatches,
} from "./providerHistoryRouting";

const historyCapabilities: GatewayCapabilities = {
  models: [],
  providers: [{
    id: "codex",
    name: "Codex",
    models: [],
    canListSessions: true,
    canInspectSessions: true,
  }],
  permissionModes: [],
  canCreateSession: true,
  canSelectSession: true,
  sessionExtensions: [],
};

function workspace(
  projectId: string,
  projectName: string,
  cwd: string,
  capabilities: GatewayCapabilities | null = historyCapabilities,
): GatewayWorkspaceState {
  return {
    projectId,
    projectName,
    cwd,
    provider: "codex",
    permissionMode: "default",
    ...(capabilities ? { capabilities } : {}),
  };
}

describe("Provider History routing", () => {
  it("keeps every eligible Project distinct and groups it under its owning Gateway", () => {
    const office = gatewayProjectOwner("gateway-office", "Office Mac", "alice-mac");
    const home = gatewayProjectOwner("gateway-home", "Home NAS");
    const sources = buildProviderHistorySources({
      workspaces: [
        workspace("project-api", "API", "/work/api"),
        workspace("project-web", "Web", "/work/web"),
        workspace("project-home", "Personal", "/srv/personal"),
      ],
      projectOwners: new Map([
        ["project-api", office],
        ["project-web", office],
        ["project-home", home],
      ]),
      fallbackOwner: office,
      fallbackCapabilities: historyCapabilities,
      directoryAvailable: true,
    });

    expect(sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        gatewayNodeId: "gateway-office",
        projectId: "project-api",
        gatewayLabel: "Office Mac · alice-mac",
      }),
      expect.objectContaining({
        gatewayNodeId: "gateway-office",
        projectId: "project-web",
      }),
      expect.objectContaining({
        gatewayNodeId: "gateway-home",
        projectId: "project-home",
      }),
    ]));
    expect(new Set(sources.map(source => source.key)).size).toBe(3);
    expect(sources.every(source => !source.key.includes("\u0000"))).toBe(true);
  });

  it("fails closed when a Project is absent from an available signed directory", () => {
    const office = gatewayProjectOwner("gateway-office", "Office Mac");
    const sources = buildProviderHistorySources({
      workspaces: [
        workspace("project-known", "Known", "/work/known"),
        workspace("project-orphan", "Orphan", "/work/orphan"),
      ],
      projectOwners: new Map([["project-known", office]]),
      fallbackOwner: office,
      fallbackCapabilities: historyCapabilities,
      directoryAvailable: true,
    });

    expect(sources.map(source => source.projectId)).toEqual(["project-known"]);
  });

  it("keeps a legacy Project on the fallback Gateway before a directory exists", () => {
    const fallback = gatewayProjectOwner("gateway-legacy", "Legacy Mac");
    const sources = buildProviderHistorySources({
      workspaces: [workspace("project-legacy", "Legacy", "/work/legacy", null)],
      projectOwners: new Map(),
      fallbackOwner: fallback,
      fallbackCapabilities: historyCapabilities,
      directoryAvailable: false,
    });

    expect(sources).toEqual([expect.objectContaining({
      gatewayNodeId: "gateway-legacy",
      projectId: "project-legacy",
    })]);
  });

  it("prioritizes a just-archived route over the active Project", () => {
    const office = gatewayProjectOwner("gateway-office", "Office Mac");
    const home = gatewayProjectOwner("gateway-home", "Home NAS");
    const sources = buildProviderHistorySources({
      workspaces: [
        workspace("project-active", "Active", "/work/active"),
        workspace("project-archived", "Archived", "/work/archived"),
      ],
      projectOwners: new Map([
        ["project-active", office],
        ["project-archived", home],
      ]),
      fallbackOwner: office,
      fallbackCapabilities: historyCapabilities,
      directoryAvailable: true,
    });

    expect(firstMatchingProviderHistorySource(sources, [{
      gatewayNodeId: "gateway-home",
      projectId: "project-archived",
    }, {
      gatewayNodeId: "gateway-office",
      projectId: "project-active",
    }])?.projectId).toBe("project-archived");
  });

  it("does not recover a request against another Gateway or Project", () => {
    const request = {
      gatewayNodeId: "gateway-office",
      projectId: "project-api",
      provider: "codex",
      kind: "sessions" as const,
    };
    expect(providerHistoryRequestMatches(request, request)).toBe(true);
    expect(providerHistoryRequestMatches(request, {
      ...request,
      gatewayNodeId: "gateway-home",
    })).toBe(false);
    expect(providerHistoryRequestMatches(request, {
      ...request,
      projectId: "project-web",
    })).toBe(false);
    expect(providerHistoryRequestMatches(request, {
      ...request,
      cursor: "provider-history-offset-v1:10",
    })).toBe(false);
  });

  it("keeps pending commands distinct across Project, Provider, and session", () => {
    const request = {
      gatewayNodeId: "gateway-office",
      projectId: "project-api",
      provider: "codex",
      kind: "sessions" as const,
    };
    const keys = [
      providerHistoryCommandKey(request),
      providerHistoryCommandKey({ ...request, projectId: "project-web" }),
      providerHistoryCommandKey({ ...request, gatewayNodeId: "gateway-home" }),
      providerHistoryCommandKey({ ...request, provider: "cursor" }),
      providerHistoryCommandKey({ ...request, cursor: "provider-history-offset-v1:10" }),
      providerHistoryCommandKey({
        ...request,
        kind: "session",
        providerSessionId: "session-one",
      }),
      providerHistoryCommandKey({
        ...request,
        kind: "session",
        providerSessionId: "session-two",
      }),
    ];

    expect(new Set(keys).size).toBe(keys.length);
  });
});
