import { describe, expect, it } from "vitest";
import {
  GATEWAY_FOREGROUND_PROBE_INTERVAL_MS,
  GATEWAY_PROBE_RECOVERY_MAX_BACKOFF_MS,
  gatewayForegroundProbeDue,
  gatewayProbeRecoveryBackoffMs,
} from "./gatewayNodeLiveness";

describe("foreground Gateway liveness probes", () => {
  const ready = {
    visible: true,
    networkOnline: true,
    matrixConnected: true,
    inFlight: false,
    now: 100_000,
  };

  it("runs immediately when a connected visible client has no proof", () => {
    expect(gatewayForegroundProbeDue(ready)).toBe(true);
  });

  it("does not run in the background or without a network", () => {
    expect(gatewayForegroundProbeDue({ ...ready, visible: false })).toBe(false);
    expect(gatewayForegroundProbeDue({ ...ready, networkOnline: false })).toBe(false);
    expect(gatewayForegroundProbeDue({ ...ready, matrixConnected: false })).toBe(false);
  });

  it("defers while another probe or recent signed activity proves liveness", () => {
    expect(gatewayForegroundProbeDue({ ...ready, inFlight: true })).toBe(false);
    expect(gatewayForegroundProbeDue({
      ...ready,
      lastVerifiedAt: ready.now - GATEWAY_FOREGROUND_PROBE_INTERVAL_MS + 1,
    })).toBe(false);
    expect(gatewayForegroundProbeDue({
      ...ready,
      lastVerifiedAt: ready.now - GATEWAY_FOREGROUND_PROBE_INTERVAL_MS,
    })).toBe(true);
  });
});

describe("Gateway status probe recovery", () => {
  it("backs repeated journal recovery away from the foreground polling cadence", () => {
    expect(gatewayProbeRecoveryBackoffMs(0)).toBe(60_000);
    expect(gatewayProbeRecoveryBackoffMs(1)).toBe(120_000);
    expect(gatewayProbeRecoveryBackoffMs(2)).toBe(240_000);
    expect(gatewayProbeRecoveryBackoffMs(3)).toBe(GATEWAY_PROBE_RECOVERY_MAX_BACKOFF_MS);
    expect(gatewayProbeRecoveryBackoffMs(20)).toBe(GATEWAY_PROBE_RECOVERY_MAX_BACKOFF_MS);
  });
});
