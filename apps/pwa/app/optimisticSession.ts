import type { NewSessionInput } from "./NewSessionDialog";

const OPTIMISTIC_SESSION_STORAGE_KEY = "malink:optimistic-session:v1";

type SessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type OptimisticSessionPhase = "creating" | "uncertain" | "failed";
export type OptimisticSessionProgress =
  | "saving"
  | "saved"
  | "transmitting"
  | "matrix_accepted"
  | "gateway_running"
  | "checking";

export type OptimisticSessionRecord = {
  version: 1;
  gatewayId: string;
  conversationId: string;
  localSessionId: string;
  remoteSessionId?: string;
  commandId?: string;
  phase: OptimisticSessionPhase;
  progress?: OptimisticSessionProgress;
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
    progress: "saving",
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
    progress: "saved",
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

export function markOptimisticSessionUncertain(
  record: OptimisticSessionRecord,
  error: string,
  now = Date.now(),
): OptimisticSessionRecord {
  return {
    ...record,
    phase: "uncertain",
    progress: "checking",
    error,
    updatedAt: now,
  };
}

export function retryOptimisticSession(
  record: OptimisticSessionRecord,
  now = Date.now(),
): OptimisticSessionRecord {
  const next = {
    ...record,
    phase: "creating" as const,
    progress: "saving" as const,
    updatedAt: now,
  };
  delete next.commandId;
  delete next.remoteSessionId;
  delete next.error;
  return next;
}

export function updateOptimisticSessionProgress(
  record: OptimisticSessionRecord,
  progress: OptimisticSessionProgress,
  now = Date.now(),
): OptimisticSessionRecord {
  if (
    record.phase !== "creating" || record.progress === progress ||
    progressRank(progress) < progressRank(record.progress)
  ) return record;
  return { ...record, progress, updatedAt: now };
}

export function optimisticSessionProgressLabel(
  progress: OptimisticSessionProgress | undefined,
): string {
  switch (progress) {
    case "saving": return "Saving the secure command locally";
    case "transmitting": return "Sending the secure command to Matrix";
    case "matrix_accepted": return "Matrix accepted the command";
    case "gateway_running": return "Gateway is creating the conversation";
    case "checking": return "Checking the original command result";
    default: return "Secure command saved; waiting for delivery";
  }
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
    !(
      record.phase === "creating" ||
      record.phase === "uncertain" ||
      record.phase === "failed"
    ) ||
    !isOptionalString(record.error) ||
    !isOptionalProgress(record.progress) ||
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

function isOptionalProgress(value: unknown): value is OptimisticSessionProgress | undefined {
  return value === undefined || value === "saving" || value === "saved" ||
    value === "transmitting" || value === "matrix_accepted" ||
    value === "gateway_running" || value === "checking";
}

function progressRank(progress: OptimisticSessionProgress | undefined): number {
  switch (progress) {
    case "saving": return 0;
    case "saved": return 1;
    case "transmitting": return 2;
    case "matrix_accepted": return 3;
    case "gateway_running": return 4;
    case "checking": return 5;
    default: return -1;
  }
}
