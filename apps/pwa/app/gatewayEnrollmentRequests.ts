import type { GatewayEnrollmentPending } from "@malink/protocol";

const DISMISSED_GATEWAY_ENROLLMENTS_KEY = "malink.gateway-enrollment-dismissals.v1";

type EnrollmentDismissalStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * Matrix snapshots are durable and may retain a request after its approval
 * window has elapsed. Expiry is part of the signed request, so the client can
 * safely stop presenting that stale projection without waiting for another
 * Gateway snapshot.
 */
export function activeGatewayEnrollmentRequests(
  requests: readonly GatewayEnrollmentPending[],
  joinedGatewayNodeIds: ReadonlySet<string>,
  dismissedEnrollmentIds: ReadonlySet<string>,
  now: number,
): GatewayEnrollmentPending[] {
  return requests.filter(
    (request) =>
      request.expiresAt > now &&
      !joinedGatewayNodeIds.has(request.gatewayNodeId) &&
      !dismissedEnrollmentIds.has(request.enrollmentId),
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

export function readGatewayEnrollmentDismissals(
  now: number,
  storage: EnrollmentDismissalStorage | undefined,
): Map<string, number> {
  if (!storage) return new Map();
  try {
    const parsed = JSON.parse(storage.getItem(DISMISSED_GATEWAY_ENROLLMENTS_KEY) ?? "null");
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) return new Map();
    return new Map(parsed.entries.flatMap((entry: unknown) => {
      if (!Array.isArray(entry) || entry.length !== 2) return [];
      const [enrollmentId, expiresAt] = entry;
      return typeof enrollmentId === "string" &&
        enrollmentId.length > 0 &&
        enrollmentId.length <= 512 &&
        Number.isSafeInteger(expiresAt) &&
        expiresAt > now
        ? [[enrollmentId, expiresAt] as const]
        : [];
    }));
  } catch {
    return new Map();
  }
}

export function writeGatewayEnrollmentDismissals(
  dismissals: ReadonlyMap<string, number>,
  storage: EnrollmentDismissalStorage | undefined,
): void {
  if (!storage) return;
  try {
    storage.setItem(DISMISSED_GATEWAY_ENROLLMENTS_KEY, JSON.stringify({
      version: 1,
      entries: [...dismissals],
    }));
  } catch {
    // Local dismissal is an availability aid. A blocked storage backend must
    // not turn cancellation into another blocking error.
  }
}

export function readBrowserGatewayEnrollmentDismissals(now: number): Map<string, number> {
  try {
    return readGatewayEnrollmentDismissals(
      now,
      typeof window === "undefined" ? undefined : window.localStorage,
    );
  } catch {
    return new Map();
  }
}

export function writeBrowserGatewayEnrollmentDismissals(
  dismissals: ReadonlyMap<string, number>,
): void {
  try {
    writeGatewayEnrollmentDismissals(
      dismissals,
      typeof window === "undefined" ? undefined : window.localStorage,
    );
  } catch {
    // Some embedded browsers expose localStorage but deny access to it.
  }
}
