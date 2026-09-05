import {
  attachmentSchema,
  signedWorkspaceGatewayDirectorySchema,
  gatewayEnrollmentPendingSchema,
  gatewayUpdateStatusSchema,
  type MalinkAttachment,
  type JsonValue,
  SessionExtensionBinding,
  SessionExtensionDescriptor,
  SessionExtensionSummary,
  ProviderCommand,
  type NativeClientRelease,
  type GatewayUpdateStatus,
  type ProviderControl,
  type ProviderControlValues,
  providerControlSchema,
  providerControlValuesSchema,
  sessionExtensionDescriptorSchema,
} from "@malink/protocol";

export type GatewayNodeStatusObservation = {
  version: 1;
  gatewayNodeId: string;
  observedAt: number;
  update: GatewayUpdateStatus;
};

export type GatewayCapabilityOption = {
  id: string;
  name: string;
};

export type GatewayReasoningLevel = {
  effort: string;
  description?: string;
};

export type GatewayModelCapability = GatewayCapabilityOption & {
  defaultReasoningLevel?: string;
  supportedReasoningLevels: GatewayReasoningLevel[];
};

export type GatewaySessionSummary = {
  id: string;
  title: string;
  updatedAt: number;
  /** Monotonic MLP/3 session projection version when exposed by the client. */
  stateVersion?: number;
  status: "idle" | "running" | "stopping" | "failed" | "archived";
  activityPhase?:
    | "starting"
    | "working"
    | "stopping"
    | "idle"
    | "failed";
  scope?: "project" | "scratch";
  projectId: string;
  projectName: string;
  cwd: string;
  provider: string;
  model?: string;
  reasoningEffort?: string;
  controls?: ProviderControl[];
  controlValues?: ProviderControlValues;
  activeTurnId?: string;
  extensions: SessionExtensionSummary[];
  availableCommands: ProviderCommand[];
  providerHistory?: {
    roomId: string;
    snapshotId: string;
    ordering: "reverse_append_v1";
    frontier: number;
    hasMore: boolean;
  };
};

export type GatewayInboxFile = {
  id: string;
  receivedAt: number;
  caption?: string;
  sourceLabel?: string;
  attachment: MalinkAttachment;
};

export type GatewayWorkspaceState = {
  projectId: string;
  projectName: string;
  cwd: string;
  provider: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode: string;
  controlValues?: ProviderControlValues;
  defaultExtensions?: SessionExtensionBinding[];
  extensionDefaultsRevision?: number;
  /** Capabilities advertised by the Gateway that owns this project. */
  capabilities?: GatewayCapabilities;
};

export type GatewayCapabilities = {
  models: GatewayModelCapability[];
  providers: Array<GatewayCapabilityOption & {
    models: GatewayModelCapability[];
    canListSessions: boolean;
    canInspectSessions: boolean;
    canMaterializeHistory?: boolean;
    controls?: ProviderControl[];
  }>;
  controls?: ProviderControl[];
  permissionModes: GatewayCapabilityOption[];
  canCreateSession: boolean;
  canSelectSession: boolean;
  canArchiveSession?: boolean;
  canDeleteSession?: boolean;
  sessionExtensions: SessionExtensionDescriptor[];
  webPush?: { vapidPublicKey: string };
};

export type GatewayStateSnapshot = {
  stateVersion: number;
  revision: number;
  revisionEpoch: string;
  revisionEpochGeneration: number;
  activeDeviceCount: number;
  /** Latest signed Gateway projection time. Missing only in a legacy local cache. */
  updatedAt?: number;
  currentSessionId: string | null;
  sessions: GatewaySessionSummary[];
  inboxFiles?: GatewayInboxFile[];
  workspace: GatewayWorkspaceState;
  /** All concurrently connected Workspace projects. */
  projects?: GatewayWorkspaceState[];
  capabilities: GatewayCapabilities;
  nativeClientReleases?: NativeClientRelease[];
  gatewayDirectory?: import('@malink/protocol').SignedWorkspaceGatewayDirectory;
  pendingGatewayEnrollments?: import('@malink/protocol').GatewayEnrollmentPending[];
  /** Latest shared signed semantic update observation for each Gateway node. */
  gatewayNodeStatuses?: Record<string, GatewayNodeStatusObservation>;
  gatewayUpdate?: GatewayUpdateStatus;
};

export type GatewayStateCacheBinding = {
  gatewayId: string;
  conversationId: string;
  identityKeyId: string;
  certificateId: string;
};

export type GatewayStateCacheEpoch = {
  revisionEpoch: string;
  revisionEpochGeneration: number;
  stateVersion: number;
  revision: number;
};

export function classifyGatewayStateEpoch(
  currentEpoch: string | undefined,
  currentGeneration: number | undefined,
  retiredEpochs: readonly string[],
  incomingEpoch: string,
  incomingGeneration: number,
): "current" | "new" | "retired" | "stale" | "conflict" {
  if (retiredEpochs.includes(incomingEpoch)) return "retired";
  if (currentEpoch === undefined || currentGeneration === undefined) return "new";
  if (incomingGeneration < currentGeneration) return "stale";
  if (incomingGeneration > currentGeneration) return "new";
  return incomingEpoch === currentEpoch ? "current" : "conflict";
}

/**
 * Gateway metadata versions and semantic revisions advance independently.
 * Per-session Room State can change without replacing Gateway metadata, so an
 * equal Gateway state version is not evidence of a conflicting room view.
 */
export function classifyGatewayStateProgress(
  current: Pick<GatewayStateCacheEpoch, "stateVersion" | "revision">,
  incoming: Pick<GatewayStateCacheEpoch, "stateVersion" | "revision">,
): "current" | "advance" | "stale" {
  if (
    incoming.stateVersion < current.stateVersion ||
    incoming.revision < current.revision
  ) {
    return "stale";
  }
  return incoming.stateVersion === current.stateVersion &&
    incoming.revision === current.revision
      ? "current"
      : "advance";
}

export function isIgnorableGatewayStateReplay(
  epochStatus: ReturnType<typeof classifyGatewayStateEpoch>,
  progress?: ReturnType<typeof classifyGatewayStateProgress>,
): boolean {
  return (
    epochStatus === "retired" ||
    epochStatus === "stale" ||
    (epochStatus === "current" && progress === "stale")
  );
}

export type GatewayMaintenanceSessionActivityOutcome = "idle" | "failed";

/**
 * A signed supervisor status is the durable completion boundary for the exact
 * node-scoped maintenance session. The session's best-effort turn completion
 * may arrive later (or be absent after a restart), but it must not leave the
 * UI claiming that the maintenance Agent is still working.
 *
 * Legacy workspace-scoped maintenance IDs are intentionally excluded because
 * older releases could reuse them on more than one physical Gateway.
 */
export function gatewayMaintenanceSessionActivityOutcome(
  status: GatewayUpdateStatus,
  sessionId: string,
): GatewayMaintenanceSessionActivityOutcome | null {
  if (
    !status.maintenanceSessionId ||
    status.maintenanceSessionId !== sessionId ||
    !sessionId.startsWith("gateway-update-node-")
  ) {
    return null;
  }
  switch (status.phase) {
    case "staged":
    case "waiting_for_idle":
    case "scheduled":
    case "activating":
    case "probation":
    case "committed":
    case "rolled_back":
    case "repair_required":
      return "idle";
    case "failed":
      return "failed";
    case "idle":
    case "staging":
    case "agent_required":
    case "agent_running":
    case "agent_validating":
      return null;
  }
}

export function reconcileGatewayMaintenanceSessions(
  state: GatewayStateSnapshot,
): GatewayStateSnapshot {
  const statuses = [
    ...(state.gatewayUpdate ? [state.gatewayUpdate] : []),
    ...Object.values(state.gatewayNodeStatuses ?? {}).map(observation => observation.update),
  ];
  if (statuses.length === 0) return state;
  let changed = false;
  const sessions = state.sessions.map(session => {
    if (session.status === "archived") return session;
    const status = statuses.reduce<GatewayUpdateStatus | undefined>((latest, candidate) => {
      if (gatewayMaintenanceSessionActivityOutcome(candidate, session.id) === null) {
        return latest;
      }
      return !latest || candidate.updatedAt > latest.updatedAt ? candidate : latest;
    }, undefined);
    if (!status) return session;
    const outcome = gatewayMaintenanceSessionActivityOutcome(status, session.id)!;
    const updatedAt = Math.max(session.updatedAt, status.updatedAt);
    if (
      session.status === outcome &&
      session.activityPhase === outcome &&
      session.activeTurnId === undefined &&
      session.updatedAt === updatedAt
    ) {
      return session;
    }
    changed = true;
    const settled = { ...session };
    delete settled.activeTurnId;
    return {
      ...settled,
      status: outcome,
      activityPhase: outcome,
      updatedAt,
    };
  });
  return changed ? { ...state, sessions } : state;
}

export function parseGatewayStateExtension(
  value: unknown,
): GatewayStateSnapshot | null {
  const extension = asRecord(value);
  if (extension?.kind !== "gateway_state") return null;
  if (
    extension.version !== 1 ||
    !isPositiveInteger(extension.state_version) ||
    !isNonnegativeInteger(extension.revision) ||
    typeof extension.revision_epoch !== "string" ||
    extension.revision_epoch.length === 0 ||
    !isPositiveInteger(extension.revision_epoch_generation) ||
    !isPositiveInteger(extension.active_device_count) ||
    !(
      extension.updated_at === undefined ||
      isNonnegativeInteger(extension.updated_at)
    ) ||
    !(
      extension.current_session_id === null ||
      typeof extension.current_session_id === "string"
    ) ||
    !Array.isArray(extension.sessions)
  ) {
    throw new Error("The authenticated Gateway state snapshot is malformed.");
  }

  const parsedSessions: GatewaySessionSummary[] = extension.sessions.map((value) => {
    const session = asRecord(value);
    if (
      !session ||
      typeof session.id !== "string" ||
      !session.id ||
      typeof session.title !== "string" ||
      !session.title ||
      !isNonnegativeInteger(session.updated_at) ||
      !(
        session.state_version === undefined ||
        isPositiveInteger(session.state_version)
      ) ||
      !(
        session.status === "idle" ||
        session.status === "running" ||
        session.status === "stopping" ||
        session.status === "failed"
      ) ||
      !(
        session.activity_phase === undefined ||
        session.activity_phase === "starting" ||
        session.activity_phase === "working" ||
        session.activity_phase === "stopping" ||
        session.activity_phase === "idle" ||
        session.activity_phase === "failed"
      ) ||
      !(
        session.archived === undefined ||
        typeof session.archived === "boolean"
      ) ||
      !(
        session.scope === undefined ||
        session.scope === "project" ||
        session.scope === "scratch"
      ) ||
      typeof session.provider !== "string" ||
      !session.provider ||
      !(
        session.model === undefined ||
        (typeof session.model === "string" && session.model.length > 0)
      ) ||
      !(
        session.reasoning_effort === undefined ||
        (typeof session.reasoning_effort === "string" &&
          session.reasoning_effort.length > 0)
      ) ||
      !(
        session.active_turn_id === undefined ||
        (typeof session.active_turn_id === "string" && session.active_turn_id.length > 0)
      ) ||
      typeof session.cwd !== "string" ||
      session.cwd.length === 0 ||
      !Array.isArray(session.extensions) ||
      typeof session.project_id !== "string" ||
      session.project_id.length === 0 ||
      typeof session.project_name !== "string" ||
      session.project_name.length === 0
    ) {
      throw new Error("The authenticated Gateway session summary is malformed.");
    }
    const status: GatewaySessionSummary["status"] = session.archived === true
      ? "archived"
      : session.status === "running" ||
          session.status === "stopping" ||
          session.status === "failed"
        ? session.status
        : "idle";
    const providerHistory = parseProviderHistorySummary(session.provider_history);
    return {
      id: session.id,
      title: session.title,
      updatedAt: session.updated_at,
      ...(typeof session.state_version === "number"
        ? { stateVersion: session.state_version }
        : {}),
      status,
      ...(session.scope === "scratch" || session.scope === "project"
        ? { scope: session.scope }
        : {}),
      ...(typeof session.activity_phase === "string"
        ? {
            activityPhase:
              session.activity_phase as GatewaySessionSummary["activityPhase"],
          }
        : {}),
      provider: session.provider,
      ...(typeof session.model === "string" ? { model: session.model } : {}),
      ...(typeof session.reasoning_effort === "string"
        ? { reasoningEffort: session.reasoning_effort }
        : {}),
      ...(session.controls === undefined
        ? {}
        : { controls: parseProviderControls(session.controls) }),
      ...(session.control_values === undefined
        ? {}
        : {
            controlValues: providerControlValuesSchema.parse(
              session.control_values,
            ),
          }),
      ...(typeof session.active_turn_id === "string"
        ? { activeTurnId: session.active_turn_id }
        : {}),
      projectId: session.project_id,
      projectName: session.project_name,
      cwd: session.cwd,
      extensions: parseSessionExtensionSummaries(session.extensions),
      availableCommands: parseProviderCommands(session.available_commands),
      ...(providerHistory ? { providerHistory } : {}),
    };
  });

  const workspace = parseGatewayWorkspaceState(extension.workspace);
  const projects = extension.projects === undefined
    ? undefined
    : Array.isArray(extension.projects)
      ? extension.projects.map(parseGatewayWorkspaceState)
      : (() => { throw new Error("The authenticated Gateway project list is malformed."); })();
  if (projects && new Set(projects.map(project => project.projectId)).size !== projects.length) {
    throw new Error("The authenticated Gateway project list contains duplicate IDs.");
  }
  const sessions: GatewaySessionSummary[] = parsedSessions.map((session) => {
    return {
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt,
      ...(session.stateVersion === undefined
        ? {}
        : { stateVersion: session.stateVersion }),
      status: session.status,
      ...(session.scope ? { scope: session.scope } : {}),
      ...(session.activityPhase ? { activityPhase: session.activityPhase } : {}),
      projectId: session.projectId,
      projectName: session.projectName,
      cwd: session.cwd,
      provider: session.provider,
      ...(session.model ? { model: session.model } : {}),
      ...(session.reasoningEffort
        ? { reasoningEffort: session.reasoningEffort }
        : {}),
      ...(session.controls === undefined ? {} : { controls: session.controls }),
      ...(session.controlValues === undefined
        ? {}
        : { controlValues: session.controlValues }),
      ...(session.activeTurnId ? { activeTurnId: session.activeTurnId } : {}),
      extensions: session.extensions,
      availableCommands: session.availableCommands,
    };
  });

  const capabilities = parseGatewayCapabilities(extension.capabilities);
  const inboxFiles = parseGatewayInboxFiles(extension.inbox_files);

  const currentSessionId = extension.current_session_id;
  if (
    typeof currentSessionId === "string" &&
    !sessions.some((session) => session.id === currentSessionId)
  ) {
    throw new Error(
      "The authenticated Gateway current session is missing from its session list.",
    );
  }

  return reconcileGatewayMaintenanceSessions({
    stateVersion: extension.state_version,
    revision: extension.revision,
    revisionEpoch: extension.revision_epoch,
    revisionEpochGeneration: extension.revision_epoch_generation,
    activeDeviceCount: extension.active_device_count,
    ...(typeof extension.updated_at === "number"
      ? { updatedAt: extension.updated_at }
      : {}),
    currentSessionId,
    sessions,
    ...(extension.inbox_files === undefined ? {} : { inboxFiles }),
    workspace,
    ...(projects === undefined ? {} : { projects }),
    capabilities,
    ...(extension.gateway_directory === undefined
      ? {}
      : { gatewayDirectory: signedWorkspaceGatewayDirectorySchema.parse(extension.gateway_directory) }),
    ...(extension.pending_gateway_enrollments === undefined
      ? {}
      : {
          pendingGatewayEnrollments: Array.isArray(extension.pending_gateway_enrollments)
            ? extension.pending_gateway_enrollments.map(value =>
                gatewayEnrollmentPendingSchema.parse(value))
            : (() => { throw new Error("Pending Gateway enrollments are malformed."); })(),
        }),
    ...(extension.gateway_update === undefined
      ? {}
      : { gatewayUpdate: gatewayUpdateStatusSchema.parse(extension.gateway_update) }),
    ...(extension.gateway_node_statuses === undefined
      ? {}
      : {
          gatewayNodeStatuses: parseGatewayNodeStatuses(extension.gateway_node_statuses),
        }),
  });
}

function parseGatewayNodeStatuses(input: unknown): Record<string, GatewayNodeStatusObservation> {
  const values = asRecord(input);
  if (!values) throw new Error("Gateway node statuses are malformed.");
  const parsed: Record<string, GatewayNodeStatusObservation> = {};
  for (const [gatewayNodeId, value] of Object.entries(values)) {
    const status = asRecord(value);
    if (
      status?.version !== 1 ||
      status.gatewayNodeId !== gatewayNodeId ||
      !isNonnegativeInteger(status.observedAt)
    ) {
      throw new Error("A Gateway node status is stored under the wrong node ID.");
    }
    parsed[gatewayNodeId] = {
      version: 1,
      gatewayNodeId,
      observedAt: status.observedAt,
      update: gatewayUpdateStatusSchema.parse(status.update),
    };
  }
  return parsed;
}

function parseProviderHistorySummary(
  input: unknown,
): GatewaySessionSummary["providerHistory"] {
  if (input === undefined) return undefined;
  const value = asRecord(input);
  if (
    !value
    || typeof value.room_id !== "string"
    || !value.room_id
    || typeof value.snapshot_id !== "string"
    || !value.snapshot_id
    || value.ordering !== "reverse_append_v1"
    || !isNonnegativeInteger(value.frontier)
    || typeof value.has_more !== "boolean"
  ) {
    throw new Error("The authenticated Provider History summary is malformed.");
  }
  return {
    roomId: value.room_id,
    snapshotId: value.snapshot_id,
    ordering: "reverse_append_v1",
    frontier: value.frontier,
    hasMore: value.has_more,
  };
}

function parseGatewayWorkspaceState(input: unknown): GatewayWorkspaceState {
  const workspace = asRecord(input);
  if (
    !workspace || typeof workspace.cwd !== "string" || workspace.cwd.length === 0 ||
    typeof workspace.provider !== "string" || !workspace.provider ||
    typeof workspace.permission_mode !== "string" || !workspace.permission_mode ||
    typeof workspace.project_id !== "string" || workspace.project_id.length === 0 ||
    typeof workspace.project_name !== "string" || workspace.project_name.length === 0 ||
    !(workspace.reasoning_effort === undefined ||
      (typeof workspace.reasoning_effort === "string" && workspace.reasoning_effort.length > 0)) ||
    !(workspace.model === undefined ||
      (typeof workspace.model === "string" && workspace.model.length > 0))
  ) throw new Error("The authenticated Gateway workspace state is malformed.");
  const defaultExtensions = workspace.default_extensions === undefined
    ? undefined
    : parseSessionExtensionBindings(workspace.default_extensions);
  const extensionDefaultsRevision = workspace.extension_defaults_revision === undefined
    ? undefined
    : isPositiveInteger(workspace.extension_defaults_revision)
      ? workspace.extension_defaults_revision
      : (() => { throw new Error("The authenticated Gateway extension defaults revision is malformed."); })();
  return {
    projectId: workspace.project_id,
    projectName: workspace.project_name,
    cwd: workspace.cwd,
    provider: workspace.provider,
    ...(typeof workspace.model === "string" ? { model: workspace.model } : {}),
    ...(typeof workspace.reasoning_effort === "string"
      ? { reasoningEffort: workspace.reasoning_effort }
      : {}),
    permissionMode: workspace.permission_mode,
    ...(workspace.control_values === undefined
      ? {}
      : {
          controlValues: providerControlValuesSchema.parse(
            workspace.control_values,
          ),
        }),
    ...(defaultExtensions === undefined ? {} : { defaultExtensions }),
    ...(extensionDefaultsRevision === undefined ? {} : { extensionDefaultsRevision }),
    ...(workspace.capabilities === undefined
      ? {}
      : { capabilities: parseGatewayCapabilities(workspace.capabilities) }),
  };
}

function parseProviderControls(input: unknown): ProviderControl[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 64) {
    throw new Error("The authenticated Gateway provider controls are malformed.");
  }
  const controls = input.map(control => providerControlSchema.parse(control));
  if (new Set(controls.map(control => control.id)).size !== controls.length) {
    throw new Error("The authenticated Gateway provider controls contain duplicate IDs.");
  }
  return controls;
}

export function parseGatewayCapabilities(input: unknown): GatewayCapabilities {
  const capabilities = asRecord(input);
  if (
    !capabilities ||
    !Array.isArray(capabilities.models) ||
    !Array.isArray(capabilities.permission_modes) ||
    typeof capabilities.can_create_session !== "boolean" ||
    typeof capabilities.can_select_session !== "boolean"
  ) {
    throw new Error("The authenticated Gateway capabilities are malformed.");
  }

  const parseOptions = (
    values: unknown[],
    label: string,
  ): GatewayCapabilityOption[] =>
    values.map((value) => {
      const option = asRecord(value);
      if (
        !option ||
        typeof option.id !== "string" ||
        !option.id ||
        typeof option.name !== "string" ||
        !option.name
      ) {
        throw new Error(
          `The authenticated Gateway ${label} capability is malformed.`,
        );
      }
      return { id: option.id, name: option.name };
    });
  const parseModels = (values: unknown[]): GatewayModelCapability[] =>
    values.map((value) => {
      const option = asRecord(value);
      if (
        !option ||
        typeof option.id !== "string" ||
        !option.id ||
        typeof option.name !== "string" ||
        !option.name ||
        !(
          option.default_reasoning_level === undefined ||
          (typeof option.default_reasoning_level === "string" &&
            option.default_reasoning_level.length > 0)
        ) ||
        !(
          option.supported_reasoning_levels === undefined ||
          Array.isArray(option.supported_reasoning_levels)
        )
      ) {
        throw new Error(
          "The authenticated Gateway model capability is malformed.",
        );
      }
      const levels = (option.supported_reasoning_levels ?? []).map((level) => {
        const record = asRecord(level);
        if (
          !record ||
          typeof record.effort !== "string" ||
          !record.effort ||
          !(
            record.description === undefined ||
            typeof record.description === "string"
          )
        ) {
          throw new Error(
            "The authenticated Gateway reasoning capability is malformed.",
          );
        }
        return {
          effort: record.effort,
          ...(typeof record.description === "string"
            ? { description: record.description }
            : {}),
        };
      });
      return {
        id: option.id,
        name: option.name,
        ...(typeof option.default_reasoning_level === "string"
          ? { defaultReasoningLevel: option.default_reasoning_level }
          : {}),
        supportedReasoningLevels: levels,
      };
    });
  const webPush = asRecord(capabilities.web_push);
  if (
    capabilities.web_push !== undefined
    && (
      !webPush
      || typeof webPush.vapid_public_key !== "string"
      || !/^[A-Za-z0-9_-]{87}$/u.test(webPush.vapid_public_key)
    )
  ) {
    throw new Error("The authenticated Gateway Web Push capability is malformed.");
  }

  return {
    models: parseModels(capabilities.models),
    ...(capabilities.controls === undefined
      ? {}
      : { controls: parseProviderControls(capabilities.controls) }),
    providers: Array.isArray(capabilities.providers)
      ? capabilities.providers.map(value => {
          const provider = asRecord(value);
          if (
            !provider ||
            typeof provider.id !== "string" ||
            typeof provider.name !== "string" ||
            !Array.isArray(provider.models) ||
            typeof provider.can_list_sessions !== "boolean" ||
            typeof provider.can_inspect_sessions !== "boolean"
          ) {
            throw new Error("The authenticated Gateway provider capability is malformed.");
          }
          return {
            id: provider.id,
            // Older signed snapshots expose Cursor's historical provider id as
            // its label. Preserve the stable `agent` id while fixing that
            // presentation locally, so existing Gateways do not need a
            // protocol migration before the UI can say Cursor.
            name: provider.id === "agent" && provider.name === "agent"
              ? "Cursor"
              : provider.name,
            models: parseModels(provider.models),
            canListSessions: provider.can_list_sessions,
            canInspectSessions: provider.can_inspect_sessions,
            canMaterializeHistory: provider.can_materialize_history === true,
            ...(provider.controls === undefined
              ? {}
              : { controls: parseProviderControls(provider.controls) }),
          };
        })
      : [],
    permissionModes: parseOptions(
      capabilities.permission_modes,
      "permission mode",
    ),
    canCreateSession: capabilities.can_create_session,
    canSelectSession: capabilities.can_select_session,
    ...(typeof capabilities.can_archive_session === "boolean"
      ? { canArchiveSession: capabilities.can_archive_session }
      : {}),
    ...(typeof capabilities.can_delete_session === "boolean"
      ? { canDeleteSession: capabilities.can_delete_session }
      : {}),
    sessionExtensions: parseSessionExtensionDescriptors(
      capabilities.session_extensions,
    ),
    ...(webPush
      ? { webPush: { vapidPublicKey: webPush.vapid_public_key as string } }
      : {}),
  };
}

export function gatewayProjectKey(
  gatewayId: string,
  projectId: string,
): string {
  return `${gatewayId}\u0000${projectId}`;
}

export function createGatewayStateCacheRecord(
  binding: GatewayStateCacheBinding,
  state: GatewayStateSnapshot,
): Record<string, unknown> {
  return {
    kind: "gateway_state_cache",
    version: 1,
    gateway_id: binding.gatewayId,
    conversation_id: binding.conversationId,
    identity_key_id: binding.identityKeyId,
    certificate_id: binding.certificateId,
    snapshot: gatewayStateExtension(state),
  };
}

export function parseGatewayStateCacheRecord(
  value: unknown,
  binding: GatewayStateCacheBinding,
  epoch: GatewayStateCacheEpoch,
): GatewayStateSnapshot | null {
  const record = asRecord(value);
  if (
    record?.kind !== "gateway_state_cache" ||
    record.version !== 1 ||
    record.gateway_id !== binding.gatewayId ||
    record.conversation_id !== binding.conversationId ||
    record.identity_key_id !== binding.identityKeyId ||
    record.certificate_id !== binding.certificateId
  ) {
    return null;
  }
  let state: GatewayStateSnapshot | null;
  try {
    state = parseGatewayStateExtension(record.snapshot);
  } catch {
    return null;
  }
  if (
    !state ||
    state.revisionEpoch !== epoch.revisionEpoch ||
    state.revisionEpochGeneration !== epoch.revisionEpochGeneration ||
    state.stateVersion !== epoch.stateVersion ||
    state.revision !== epoch.revision
  ) {
    return null;
  }
  return state;
}

export function gatewayStateExtension(
  state: GatewayStateSnapshot,
): Record<string, unknown> {
  return {
    kind: "gateway_state",
    version: 1,
    state_version: state.stateVersion,
    revision: state.revision,
    revision_epoch: state.revisionEpoch,
    revision_epoch_generation: state.revisionEpochGeneration,
    active_device_count: state.activeDeviceCount,
    ...(state.updatedAt === undefined ? {} : { updated_at: state.updatedAt }),
    current_session_id: state.currentSessionId,
    sessions: state.sessions.map((session) => ({
      id: session.id,
      title: session.title,
      updated_at: session.updatedAt,
      ...(session.stateVersion === undefined
        ? {}
        : { state_version: session.stateVersion }),
      status: session.status === "archived" ? "idle" : session.status,
      ...(session.activityPhase ? { activity_phase: session.activityPhase } : {}),
      ...(session.status === "archived" ? { archived: true } : {}),
      ...(session.scope ? { scope: session.scope } : {}),
      project_id: session.projectId,
      project_name: session.projectName,
      cwd: session.cwd,
      provider: session.provider,
      ...(session.model ? { model: session.model } : {}),
      ...(session.reasoningEffort
        ? { reasoning_effort: session.reasoningEffort }
        : {}),
      ...(session.activeTurnId
        ? { active_turn_id: session.activeTurnId }
        : {}),
      extensions: session.extensions.map((extension) => ({
        id: extension.id,
        name: extension.name,
        version: extension.version,
      })),
      available_commands: session.availableCommands,
      ...(session.providerHistory
        ? {
            provider_history: {
              room_id: session.providerHistory.roomId,
              snapshot_id: session.providerHistory.snapshotId,
              ordering: session.providerHistory.ordering,
              frontier: session.providerHistory.frontier,
              has_more: session.providerHistory.hasMore,
            },
          }
        : {}),
    })),
    ...(state.inboxFiles === undefined
      ? {}
      : {
          inbox_files: state.inboxFiles.map((file) => ({
            id: file.id,
            received_at: file.receivedAt,
            ...(file.caption ? { caption: file.caption } : {}),
            ...(file.sourceLabel ? { source_label: file.sourceLabel } : {}),
            attachment: file.attachment,
          })),
        }),
    workspace: gatewayWorkspaceExtension(state.workspace),
    ...(state.projects === undefined
      ? {}
      : { projects: state.projects.map(gatewayWorkspaceExtension) }),
    ...(state.gatewayDirectory === undefined
      ? {}
      : { gateway_directory: state.gatewayDirectory }),
    ...(state.pendingGatewayEnrollments === undefined
      ? {}
      : { pending_gateway_enrollments: state.pendingGatewayEnrollments }),
    ...(state.gatewayUpdate === undefined
      ? {}
      : { gateway_update: state.gatewayUpdate }),
    ...(state.gatewayNodeStatuses === undefined
      ? {}
      : { gateway_node_statuses: state.gatewayNodeStatuses }),
    capabilities: gatewayCapabilitiesExtension(state.capabilities),
  };
}

function gatewayCapabilitiesExtension(
  capabilities: GatewayCapabilities,
): Record<string, unknown> {
  return {
      models: capabilities.models.map((model) => ({
        id: model.id,
        name: model.name,
        ...(model.defaultReasoningLevel
          ? { default_reasoning_level: model.defaultReasoningLevel }
          : {}),
        supported_reasoning_levels: model.supportedReasoningLevels.map(
          (level) => ({
            effort: level.effort,
            ...(level.description ? { description: level.description } : {}),
          }),
        ),
      })),
      providers: capabilities.providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        can_list_sessions: provider.canListSessions,
        can_inspect_sessions: provider.canInspectSessions,
        ...(provider.canMaterializeHistory === undefined
          ? {}
          : { can_materialize_history: provider.canMaterializeHistory }),
        ...(provider.controls === undefined ? {} : { controls: provider.controls }),
        models: provider.models.map((model) => ({
          id: model.id,
          name: model.name,
          ...(model.defaultReasoningLevel
            ? { default_reasoning_level: model.defaultReasoningLevel }
            : {}),
          supported_reasoning_levels: model.supportedReasoningLevels.map(level => ({
            effort: level.effort,
            ...(level.description ? { description: level.description } : {}),
          })),
        })),
      })),
      permission_modes: capabilities.permissionModes.map((mode) => ({
        id: mode.id,
        name: mode.name,
      })),
      ...(capabilities.controls === undefined ? {} : { controls: capabilities.controls }),
      can_create_session: capabilities.canCreateSession,
      can_select_session: capabilities.canSelectSession,
      ...(capabilities.canArchiveSession === undefined
        ? {}
        : { can_archive_session: capabilities.canArchiveSession }),
      ...(capabilities.canDeleteSession === undefined
        ? {}
        : { can_delete_session: capabilities.canDeleteSession }),
      session_extensions: capabilities.sessionExtensions.map(
        (extension) => ({
          id: extension.id,
          name: extension.name,
          description: extension.description,
          version: extension.version,
          settings: extension.settings.map((setting) => ({
            id: setting.id,
            type: setting.type,
            label: setting.label,
            ...(setting.description
              ? { description: setting.description }
              : {}),
            ...(setting.type === "text" && setting.required
              ? { required: true }
              : {}),
            ...(setting.type === "text" && setting.placeholder
              ? { placeholder: setting.placeholder }
              : {}),
            ...(setting.defaultValue === undefined
              ? {}
              : { default_value: setting.defaultValue }),
          })),
        }),
      ),
  };
}

function gatewayWorkspaceExtension(state: GatewayWorkspaceState): Record<string, unknown> {
  return {
    project_id: state.projectId,
    project_name: state.projectName,
    cwd: state.cwd,
    provider: state.provider,
    ...(state.model ? { model: state.model } : {}),
    ...(state.reasoningEffort ? { reasoning_effort: state.reasoningEffort } : {}),
    permission_mode: state.permissionMode,
    ...(state.controlValues === undefined ? {} : { control_values: state.controlValues }),
    ...(state.defaultExtensions === undefined
      ? {}
      : { default_extensions: state.defaultExtensions }),
    ...(state.extensionDefaultsRevision === undefined
      ? {}
      : { extension_defaults_revision: state.extensionDefaultsRevision }),
    ...(state.capabilities === undefined
      ? {}
      : { capabilities: gatewayCapabilitiesExtension(state.capabilities) }),
  };
}

function parseGatewayInboxFiles(value: unknown): GatewayInboxFile[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100_000) {
    throw new Error("The authenticated Gateway file inbox is malformed.");
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    const file = asRecord(entry);
    if (
      !file ||
      typeof file.id !== "string" ||
      !file.id ||
      seen.has(file.id) ||
      !isNonnegativeInteger(file.received_at) ||
      !(file.caption === undefined || typeof file.caption === "string") ||
      !(file.source_label === undefined || (
        typeof file.source_label === "string" && file.source_label.length > 0
      ))
    ) {
      throw new Error("The authenticated Gateway file inbox is malformed.");
    }
    seen.add(file.id);
    return {
      id: file.id,
      receivedAt: file.received_at,
      ...(typeof file.caption === "string" ? { caption: file.caption } : {}),
      ...(typeof file.source_label === "string"
        ? { sourceLabel: file.source_label }
        : {}),
      attachment: attachmentSchema.parse(file.attachment),
    };
  });
}

function parseSessionExtensionSummaries(value: unknown): SessionExtensionSummary[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("The authenticated Gateway session extensions are malformed.");
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    const extension = asRecord(entry);
    if (
      !extension ||
      typeof extension.id !== "string" ||
      !extension.id ||
      typeof extension.name !== "string" ||
      !extension.name ||
      typeof extension.version !== "string" ||
      !extension.version ||
      seen.has(extension.id)
    ) {
      throw new Error("The authenticated Gateway session extension is malformed.");
    }
    seen.add(extension.id);
    return {
      id: extension.id,
      name: extension.name,
      version: extension.version,
    };
  });
}

function parseProviderCommands(value: unknown): ProviderCommand[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("The authenticated provider command list is malformed.");
  }
  return value.map(candidate => {
    const command = asRecord(candidate);
    if (
      !command ||
      typeof command.name !== "string" ||
      typeof command.description !== "string" ||
      !(command.inputHint === null || typeof command.inputHint === "string")
    ) {
      throw new Error("The authenticated provider command is malformed.");
    }
    return {
      name: command.name,
      description: command.description,
      inputHint: command.inputHint,
    };
  });
}

function parseSessionExtensionBindings(value: unknown): SessionExtensionBinding[] {
  if (!Array.isArray(value) || value.length > 8) {
    throw new Error("The authenticated Gateway extension defaults are malformed.");
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    const binding = asRecord(entry);
    if (
      !binding ||
      Object.keys(binding).some(key => key !== "id" && key !== "config") ||
      typeof binding.id !== "string" ||
      binding.id.length < 1 ||
      binding.id.length > 256 ||
      seen.has(binding.id)
    ) {
      throw new Error("The authenticated Gateway extension default is malformed.");
    }
    seen.add(binding.id);
    if (binding.config === undefined) return { id: binding.id };
    const config = asRecord(binding.config);
    if (
      !config ||
      Object.keys(config).length > 32 ||
      Object.keys(config).some(key => key.length < 1 || key.length > 128) ||
      !isJsonValue(config) ||
      JSON.stringify(config).length > 32 * 1024
    ) {
      throw new Error("The authenticated Gateway extension default config is malformed.");
    }
    return { id: binding.id, config };
  });
}

function parseSessionExtensionDescriptors(value: unknown): SessionExtensionDescriptor[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("The authenticated Gateway extension capabilities are malformed.");
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    const extension = asRecord(entry);
    if (
      !extension ||
      typeof extension.id !== "string" ||
      !extension.id ||
      typeof extension.name !== "string" ||
      !extension.name ||
      typeof extension.description !== "string" ||
      typeof extension.version !== "string" ||
      !extension.version ||
      !Array.isArray(extension.settings) ||
      seen.has(extension.id)
    ) {
      throw new Error("The authenticated Gateway extension capability is malformed.");
    }
    seen.add(extension.id);
    const settingIds = new Set<string>();
    const settings = extension.settings.map((entry) => {
      const setting = asRecord(entry);
      if (
        !setting ||
        typeof setting.id !== "string" ||
        !setting.id ||
        (setting.type !== "text" && setting.type !== "boolean") ||
        typeof setting.label !== "string" ||
        !setting.label ||
        !(setting.description === undefined || typeof setting.description === "string") ||
        settingIds.has(setting.id)
      ) {
        throw new Error("The authenticated Gateway extension setting is malformed.");
      }
      settingIds.add(setting.id);
      if (setting.type === "boolean") {
        if (!(setting.default_value === undefined || typeof setting.default_value === "boolean")) {
          throw new Error("The authenticated Gateway boolean extension setting is malformed.");
        }
        return {
          id: setting.id,
          type: "boolean" as const,
          label: setting.label,
          ...(typeof setting.description === "string"
            ? { description: setting.description }
            : {}),
          ...(typeof setting.default_value === "boolean"
            ? { defaultValue: setting.default_value }
            : {}),
        };
      }
      if (
        !(setting.required === undefined || typeof setting.required === "boolean") ||
        !(setting.placeholder === undefined || typeof setting.placeholder === "string") ||
        !(setting.default_value === undefined || typeof setting.default_value === "string")
      ) {
        throw new Error("The authenticated Gateway text extension setting is malformed.");
      }
      return {
        id: setting.id,
        type: "text" as const,
        label: setting.label,
        ...(typeof setting.description === "string"
          ? { description: setting.description }
          : {}),
        ...(typeof setting.required === "boolean"
          ? { required: setting.required }
          : {}),
        ...(typeof setting.placeholder === "string"
          ? { placeholder: setting.placeholder }
          : {}),
        ...(typeof setting.default_value === "string"
          ? { defaultValue: setting.default_value }
          : {}),
      };
    });
    return {
      id: extension.id,
      name: extension.name,
      description: extension.description,
      version: extension.version,
      settings,
      ...(extension.clientIntegration === undefined
        ? {}
        : {
            clientIntegration: sessionExtensionDescriptorSchema.parse({
              id: extension.id,
              name: extension.name,
              description: extension.description,
              version: extension.version,
              settings: [],
              clientIntegration: extension.clientIntegration,
            }).clientIntegration,
          }),
    };
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  const record = asRecord(value);
  return record !== null && Object.values(record).every(isJsonValue);
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

function isNonnegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}
