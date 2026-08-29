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
      primaryLabel: "Check now",
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
  });

  it("does not claim journal recovery for an older Android runtime", () => {
    const presentation = durableCommandRecoveryPresentation({
      state: "accepted",
      connectionStatus: "connected",
      gatewayAvailable: true,
      journalReconciliationAvailable: false,
    });

    expect(presentation.primaryLabel).toBe("Check Matrix again");
    expect(presentation.detail).toContain("Update the Android app");
    expect(presentation.detail).toContain("cannot ask the Gateway journal");
    expect(presentation.detail).toContain("will not run twice");
  });
});
