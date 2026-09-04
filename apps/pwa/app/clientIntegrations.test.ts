import { describe, expect, it } from "vitest";
import type { SessionExtensionDescriptor } from "@malink/protocol";
import {
  clientIntegrationLaunchMessage,
  parseClientIntegrationHostRequest,
  parseIntegrationEntryPresentation,
  resolveClientIntegration,
} from "./clientIntegrations";

const extension: SessionExtensionDescriptor = {
  id: "metapp",
  name: "metapp",
  description: "metapp session renderer",
  version: "1",
  settings: [],
  clientIntegration: {
    origin: "https://app.metapp.example",
    bridgeVersion: 1,
    routes: [{ id: "artifact.preview", path: "/embed/preview" }],
    capabilities: ["host.close", "host.read-theme", "host.read-locale"],
  },
};

const raw = {
  type: "assistant.message",
  ui: {
    kind: "integration_entry",
    version: 1,
    integrationId: "metapp",
    routeId: "artifact.preview",
    resourceRef: "private-artifact-reference",
    title: "Project report",
  },
};

const hostOrigin = "https://malink.example";

describe("PWA client integrations", () => {
  it("resolves only routes declared by the installed extension", () => {
    const entry = parseIntegrationEntryPresentation(raw);
    expect(entry).toBeDefined();
    const resolution = resolveClientIntegration(entry!, [extension], hostOrigin);
    expect(resolution).toMatchObject({
      status: "ready",
      target: {
        origin: "https://app.metapp.example",
        url: "https://app.metapp.example/embed/preview",
      },
    });
    expect(JSON.stringify(resolution)).not.toContain("?");

    expect(resolveClientIntegration({
      ...entry!,
      routeId: "unregistered.route",
    }, [extension], hostOrigin)).toMatchObject({ status: "unavailable" });
    expect(resolveClientIntegration(entry!, [], hostOrigin)).toMatchObject({
      status: "unavailable",
    });
    expect(resolveClientIntegration(
      entry!,
      [{
        ...extension,
        clientIntegration: {
          ...extension.clientIntegration!,
          origin: "https://malink.example",
        },
      }],
      "https://malink.example",
    )).toMatchObject({ status: "unavailable" });
  });

  it("passes the opaque resource over the bridge instead of the iframe URL", () => {
    const entry = parseIntegrationEntryPresentation(raw)!;
    const resolution = resolveClientIntegration(entry, [extension], hostOrigin);
    if (resolution.status !== "ready") throw new Error("expected integration target");
    const launch = clientIntegrationLaunchMessage(resolution.target, {
      locale: "zh-CN",
      colorScheme: "dark",
    });
    expect(launch).toMatchObject({
      type: "launch",
      resourceRef: "private-artifact-reference",
      environment: { locale: "zh-CN", colorScheme: "dark" },
    });
    expect(resolution.target.url).not.toContain("private-artifact-reference");
  });

  it("discloses host environment values only when declared", () => {
    const entry = parseIntegrationEntryPresentation(raw)!;
    const resolution = resolveClientIntegration(
      entry,
      [{
        ...extension,
        clientIntegration: {
          ...extension.clientIntegration!,
          capabilities: ["host.close"],
        },
      }],
      hostOrigin,
    );
    if (resolution.status !== "ready") throw new Error("expected integration target");

    expect(clientIntegrationLaunchMessage(resolution.target, {
      locale: "zh-CN",
      colorScheme: "dark",
    }).environment).toEqual({});
  });

  it("accepts only exact close/back requests on the transferred channel", () => {
    expect(parseClientIntegrationHostRequest({
      protocol: "io.malink.client-integration",
      version: 1,
      type: "close",
    })).toMatchObject({ type: "close" });
    expect(parseClientIntegrationHostRequest({
      protocol: "io.malink.client-integration",
      version: 1,
      type: "close",
      resourceRef: "attempted-overreach",
    })).toBeUndefined();
    expect(parseClientIntegrationHostRequest({
      protocol: "io.malink.client-integration",
      version: 1,
      type: "execute",
    })).toBeUndefined();
  });
});
