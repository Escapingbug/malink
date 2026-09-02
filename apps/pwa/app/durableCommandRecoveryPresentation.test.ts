import { describe, expect, it } from "vitest";
import {
  DURABLE_COMMAND_BACKGROUND_RECOVERY_MESSAGE,
  DURABLE_COMMAND_BACKGROUND_RECOVERY_MISSING_MESSAGE,
  durableCommandRecoveryNeedsAttention,
  durableCommandRecoveryPresentation,
  durableCommandRecoveryResolutionPresentation,
} from "./durableCommandRecoveryPresentation";

describe("durableCommandRecoveryPresentation", () => {
  it("stops treating an unanswered check as user attention", () => {
    expect(durableCommandRecoveryNeedsAttention()).toBe(false);
    expect(durableCommandRecoveryNeedsAttention({
      status: "failed",
      checkedAt: 1,
    })).toBe(true);
    expect(durableCommandRecoveryNeedsAttention({
      status: "no-response",
      checkedAt: 1,
    })).toBe(false);
    expect(durableCommandRecoveryNeedsAttention(undefined)).toBe(false);
  });

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

  it("moves an unanswered journal check into automatic background recovery", () => {
    const presentation = durableCommandRecoveryPresentation({
      state: "accepted",
      connectionStatus: "connected",
      gatewayAvailable: true,
      journalReconciliationAvailable: true,
      lastCheck: {
        status: "no-response",
        checkedAt: 1_788_000_000_000,
      },
    });

    expect(presentation.title).toBe("Recovery continues in the background");
    expect(presentation.primaryAction).toBeNull();
    expect(presentation.primaryLabel).toBeUndefined();
    expect(presentation.detail).toContain("No action is required");
    expect(presentation.detail).toContain("same saved command identity");
    expect(presentation.detail).toContain("cannot submit the action twice");
  });

  it("tells the user what background recovery requires and promises a result", () => {
    expect(DURABLE_COMMAND_BACKGROUND_RECOVERY_MESSAGE).toContain(
      "No action is needed now",
    );
    expect(DURABLE_COMMAND_BACKGROUND_RECOVERY_MESSAGE).toContain(
      "without running it twice",
    );
    expect(DURABLE_COMMAND_BACKGROUND_RECOVERY_MESSAGE).toContain(
      "will notify you when recovery finishes",
    );
  });

  it("gives a safe next step when the saved recovery command disappeared", () => {
    expect(DURABLE_COMMAND_BACKGROUND_RECOVERY_MISSING_MESSAGE).toContain(
      "no longer has the saved command",
    );
    expect(DURABLE_COMMAND_BACKGROUND_RECOVERY_MISSING_MESSAGE).toContain(
      "Check whether the intended action already took effect",
    );
    expect(DURABLE_COMMAND_BACKGROUND_RECOVERY_MISSING_MESSAGE).toContain(
      "before trying it again",
    );
  });

  it("reports a verified successful recovery", () => {
    const presentation = durableCommandRecoveryResolutionPresentation({
      outcome: "succeeded",
    });

    expect(presentation).toEqual({
      severity: "success",
      message:
        "Background recovery finished. Malink received and verified the Gateway's signed final result. The previous action completed successfully.",
      autoDismissMs: 8_000,
    });
  });

  it("keeps a recovered action failure visible with the Gateway detail", () => {
    const presentation = durableCommandRecoveryResolutionPresentation({
      outcome: "failed",
      error: {
        code: "provider_failed",
        message: "The provider rejected the request.",
        retryable: false,
      },
    });

    expect(presentation).toEqual({
      severity: "error",
      message:
        "Background recovery finished. Malink received and verified the Gateway's signed final result. The previous action failed: The provider rejected the request.",
      autoDismissMs: null,
    });
  });

  it("reports a verified cancellation without presenting it as a failure", () => {
    const presentation = durableCommandRecoveryResolutionPresentation({
      outcome: "cancelled",
    });

    expect(presentation).toEqual({
      severity: "info",
      message:
        "Background recovery finished. Malink received and verified the Gateway's signed final result. The previous action was cancelled.",
      autoDismissMs: 8_000,
    });
  });
});
