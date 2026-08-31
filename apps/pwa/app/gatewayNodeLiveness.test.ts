import { describe, expect, it } from "vitest";
import {
  GATEWAY_PROBE_RECOVERY_MAX_BACKOFF_MS,
  gatewayProbeRecoveryBackoffMs,
} from "./gatewayNodeLiveness";

describe("Gateway status probe recovery", () => {
  it("backs repeated journal recovery away from the foreground polling cadence", () => {
    expect(gatewayProbeRecoveryBackoffMs(0)).toBe(60_000);
    expect(gatewayProbeRecoveryBackoffMs(1)).toBe(120_000);
    expect(gatewayProbeRecoveryBackoffMs(2)).toBe(240_000);
    expect(gatewayProbeRecoveryBackoffMs(3)).toBe(GATEWAY_PROBE_RECOVERY_MAX_BACKOFF_MS);
    expect(gatewayProbeRecoveryBackoffMs(20)).toBe(GATEWAY_PROBE_RECOVERY_MAX_BACKOFF_MS);
  });
});
