import { describe, expect, it } from "vitest";
import {
  GATEWAY_AUTOMATIC_PROBE_MIN_INTERVAL_MS,
  GATEWAY_ONLINE_PROOF_WINDOW_MS,
  GATEWAY_PROBE_RECOVERY_MAX_BACKOFF_MS,
  gatewayNodeNeedsForegroundProbe,
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

describe("foreground Gateway probing", () => {
  it("checks unknown or expired nodes when the app becomes visible", () => {
    expect(gatewayNodeNeedsForegroundProbe({
      value: undefined,
      now: 1_000,
      lastAutomaticProbeAt: undefined,
    })).toBe(true);
    expect(gatewayNodeNeedsForegroundProbe({
      value: { state: "online", lastVerifiedAt: 1_000 },
      now: 1_000 + GATEWAY_ONLINE_PROOF_WINDOW_MS + 1,
      lastAutomaticProbeAt: undefined,
    })).toBe(true);
  });

  it("does not duplicate a fresh, running, unavailable, or rate-limited check", () => {
    expect(gatewayNodeNeedsForegroundProbe({
      value: { state: "online", lastVerifiedAt: 1_000 },
      now: 1_000 + GATEWAY_ONLINE_PROOF_WINDOW_MS,
      lastAutomaticProbeAt: undefined,
    })).toBe(false);
    expect(gatewayNodeNeedsForegroundProbe({
      value: { state: "checking" },
      now: 10_000,
      lastAutomaticProbeAt: undefined,
    })).toBe(false);
    expect(gatewayNodeNeedsForegroundProbe({
      value: { state: "unavailable" },
      now: 10_000,
      lastAutomaticProbeAt: undefined,
    })).toBe(false);
    expect(gatewayNodeNeedsForegroundProbe({
      value: { state: "unknown" },
      now: GATEWAY_AUTOMATIC_PROBE_MIN_INTERVAL_MS - 1,
      lastAutomaticProbeAt: 0,
    })).toBe(false);
  });
});
