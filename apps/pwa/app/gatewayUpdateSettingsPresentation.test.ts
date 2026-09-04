import { describe, expect, it } from "vitest";
import { gatewayUpdateSettingsPresentation } from "./gatewayUpdateSettingsPresentation";

describe("gatewayUpdateSettingsPresentation", () => {
  it("keeps the section visible when release discovery fails", () => {
    const presentation = gatewayUpdateSettingsPresentation({
      trusted: true,
      discoveryBusy: false,
      discoveryError: "HTTP 404",
      directoryState: "ready",
      connectionStatus: "connected",
      availableCount: 0,
      nodeCount: 2,
    });

    expect(presentation.action).toBe("retry-discovery");
    expect(presentation.actionLabel).toBe("Retry release check");
    expect(presentation.detail).toContain("HTTP 404");
  });

  it("does not offer reconnect when Matrix is already connected", () => {
    const presentation = gatewayUpdateSettingsPresentation({
      trusted: true,
      releaseId: "release-1",
      discoveryBusy: false,
      directoryState: "missing",
      connectionStatus: "connected",
      availableCount: 0,
      nodeCount: 0,
    });

    expect(presentation.action).toBeNull();
    expect(presentation.detail).toContain("signed Gateway Directory");
    expect(presentation.detail).toContain("Bring a Gateway computer online");
  });

  it("offers Workspace reconnection when the connection is not ready", () => {
    const presentation = gatewayUpdateSettingsPresentation({
      trusted: true,
      releaseId: "release-1",
      discoveryBusy: false,
      directoryState: "missing",
      connectionStatus: "offline",
      availableCount: 0,
      nodeCount: 0,
    });

    expect(presentation.action).toBe("reconnect");
    expect(presentation.actionLabel).toBe("Reconnect Workspace");
  });

  it("opens review only when release and Gateway directory are actionable", () => {
    const presentation = gatewayUpdateSettingsPresentation({
      trusted: true,
      releaseId: "release-1",
      discoveryBusy: false,
      directoryState: "ready",
      connectionStatus: "connected",
      availableCount: 2,
      nodeCount: 2,
    });

    expect(presentation.action).toBe("review");
    expect(presentation.actionLabel).toBe("Review 2 updates");
    expect(presentation.attention).toBe(false);
  });
});
