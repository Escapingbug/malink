import type { MatrixWorkspaceRoute } from "./matrix";

export type ProjectRecoveryStage = "queued" | "join_room" | "check_encryption" | "fetch_grant" | "validate_grant" | "open_store" | "accept_grant" | "workspace_snapshot" | "project_snapshot" | "provider_catalog" | "timeline" | "retry_commands" | "thread_directory" | "checkpoint" | "ready" | "removed";
export type ProjectSendFailure = "connection_changed" | "unauthorized" | "transport_timeout";
type Route = Pick<MatrixWorkspaceRoute, "projectId" | "gatewayNodeId" | "roomId">;
type Failure = { attempt: number; at: number; stage: ProjectRecoveryStage; code: string; httpStatus?: number };
type RecordState = Route & { previousRoomId?: string; transportRoomId: string | null; stage: ProjectRecoveryStage; stageSince: number; attempts: number; attemptStartedAt?: number; lastFailure?: Failure; nextRetryAt?: number };
const connections: ProjectRecoveryDiagnostics[] = [];
let sequence = 0;
const id = (value: string) => value.slice(0, 512);

/** Only allow known error codes. Never export error messages, stacks or responses. */
function errorCode(error: unknown): { code: string; httpStatus?: number } {
  const value = error && typeof error === "object" ? error as { errcode?: unknown; httpStatus?: unknown; name?: unknown } : {};
  const allowed = ["M_FORBIDDEN", "M_NOT_FOUND", "M_UNKNOWN_TOKEN", "M_MISSING_TOKEN", "M_LIMIT_EXCEEDED", "M_UNAVAILABLE", "M_UNKNOWN", "project_not_authorized", "room_missing", "room_not_encrypted", "pointer_binding_mismatch"];
  return {
    code: typeof value.errcode === "string" && allowed.includes(value.errcode) ? value.errcode
      : value.name === "AbortError" ? "aborted" : value.name === "TimeoutError" ? "timeout" : "unclassified_error",
    ...(typeof value.httpStatus === "number" && Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599 ? { httpStatus: value.httpStatus } : {}),
  };
}

export class ProjectRecoveryDiagnostics {
  readonly connectionId = ++sequence;
  private readonly routes = new Map<string, RecordState>();
  private readonly sendFailures: object[] = [];
  private directoryRevision: number | null = null;
  private stoppedAt: number | null = null;
  constructor(private readonly now: () => number = Date.now) {
    connections.push(this);
    if (connections.length > 3) connections.shift();
  }
  directory(routes: Route[], revision?: number): void {
    this.directoryRevision = Number.isSafeInteger(revision) ? revision! : null;
    const desired = new Set(routes.map(route => route.projectId));
    for (const row of this.routes.values()) if (!desired.has(row.projectId)) this.stage(row.projectId, "removed");
    for (const route of routes) {
      const old = this.routes.get(route.projectId);
      if (old?.roomId === route.roomId && old.gatewayNodeId === route.gatewayNodeId && old.stage !== "removed") continue;
      this.routes.set(route.projectId, {
        projectId: id(route.projectId), gatewayNodeId: id(route.gatewayNodeId), roomId: id(route.roomId),
        previousRoomId: old?.roomId, transportRoomId: old?.transportRoomId ?? null,
        stage: "queued", stageSince: this.now(), attempts: old?.attempts ?? 0,
        lastFailure: old?.lastFailure,
      });
    }
    while (this.routes.size > 256) this.routes.delete(this.routes.keys().next().value!);
  }
  begin(projectId: string): void {
    const row = this.routes.get(projectId);
    if (row) { row.attempts++; row.attemptStartedAt = this.now(); delete row.nextRetryAt; }
  }
  stage(projectId: string, stage: ProjectRecoveryStage): void {
    const row = this.routes.get(projectId);
    if (row && row.stage !== stage) { row.stage = stage; row.stageSince = this.now(); }
    if (row && stage === "ready") delete row.nextRetryAt;
  }
  transport(projectId: string, roomId: string | null): void {
    const row = this.routes.get(projectId);
    if (row) row.transportRoomId = roomId === null ? null : id(roomId);
  }
  fail(projectId: string, error: unknown): void {
    const row = this.routes.get(projectId);
    if (row) row.lastFailure = { attempt: row.attempts, at: this.now(), stage: row.stage, ...errorCode(error) };
  }
  failIfUnrecorded(projectId: string, error: unknown): void {
    const row = this.routes.get(projectId);
    if (row && row.lastFailure?.attempt !== row.attempts) this.fail(projectId, error);
  }
  retry(delayMs: number): void {
    for (const row of this.routes.values()) {
      if (row.stage !== "ready" && row.stage !== "removed") row.nextRetryAt = this.now() + delayMs;
    }
  }
  sendFailed(reason: ProjectSendFailure, projectId: string | undefined, sessionId: string | undefined, startedAt: number): void {
    const row = projectId ? this.routes.get(projectId) : undefined;
    this.sendFailures.push({
      at: this.now(), reason, projectId: projectId ? id(projectId) : null,
      sessionId: sessionId ? id(sessionId) : null, waitedMs: Math.max(0, this.now() - startedAt),
      directoryRevision: this.directoryRevision,
      // Freeze the exact recovery state at failure; later success cannot erase it.
      project: row ? structuredClone(row) : null,
    });
    if (this.sendFailures.length > 20) this.sendFailures.shift();
  }
  stop(): void { this.stoppedAt = this.now(); }
  snapshot() {
    return structuredClone({ connectionId: this.connectionId, stoppedAt: this.stoppedAt,
      directoryRevision: this.directoryRevision,
      projects: [...this.routes.values()].map(row => ({ ...row, stageElapsedMs: Math.max(0, (this.stoppedAt ?? this.now()) - row.stageSince) })),
      sendFailures: this.sendFailures,
    });
  }
}
export function readProjectRecoveryDiagnostics() { return connections.map(connection => connection.snapshot()); }
