import { describe, expect, it } from "vitest";
import { durableCommandRecoveryPresentation } from "./durableCommandRecoveryPresentation";

describe("durableCommandRecoveryPresentation", () => {
  it("explains an accepted command as journal reconciliation, not resubmission", () => {
    const presentation = durableCommandRecoveryPresentation({
      state: "accepted",
      connectionStatus: "connected",
      gatewayAvailable: true,
    });

    expect(presentation).toMatchObject({
      title: "Waiting for a verified result",
      stateLabel: "Accepted by your computer",
      primaryAction: "check",
      primaryLabel: "Check Gateway journal",
    });
    expect(presentation.detail).toContain("Gateway journal");
    expect(presentation.detail).toContain("will not run twice");
  });

  it("pauses recovery with a reconnect action while Matrix is offline", () => {
    const presentation = durableCommandRecoveryPresentation({
      state: "recovery_required",
      connectionStatus: "offline",
      gatewayAvailable: false,
    });

    expect(presentation).toMatchObject({
      title: "Previous action is waiting for recovery",
      stateLabel: "Recovery required",
      primaryAction: "reconnect",
      primaryLabel: "Reconnect",
    });
    expect(presentation.detail).toContain("saved locally");
    expect(presentation.detail).toContain("cannot submit it twice");
  });

  it("distinguishes a connected Matrix server from an unavailable Gateway", () => {
    const presentation = durableCommandRecoveryPresentation({
      state: "running",
      connectionStatus: "connected",
      gatewayAvailable: false,
    });

    expect(presentation.title).toBe("Waiting for your computer");
    expect(presentation.detail).toContain("Matrix is connected");
    expect(presentation.detail).toContain("Gateway");
    expect(presentation.primaryAction).toBeNull();
  });

  it("offers the Android update that unlocks recovery for an older runtime", () => {
    const presentation = durableCommandRecoveryPresentation({
      state: "accepted",
      connectionStatus: "connected",
      gatewayAvailable: true,
      journalReconciliationAvailable: false,
    });

    expect(presentation.primaryAction).toBe("update-native-app");
    expect(presentation.primaryLabel).toBe("Update Android app");
    expect(presentation.detail).toContain("Update Android");
    expect(presentation.detail).toContain("cannot ask the Gateway journal");
    expect(presentation.detail).toContain("without executing it twice");
  });

  it("does not offer an ineffective check while the Gateway is offline", () => {
    const presentation = durableCommandRecoveryPresentation({
      state: "running",
      connectionStatus: "connected",
      gatewayAvailable: false,
      journalReconciliationAvailable: true,
    });

    expect(presentation.primaryAction).toBeNull();
    expect(presentation.primaryLabel).toBeUndefined();
    expect(presentation.detail).toContain("There is nothing this client can verify");
  });

  it("can still retry a locally queued identity without journal support", () => {
    const presentation = durableCommandRecoveryPresentation({
      state: "queued",
      connectionStatus: "connected",
      gatewayAvailable: true,
      journalReconciliationAvailable: false,
    });

    expect(presentation.primaryAction).toBe("check");
    expect(presentation.primaryLabel).toBe("Check now");
  });

  it("opens official releases when the installed APK cannot check immediately", () => {
    const presentation = durableCommandRecoveryPresentation({
      state: "accepted",
      connectionStatus: "connected",
      gatewayAvailable: true,
      journalReconciliationAvailable: false,
      manualAndroidUpdateRequired: true,
    });

    expect(presentation.primaryAction).toBe("open-apk-releases");
    expect(presentation.primaryLabel).toBe("Open APK releases");
  });
});
