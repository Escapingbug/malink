import type { GatewayEnrollmentPending } from "@malink/protocol";

/**
 * Matrix snapshots are durable and may retain a request after its approval
 * window has elapsed. Expiry is part of the signed request, so the client can
 * safely stop presenting that stale projection without waiting for another
 * Gateway snapshot.
 */
export function activeGatewayEnrollmentRequests(
  requests: readonly GatewayEnrollmentPending[],
  joinedGatewayNodeIds: ReadonlySet<string>,
  now: number,
): GatewayEnrollmentPending[] {
  return requests.filter(
    (request) =>
      request.expiresAt > now && !joinedGatewayNodeIds.has(request.gatewayNodeId),
  );
}

export function nextGatewayEnrollmentExpiry(
  requests: readonly GatewayEnrollmentPending[],
  now: number,
): number | null {
  let next: number | null = null;
  for (const request of requests) {
    if (request.expiresAt <= now) continue;
    if (next === null || request.expiresAt < next) next = request.expiresAt;
  }
  return next;
}
