import type { NewSessionInput } from "./NewSessionDialog";

const OPTIMISTIC_SESSION_STORAGE_KEY = "malink:optimistic-session:v1";

type SessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type OptimisticSessionPhase = "creating" | "failed";

export type OptimisticSessionRecord = {
  version: 1;
  gatewayId: string;
  conversationId: string;
  localSessionId: string;
  remoteSessionId?: string;
  commandId?: string;
  phase: OptimisticSessionPhase;
  error?: string;
  createdAt: number;
  updatedAt: number;
  input: NewSessionInput;
};

export function createOptimisticSessionRecord(
  input: NewSessionInput,
  binding: { gatewayId: string; conversationId: string },
  localSessionId: string,
  now = Date.now(),
): OptimisticSessionRecord {
  return {
    version: 1,
    gatewayId: binding.gatewayId,
    conversationId: binding.conversationId,
    localSessionId,
    phase: "creating",
    createdAt: now,
    updatedAt: now,
    input,
  };
}

export function bindOptimisticSession(
  record: OptimisticSessionRecord,
  commandId: string,
  remoteSessionId: string,
  now = Date.now(),
): OptimisticSessionRecord {
  return {
    ...record,
    commandId,
    remoteSessionId,
    phase: "creating",
    updatedAt: now,
  };
}

export function failOptimisticSession(
  record: OptimisticSessionRecord,
  error: string,
  now = Date.now(),
): OptimisticSessionRecord {
  const next = {
    ...record,
    phase: "failed" as const,
    error,
    updatedAt: now,
  };
  delete next.commandId;
  delete next.remoteSessionId;
  return next;
}

export function retryOptimisticSession(
  record: OptimisticSessionRecord,
  now = Date.now(),
): OptimisticSessionRecord {
  const next = {
    ...record,
    phase: "creating" as const,
    updatedAt: now,
  };
  delete next.commandId;
  delete next.remoteSessionId;
  delete next.error;
  return next;
}

export function readOptimisticSession(
  storage: SessionStorage | null,
  binding?: { gatewayId: string; conversationId: string },
): OptimisticSessionRecord | null {
  if (!storage) return null;
  try {
    const encoded = storage.getItem(OPTIMISTIC_SESSION_STORAGE_KEY);
    const parsed = encoded ? parseOptimisticSession(JSON.parse(encoded)) : null;
    if (
      parsed &&
      binding &&
      (parsed.gatewayId !== binding.gatewayId ||
        parsed.conversationId !== binding.conversationId)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeOptimisticSession(
  storage: SessionStorage,
  record: OptimisticSessionRecord,
): void {
  storage.setItem(OPTIMISTIC_SESSION_STORAGE_KEY, JSON.stringify(record));
}

export function clearOptimisticSession(
  storage: SessionStorage,
  localSessionId?: string,
): boolean {
  if (localSessionId) {
    const current = readOptimisticSession(storage);
    if (!current || current.localSessionId !== localSessionId) return false;
  }
  storage.removeItem(OPTIMISTIC_SESSION_STORAGE_KEY);
  return true;
}

function parseOptimisticSession(value: unknown): OptimisticSessionRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const input = record.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const sessionInput = input as Record<string, unknown>;
  if (
    record.version !== 1 ||
    !isNonEmptyString(record.gatewayId) ||
    !isNonEmptyString(record.conversationId) ||
    !isNonEmptyString(record.localSessionId) ||
    !isOptionalString(record.remoteSessionId) ||
    !isOptionalString(record.commandId) ||
    !(record.phase === "creating" || record.phase === "failed") ||
    !isOptionalString(record.error) ||
    !isFiniteNumber(record.createdAt) ||
    !isFiniteNumber(record.updatedAt) ||
    !isNonEmptyString(sessionInput.cwd) ||
    !isNonEmptyString(sessionInput.projectName) ||
    !isNonEmptyString(sessionInput.provider) ||
    !(sessionInput.scope === undefined ||
      sessionInput.scope === "project" ||
      sessionInput.scope === "scratch")
  ) {
    return null;
  }
  return value as OptimisticSessionRecord;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
