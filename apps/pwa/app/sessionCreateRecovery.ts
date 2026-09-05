import type { NewSessionInput } from "./NewSessionDialog";
import type { CommandCompletion } from "./commandLifecycle";
import type { OptimisticSessionRecord } from "./optimisticSession";

export const PENDING_SESSION_CREATE_STORAGE_KEY =
  "malink:pending-session-create:v1";

export const SESSION_CREATE_UNCERTAIN_AFTER_MS = 60_000;

type SessionCreateRecoveryStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

export type PendingSessionCreateRecovery = {
  version: 1;
  commandId: string;
  gatewayId: string;
  conversationId: string;
  createdAt: number;
  input: NewSessionInput;
};

export type CompletedSessionCreateTarget = {
  pendingSessionId: string | null;
  sessionToReveal: string | null;
  skipHistoryRestore: boolean;
};

/**
 * Rebuilds the durable recovery marker when an older PWA consumed or lost the
 * marker but left its bound optimistic session behind. Without this inverse
 * repair, a reload has a command ID to display but no recovery operation to
 * settle it, so the browser-only row remains in `creating` forever.
 */
export function pendingSessionCreateRecoveryFromOptimistic(
  record: OptimisticSessionRecord,
): PendingSessionCreateRecovery | null {
  if (record.phase !== "creating" || !record.commandId) return null;
  return {
    version: 1,
    commandId: record.commandId,
    gatewayId: record.gatewayId,
    conversationId: record.conversationId,
    createdAt: record.createdAt,
    input: record.input,
  };
}

/** Returns the user-facing failure for every non-success terminal outcome. */
export function sessionCreateFailureMessage(
  completion: CommandCompletion,
): string | null {
  if (completion.outcome === "succeeded") return null;
  const detail = completion.error?.message.trim();
  if (detail) return detail;
  return completion.outcome === "cancelled"
    ? "Session creation was cancelled."
    : "Your computer could not create the session.";
}

/**
 * Resolves both valid Matrix event orders for a completed session creation.
 * If the native session root is already projected, reveal it immediately and
 * leave no pending marker that could override a later manual selection. A
 * session revealed by this completion is brand new in either order, so its
 * first activation must not start an irrelevant history request.
 */
export function completedSessionCreateTarget(
  sessionId: string,
  knownSessionIds: ReadonlySet<string>,
): CompletedSessionCreateTarget {
  return knownSessionIds.has(sessionId)
    ? {
        pendingSessionId: null,
        sessionToReveal: sessionId,
        skipHistoryRestore: true,
      }
    : {
        pendingSessionId: sessionId,
        sessionToReveal: null,
        skipHistoryRestore: true,
      };
}

export function readPendingSessionCreateRecovery(
  storage: SessionCreateRecoveryStorage | null,
): PendingSessionCreateRecovery | null {
  if (!storage) return null;
  try {
    const encoded = storage.getItem(PENDING_SESSION_CREATE_STORAGE_KEY);
    if (!encoded) return null;
    return parsePendingSessionCreateRecovery(JSON.parse(encoded));
  } catch {
    return null;
  }
}

export function writePendingSessionCreateRecovery(
  storage: SessionCreateRecoveryStorage,
  recovery: PendingSessionCreateRecovery,
): void {
  storage.setItem(PENDING_SESSION_CREATE_STORAGE_KEY, JSON.stringify(recovery));
}

export function clearPendingSessionCreateRecovery(
  storage: SessionCreateRecoveryStorage,
  expectedCommandId?: string,
): boolean {
  if (expectedCommandId) {
    const current = readPendingSessionCreateRecovery(storage);
    if (current?.commandId !== expectedCommandId) return false;
  }
  storage.removeItem(PENDING_SESSION_CREATE_STORAGE_KEY);
  return true;
}

/**
 * Rebinds one persisted logical create operation after the native outbox has
 * assigned it a fresh command ID for a new Gateway revision epoch. The compare
 * against the expected ID prevents a late recovery from overwriting a newer
 * create marker.
 */
export function rebindPendingSessionCreateRecovery(
  storage: SessionCreateRecoveryStorage,
  expectedCommandId: string,
  currentCommandId: string,
): PendingSessionCreateRecovery | null {
  const recovery = readPendingSessionCreateRecovery(storage);
  if (!recovery || recovery.commandId !== expectedCommandId) return null;
  const rebound = { ...recovery, commandId: currentCommandId };
  writePendingSessionCreateRecovery(storage, rebound);
  return rebound;
}

export function sessionCreateRecoveryMatches(
  recovery: PendingSessionCreateRecovery,
  binding: { gatewayId: string; conversationId: string },
): boolean {
  return (
    recovery.gatewayId === binding.gatewayId &&
    recovery.conversationId === binding.conversationId
  );
}

/**
 * A terminal result can arrive after the bounded foreground waiter has already
 * moved the optimistic row to `uncertain`. The persisted command ID remains
 * the authority for consuming that late result; matching it here never submits
 * another command.
 */
export function sessionCreateCompletionMatchesRecovery(
  recovery: Pick<PendingSessionCreateRecovery, "commandId"> | null,
  completion: Pick<CommandCompletion, "commandId">,
): boolean {
  return recovery?.commandId === completion.commandId;
}

/**
 * A projected session root is not proof that this device received the signed
 * terminal result for its create command. Android applies the device's own
 * Matrix command optimistically so the projection can contain the final
 * session ID before the Gateway result arrives. Keep the durable create marker
 * and its pending UI until that exact command has been consumed.
 */
export function canPromoteProjectedCreatedSession(
  optimistic: Pick<OptimisticSessionRecord, "commandId">,
  recovery: Pick<PendingSessionCreateRecovery, "commandId"> | null,
): boolean {
  return !optimistic.commandId || recovery?.commandId !== optimistic.commandId;
}

export type CommandRecoveryResolution =
  | "missing"
  | "already_released"
  | "projected_state"
  | "target_removed";

/**
 * New native runtimes distinguish authoritative local cleanup from an absent
 * command. Older APKs only expose OPERATION_NOT_FOUND, which remains the
 * conservative `missing` fallback.
 */
export function commandRecoveryResolution(
  error: unknown,
): CommandRecoveryResolution | null {
  if (
    !error ||
    typeof error !== "object" ||
    !("errorCode" in error) ||
    (error as { errorCode?: unknown }).errorCode !== "OPERATION_NOT_FOUND"
  ) {
    return null;
  }
  const data = "data" in error
    ? (error as { data?: unknown }).data
    : undefined;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const details = "details" in data
      ? (data as { details?: unknown }).details
      : undefined;
    if (details && typeof details === "object" && !Array.isArray(details)) {
      const record = details as Record<string, unknown>;
      if (
        record.kind === "command_recovery_resolution" &&
        (record.resolution === "missing" ||
          record.resolution === "already_released" ||
          record.resolution === "projected_state" ||
          record.resolution === "target_removed")
      ) {
        return record.resolution;
      }
    }
  }
  return "missing";
}

export function isMissingSessionCreateRecoveryCommand(error: unknown): boolean {
  return commandRecoveryResolution(error) === "missing";
}

export function isSettledCommandRecovery(error: unknown): boolean {
  const resolution = commandRecoveryResolution(error);
  return resolution !== null && resolution !== "missing";
}

export function isSessionCreateRecoveryUncertain(
  recovery: Pick<PendingSessionCreateRecovery, "createdAt">,
  now = Date.now(),
  thresholdMs = SESSION_CREATE_UNCERTAIN_AFTER_MS,
): boolean {
  return now - recovery.createdAt >= thresholdMs;
}

/** Remaining time before foreground creation must stop blocking the UI. */
export function sessionCreateRecoveryRemainingMs(
  recovery: Pick<PendingSessionCreateRecovery, "createdAt">,
  now = Date.now(),
  thresholdMs = SESSION_CREATE_UNCERTAIN_AFTER_MS,
): number {
  return Math.max(0, recovery.createdAt + thresholdMs - now);
}

function parsePendingSessionCreateRecovery(
  value: unknown,
): PendingSessionCreateRecovery | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const input = record.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const sessionInput = input as Record<string, unknown>;
  if (
    record.version !== 1 ||
    !isNonEmptyString(record.commandId) ||
    !isNonEmptyString(record.gatewayId) ||
    !isNonEmptyString(record.conversationId) ||
    typeof record.createdAt !== "number" ||
    !Number.isFinite(record.createdAt) ||
    !isNonEmptyString(sessionInput.cwd) ||
    !isNonEmptyString(sessionInput.projectName) ||
    !(sessionInput.scope === undefined || sessionInput.scope === "project" || sessionInput.scope === "scratch") ||
    !isOptionalString(sessionInput.model) ||
    !isOptionalString(sessionInput.reasoningEffort) ||
    !isOptionalArray(sessionInput.extensions)
  ) {
    return null;
  }
  return value as PendingSessionCreateRecovery;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalArray(value: unknown): value is unknown[] | undefined {
  return value === undefined || Array.isArray(value);
}
