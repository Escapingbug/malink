import { describe, expect, it } from "vitest";
import type { GatewayEnrollmentPending } from "@malink/protocol";
import {
  activeGatewayEnrollmentRequests,
  nextGatewayEnrollmentExpiry,
  readGatewayEnrollmentDismissals,
  writeGatewayEnrollmentDismissals,
} from "./gatewayEnrollmentRequests";

function request(
  enrollmentId: string,
  gatewayNodeId: string,
  expiresAt: number,
): GatewayEnrollmentPending {
  return {
    enrollmentId,
    gatewayNodeId,
    gatewayName: gatewayNodeId,
    verificationCode: "123-456",
    requestedAt: expiresAt - 60_000,
    expiresAt,
  };
}

describe("Gateway enrollment request visibility", () => {
  it("does not let an expired durable projection block a new enrollment", () => {
    const now = 1_800_000_000_000;
    const visible = activeGatewayEnrollmentRequests([
      request("expired", "gateway-expired", now),
      request("active", "gateway-active", now + 30_000),
    ], new Set(), new Set(), now);

    expect(visible.map((value) => value.enrollmentId)).toEqual(["active"]);
  });

  it("hides a request after the Gateway has joined", () => {
    const now = 1_800_000_000_000;
    const visible = activeGatewayEnrollmentRequests([
      request("joined", "gateway-joined", now + 30_000),
    ], new Set(["gateway-joined"]), new Set(), now);

    expect(visible).toEqual([]);
  });

  it("immediately hides a locally abandoned request", () => {
    const now = 1_800_000_000_000;
    const visible = activeGatewayEnrollmentRequests([
      request("dismissed", "gateway-pending", now + 30_000),
      request("active", "gateway-active", now + 30_000),
    ], new Set(), new Set(["dismissed"]), now);

    expect(visible.map((value) => value.enrollmentId)).toEqual(["active"]);
  });

  it("persists active dismissals and drops expired entries", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const now = 1_800_000_000_000;

    writeGatewayEnrollmentDismissals(new Map([
      ["active", now + 30_000],
      ["expired", now],
    ]), storage);

    expect([...readGatewayEnrollmentDismissals(now, storage)]).toEqual([
      ["active", now + 30_000],
    ]);
  });

  it("schedules the nearest future expiry only", () => {
    const now = 1_800_000_000_000;
    expect(nextGatewayEnrollmentExpiry([
      request("expired", "gateway-expired", now - 1),
      request("later", "gateway-later", now + 60_000),
      request("next", "gateway-next", now + 15_000),
    ], now)).toBe(now + 15_000);
  });
});
