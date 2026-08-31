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
      orphanCommandRetirementAvailable: true,
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

  it("routes a journal check with no response to available Gateway updates", () => {
    const presentation = durableCommandRecoveryPresentation({
      state: "accepted",
      connectionStatus: "connected",
      gatewayAvailable: true,
      journalReconciliationAvailable: true,
      gatewayUpdateAvailableCount: 2,
      lastCheck: {
        status: "no-response",
        checkedAt: 1_788_000_000_000,
      },
    });

    expect(presentation.primaryAction).toBe("review-gateway-updates");
    expect(presentation.primaryLabel).toBe("Open Gateway software");
    expect(presentation.detail).toContain("2 Gateways have a software update");
    expect(presentation.detail).toContain("different, unavailable Gateway");
    expect(presentation.detail).toContain("will not clear it");
    expect(presentation.detail).toContain("hide this notice");
  });

  it("opens Gateway software instead of another no-op check when no update is known", () => {
    const presentation = durableCommandRecoveryPresentation({
      state: "running",
      connectionStatus: "connected",
      gatewayAvailable: true,
      journalReconciliationAvailable: true,
      orphanCommandRetirementAvailable: true,
      gatewayUpdateAvailableCount: 0,
      lastCheck: {
        status: "no-response",
        checkedAt: 1_788_000_000_000,
      },
    });

    expect(presentation.primaryAction).toBe("review-gateway-updates");
    expect(presentation.primaryLabel).toBe("Review Gateway software");
    expect(presentation.detail).toContain("may be offline");
    expect(presentation.detail).toContain("Stop tracking");
    expect(presentation.detail).toContain("cannot be submitted twice");
  });

  it("offers an Android update when the old APK cannot retire an orphaned action", () => {
    const presentation = durableCommandRecoveryPresentation({
      state: "accepted",
      connectionStatus: "connected",
      gatewayAvailable: true,
      journalReconciliationAvailable: true,
      orphanCommandRetirementAvailable: false,
      gatewayUpdateAvailableCount: 0,
      lastCheck: {
        status: "no-response",
        checkedAt: 1_788_000_000_000,
      },
    });

    expect(presentation.primaryAction).toBe("update-native-app");
    expect(presentation.primaryLabel).toBe("Update Android app");
    expect(presentation.detail).toContain("cannot safely stop tracking");
    expect(presentation.detail).toContain("does not submit the action again");
  });
});
