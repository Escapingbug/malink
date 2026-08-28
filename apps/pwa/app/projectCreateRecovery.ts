import type { CommandCompletion } from "./commandLifecycle";
import type { NewProjectInput } from "./NewProjectDialog";

export const OPTIMISTIC_PROJECT_CREATE_STORAGE_KEY =
  "malink:optimistic-project-create:v1";

type ProjectCreateStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

export type OptimisticProjectCreatePhase =
  | "submitting"
  | "creating"
  | "syncing"
  | "uncertain"
  | "failed";

export type OptimisticProjectCreateRecord = {
  version: 1;
  gatewayId: string;
  conversationId: string;
  localId: string;
  gatewayLabel: string;
  phase: OptimisticProjectCreatePhase;
  commandId?: string;
  projectId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  input: NewProjectInput;
};

export function createOptimisticProjectCreate(
  input: NewProjectInput,
  binding: { gatewayId: string; conversationId: string },
  gatewayLabel: string,
  localId: string,
  now = Date.now(),
): OptimisticProjectCreateRecord {
  return {
    version: 1,
    gatewayId: binding.gatewayId,
    conversationId: binding.conversationId,
    localId,
    gatewayLabel,
    phase: "submitting",
    createdAt: now,
    updatedAt: now,
    input,
  };
}

export function bindOptimisticProjectCreate(
  record: OptimisticProjectCreateRecord,
  commandId: string,
  now = Date.now(),
): OptimisticProjectCreateRecord {
  const creating = {
    ...record,
    commandId,
    phase: "creating",
    updatedAt: now,
  };
  delete creating.error;
  return creating;
}

export function rebindOptimisticProjectCreate(
  record: OptimisticProjectCreateRecord,
  expectedCommandId: string,
  commandId: string,
  now = Date.now(),
): OptimisticProjectCreateRecord | null {
  if (record.commandId !== expectedCommandId) return null;
  return bindOptimisticProjectCreate(record, commandId, now);
}

export function syncOptimisticProjectCreate(
  record: OptimisticProjectCreateRecord,
  projectId: string,
  now = Date.now(),
): OptimisticProjectCreateRecord {
  const syncing = {
    ...record,
    projectId,
    phase: "syncing",
    updatedAt: now,
  };
  delete syncing.error;
  return syncing;
}

export function markOptimisticProjectCreateUncertain(
  record: OptimisticProjectCreateRecord,
  error: string,
  now = Date.now(),
): OptimisticProjectCreateRecord {
  return {
    ...record,
    phase: "uncertain",
    error,
    updatedAt: now,
  };
}

export function failOptimisticProjectCreate(
  record: OptimisticProjectCreateRecord,
  error: string,
  now = Date.now(),
): OptimisticProjectCreateRecord {
  const failed = {
    ...record,
    phase: "failed" as const,
    error,
    updatedAt: now,
  };
  delete failed.commandId;
  delete failed.projectId;
  return failed;
}

export function retryOptimisticProjectCreate(
  record: OptimisticProjectCreateRecord,
  now = Date.now(),
): OptimisticProjectCreateRecord {
  const retrying = {
    ...record,
    phase: "submitting" as const,
    createdAt: now,
    updatedAt: now,
  };
  delete retrying.commandId;
  delete retrying.projectId;
  delete retrying.error;
  return retrying;
}

export function projectCreateFailureMessage(
  completion: CommandCompletion,
): string | null {
  if (completion.outcome === "succeeded") return null;
  const detail = completion.error?.message.trim();
  if (detail) return detail;
  return completion.outcome === "cancelled"
    ? "Project creation was cancelled."
    : "Your computer could not create the project.";
}

export function completedProjectId(
  completion: CommandCompletion,
): string | null {
  if (completion.outcome !== "succeeded") return null;
  const result = completion.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }
  const projectId = (result as Record<string, unknown>).projectId;
  return typeof projectId === "string" && projectId.trim()
    ? projectId
    : null;
}

export function optimisticProjectMatchesProjection(
  record: OptimisticProjectCreateRecord,
  projects: ReadonlyArray<{
    projectId: string;
    projectName: string;
    cwd: string;
  }>,
): boolean {
  if (record.projectId) {
    return projects.some((project) => project.projectId === record.projectId);
  }
  if (record.phase !== "syncing") return false;
  const cwd = normalizeCwd(record.input.cwd);
  return projects.some((project) =>
    normalizeCwd(project.cwd) === cwd &&
    project.projectName.trim() === record.input.name.trim(),
  );
}

export function projectCreateRecoveryMatches(
  record: OptimisticProjectCreateRecord,
  binding: { gatewayId: string; conversationId: string },
): boolean {
  return record.gatewayId === binding.gatewayId &&
    record.conversationId === binding.conversationId;
}

export function readOptimisticProjectCreate(
  storage: ProjectCreateStorage | null,
  binding?: { gatewayId: string; conversationId: string },
): OptimisticProjectCreateRecord | null {
  if (!storage) return null;
  try {
    const encoded = storage.getItem(OPTIMISTIC_PROJECT_CREATE_STORAGE_KEY);
    const parsed = encoded
      ? parseOptimisticProjectCreate(JSON.parse(encoded))
      : null;
    if (
      parsed &&
      binding &&
      !projectCreateRecoveryMatches(parsed, binding)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeOptimisticProjectCreate(
  storage: ProjectCreateStorage,
  record: OptimisticProjectCreateRecord,
): void {
  storage.setItem(
    OPTIMISTIC_PROJECT_CREATE_STORAGE_KEY,
    JSON.stringify(record),
  );
}

export function clearOptimisticProjectCreate(
  storage: ProjectCreateStorage,
  expectedLocalId?: string,
): boolean {
  if (expectedLocalId) {
    const current = readOptimisticProjectCreate(storage);
    if (current?.localId !== expectedLocalId) return false;
  }
  storage.removeItem(OPTIMISTIC_PROJECT_CREATE_STORAGE_KEY);
  return true;
}

function parseOptimisticProjectCreate(
  value: unknown,
): OptimisticProjectCreateRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const input = record.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const projectInput = input as Record<string, unknown>;
  if (
    record.version !== 1 ||
    !isNonEmptyString(record.gatewayId) ||
    !isNonEmptyString(record.conversationId) ||
    !isNonEmptyString(record.localId) ||
    !isNonEmptyString(record.gatewayLabel) ||
    !isPhase(record.phase) ||
    !isOptionalString(record.commandId) ||
    !isOptionalString(record.projectId) ||
    !isOptionalString(record.error) ||
    !isFiniteTimestamp(record.createdAt) ||
    !isFiniteTimestamp(record.updatedAt) ||
    !isNonEmptyString(projectInput.gatewayNodeId) ||
    !isNonEmptyString(projectInput.targetProjectId) ||
    !isNonEmptyString(projectInput.name) ||
    !isNonEmptyString(projectInput.cwd) ||
    !isOptionalString(projectInput.provider) ||
    typeof projectInput.createDirectory !== "boolean" ||
    ((record.phase === "creating" || record.phase === "uncertain") &&
      !isNonEmptyString(record.commandId)) ||
    (record.phase === "syncing" && !isNonEmptyString(record.projectId))
  ) {
    return null;
  }
  return value as OptimisticProjectCreateRecord;
}

function normalizeCwd(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  if (normalized === "/" || /^[A-Za-z]:\/$/u.test(normalized)) return normalized;
  return normalized.replace(/\/+$/u, "");
}

function isPhase(value: unknown): value is OptimisticProjectCreatePhase {
  return value === "submitting" ||
    value === "creating" ||
    value === "syncing" ||
    value === "uncertain" ||
    value === "failed";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
