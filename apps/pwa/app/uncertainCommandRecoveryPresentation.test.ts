import { describe, expect, it } from "vitest";
import { uncertainCommandRecoveryPresentation } from "./uncertainCommandRecoveryPresentation";

describe("uncertainCommandRecoveryPresentation", () => {
  it("offers the Matrix prerequisite while Matrix is disconnected", () => {
    const presentation = uncertainCommandRecoveryPresentation({
      subject: "conversation",
      connectionStatus: "reconnecting",
      gatewayAvailable: false,
      journalReconciliationAvailable: true,
    });

    expect(presentation.primaryAction).toBe("reconnect");
    expect(presentation.primaryLabel).toBe("Reconnect Workspace");
    expect(presentation.detail).toContain("Matrix connection");
  });

  it("routes an old Android runtime to the prerequisite update", () => {
    const presentation = uncertainCommandRecoveryPresentation({
      subject: "conversation",
      connectionStatus: "connected",
      gatewayAvailable: true,
      journalReconciliationAvailable: false,
    });

    expect(presentation.primaryAction).toBe("update-native-app");
    expect(presentation.primaryLabel).toBe("Update Android app");
    expect(presentation.detail).toContain("cannot ask the Gateway journal");
  });

  it("does not offer a check that cannot reach an offline Gateway", () => {
    const presentation = uncertainCommandRecoveryPresentation({
      subject: "project",
      connectionStatus: "connected",
      gatewayAvailable: false,
      journalReconciliationAvailable: true,
    });

    expect(presentation.primaryAction).toBeNull();
    expect(presentation.detail).toContain("Gateway computer is offline");
  });

  it("offers a precise journal check when it can change the result", () => {
    const presentation = uncertainCommandRecoveryPresentation({
      subject: "project",
      connectionStatus: "connected",
      gatewayAvailable: true,
      journalReconciliationAvailable: true,
    });

    expect(presentation.primaryAction).toBe("check");
    expect(presentation.primaryLabel).toBe("Check Gateway journal");
  });

  it("does not retry an unsupported native update check", () => {
    const presentation = uncertainCommandRecoveryPresentation({
      subject: "conversation",
      connectionStatus: "connected",
      gatewayAvailable: true,
      journalReconciliationAvailable: false,
      manualAndroidUpdateRequired: true,
    });

    expect(presentation.primaryAction).toBe("open-apk-releases");
    expect(presentation.primaryLabel).toBe("Open APK releases");
  });
});
