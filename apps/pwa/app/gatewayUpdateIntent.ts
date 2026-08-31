export type GatewayUpdateIntent = {
  version: 1;
  workspaceId: string;
  gatewayNodeId: string;
  projectId: string;
  releaseId: string;
  buildId: string;
  requestedAt: number;
};

const STORAGE_PREFIX = "malink.gateway-update-intent.v1";
export const GATEWAY_UPDATE_INTENT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

type IntentStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function gatewayUpdateIntentStorageKey(
  workspaceId: string,
  gatewayNodeId: string,
): string {
  if (!validId(workspaceId) || !validId(gatewayNodeId)) {
    throw new Error("Gateway update intent scope is invalid.");
  }
  return `${STORAGE_PREFIX}.${encodeURIComponent(workspaceId)}.${encodeURIComponent(gatewayNodeId)}`;
}

export function readGatewayUpdateIntent(
  storage: Pick<Storage, "getItem"> | null | undefined,
  workspaceId: string,
  gatewayNodeId: string,
  now = Date.now(),
): GatewayUpdateIntent | null {
  if (!storage) return null;
  try {
    const value = JSON.parse(storage.getItem(
      gatewayUpdateIntentStorageKey(workspaceId, gatewayNodeId),
    ) ?? "null") as Partial<GatewayUpdateIntent> | null;
    if (
      !value ||
      value.version !== 1 ||
      value.workspaceId !== workspaceId ||
      value.gatewayNodeId !== gatewayNodeId ||
      !validId(value.projectId) ||
      !validId(value.releaseId) ||
      !validId(value.buildId) ||
      typeof value.requestedAt !== "number" ||
      !Number.isFinite(value.requestedAt) ||
      value.requestedAt < 0 ||
      value.requestedAt > now ||
      now - value.requestedAt > GATEWAY_UPDATE_INTENT_MAX_AGE_MS
    ) return null;
    return value as GatewayUpdateIntent;
  } catch {
    return null;
  }
}

export function writeGatewayUpdateIntent(
  storage: IntentStorage | null | undefined,
  intent: GatewayUpdateIntent,
): boolean {
  if (!storage || readGatewayUpdateIntentShape(intent) === null) return false;
  try {
    storage.setItem(
      gatewayUpdateIntentStorageKey(intent.workspaceId, intent.gatewayNodeId),
      JSON.stringify(intent),
    );
    return true;
  } catch {
    return false;
  }
}

export function clearGatewayUpdateIntent(
  storage: Pick<Storage, "removeItem"> | null | undefined,
  workspaceId: string,
  gatewayNodeId: string,
): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(gatewayUpdateIntentStorageKey(workspaceId, gatewayNodeId));
    return true;
  } catch {
    return false;
  }
}

function readGatewayUpdateIntentShape(
  value: GatewayUpdateIntent,
): GatewayUpdateIntent | null {
  return value.version === 1 &&
    validId(value.workspaceId) &&
    validId(value.gatewayNodeId) &&
    validId(value.projectId) &&
    validId(value.releaseId) &&
    validId(value.buildId) &&
    Number.isFinite(value.requestedAt) &&
    value.requestedAt >= 0
    ? value
    : null;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}
