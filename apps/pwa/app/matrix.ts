import {
  signedPairingRejectionSchema,
  type MalinkAttachment,
  type CommandPayload,
  type MatrixTransportBinding,
  type SignedPairingOffer,
  type SignedPairingRequest,
  type SignedPairingResponse,
  type SessionExtensionBinding,
  type WebPushSubscription as Mlp3WebPushSubscription,
} from "@malink/protocol";
import {
  generateDeviceKeyPair,
  verifyPairingRejection,
  verifyPairingResponse,
} from "@malink/security";
import type { MessageDeliveryMode } from "@malink/native-bridge";
import type {
  Device,
  MatrixClient,
  MatrixEvent,
  MsgType,
  Room,
} from "matrix-js-sdk";
import {
  PairingRejectedError,
  type PairingPreview,
  type PairingTransport,
  type TrustedGateway,
} from "./pairing";
import type { CommandCompletion } from "./commandLifecycle";
import type { GatewayStateSnapshot } from "./gatewayState";
import type { MessageFormat, ToolGroupPresentation } from "./presentation";
import { processMatrixEventWithDecryptionRetry } from "./matrixDecryptionRetry";
export {
  parseGatewayStateExtension,
  type GatewayCapabilities,
  type GatewayCapabilityOption,
  type GatewaySessionSummary,
  type GatewayStateSnapshot,
  type GatewayWorkspaceState,
  classifyGatewayStateEpoch,
} from "./gatewayState";

export const MATRIX_CONFIG_STORAGE_KEY = "malink.matrix.connection.v1";
export const MATRIX_CONFIG_PROFILES_STORAGE_KEY = "malink.matrix.connections.v1";

type MatrixConfigProfiles = {
  version: 1;
  activeGatewayId: string | null;
  configs: Record<string, MatrixConnectionConfig>;
};
export const MATRIX_IDENTITY_DATABASE_NAME = "malink-pwa-identity";
const DEVICE_STORE = "keys";
const DEVICE_KEY = "p256-v1";
// Retained as empty compatibility stores until the security-critical identity
// database receives an explicit adjacent schema migration.
const COMMAND_SEQUENCE_STORE = "command-sequences";
const TIMELINE_KEY_STORE = "matrix-timeline-keys";
const ENCRYPTED_SEND_TIMEOUT_MS = 20_000;
const PAIRING_RESPONSE_RECOVERY_WAIT_MS = 60_000;
const PAIRING_REQUEST_RETRY_DELAYS_MS = [2_000, 5_000, 10_000] as const;

export type MatrixConnectionConfig = {
  homeserver: string;
  userId: string;
  accessToken: string;
  matrixDeviceId: string;
  roomId: string;
  gatewayId: string;
  /** Execution node inside the shared Workspace authorization domain. */
  gatewayNodeId?: string;
  conversationId: string;
  gatewayMatrixUserId: string;
  gatewayMatrixDeviceId: string;
  gatewayMatrixEd25519: string;
  /** All project rooms concurrently managed by this Workspace Matrix session. */
  workspaceRoutes?: MatrixWorkspaceRoute[];
};

export type MatrixWorkspaceRoute = {
  projectId: string;
  gatewayNodeId: string;
  roomId: string;
  conversationId: string;
  gatewayMatrixUserId: string;
  gatewayMatrixDeviceId: string;
  gatewayMatrixEd25519: string;
};

export type DeviceIdentity = {
  keyId: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicJwk: JsonWebKey;
};

export type IncomingMalinkMessage = {
  eventId: string;
  sender: string;
  timestamp: number;
  encrypted: boolean;
  kind: "agent" | "user" | "tool" | "permission" | "notice" | "error";
  text: string;
  sessionId?: string;
  deliveryMode?: MessageDeliveryMode;
  historical?: boolean;
  operationId?: string;
  commandId?: string;
  revision?: number;
  originDeviceId?: string;
  originDeviceName?: string;
  activeDeviceCount?: number;
  requestId?: string;
  replacesEventId?: string;
  format: MessageFormat;
  toolGroup?: ToolGroupPresentation;
  attachments?: MalinkAttachment[];
  raw: Record<string, unknown>;
};

export type MatrixConnectionStatus =
  | "connecting"
  | "securing"
  | "connected"
  | "reconnecting"
  | "offline"
  | "error";

export type CollaborationState = {
  activeDeviceCount?: number;
  revision?: number;
  gatewayState?: GatewayStateSnapshot;
};

export type CommandResultState = CommandCompletion;

export type CommandSendResult = {
  eventId: string;
  commandId: string;
  sessionId?: string;
  sequence: number;
  revision: number;
  completion: Promise<CommandCompletion>;
};

export type MatrixHistoryPage = {
  messages: IncomingMalinkMessage[];
  hasMore: boolean;
};

export type MatrixHistoryRecovery = MatrixHistoryPage & {
  sessionId: string;
};

export class CommandRevisionConflictError extends Error {
  constructor(
    readonly commandId: string,
    readonly expectedRevision: number,
    readonly payload: CommandPayload,
  ) {
    super(
      "Another device updated this session. Review this action before sending it again.",
    );
    this.name = "CommandRevisionConflictError";
  }
}

/**
 * The UI may retain a command identity across a page or APK upgrade. Expose a
 * transport-neutral error code when that exact durable command no longer
 * exists so startup reconciliation can retire the old UI marker instead of
 * retrying it forever.
 */
export class CommandRecoveryNotFoundError extends Error {
  readonly errorCode = "OPERATION_NOT_FOUND";

  constructor(
    readonly commandId: string,
    message = `The durable command ${commandId} is no longer available for recovery.`,
  ) {
    super(message);
    this.name = "CommandRecoveryNotFoundError";
  }
}

export type MatrixConnection = {
  readonly ready: Promise<void>;
  readonly identity: DeviceIdentity;
  readonly matrixDeviceKeys: {
    ed25519: string;
    curve25519: string;
  };
  readonly deviceTransport: MatrixTransportBinding;
  pair(
    preview: PairingPreview,
    deviceName: string,
    signal?: AbortSignal,
  ): Promise<TrustedGateway>;
  send(payload: CommandPayload, projectId?: string): Promise<CommandSendResult>;
  updateProjectExtensions?(
    extensions: SessionExtensionBinding[],
    projectId?: string,
  ): Promise<CommandSendResult>;
  updateWebPushSubscription?(
    subscription: Mlp3WebPushSubscription | null,
  ): Promise<CommandSendResult>;
  recoverCommand(commandId: string): Promise<CommandSendResult>;
  uploadAttachment(file: File): Promise<MalinkAttachment>;
  downloadAttachment(attachment: MalinkAttachment): Promise<Blob>;
  confirmRevisionRetry(commandId: string): Promise<CommandSendResult>;
  discardRevisionConflict(commandId: string): Promise<void>;
  markHistoryLoaded(sessionId: string, eventIds: readonly string[]): void;
  loadLocalHistory(sessionId: string): Promise<MatrixHistoryPage>;
  loadHistoryPage(sessionId: string, limit?: number): Promise<MatrixHistoryPage>;
  observeCommandCompletion(
    commandId: string,
    timeoutMs: number,
  ): Promise<CommandCompletion>;
  releaseCommand(commandId: string): Promise<void>;
  stop(): void;
};

export function normalizeMatrixConfig(
  input: MatrixConnectionConfig,
): MatrixConnectionConfig {
  const homeserver = normalizeHomeserver(input.homeserver);
  const config = {
    homeserver,
    userId: input.userId.trim(),
    accessToken: input.accessToken.trim(),
    matrixDeviceId: input.matrixDeviceId.trim(),
    roomId: input.roomId.trim(),
    gatewayId: input.gatewayId.trim(),
    gatewayNodeId: input.gatewayNodeId?.trim() || input.gatewayId.trim(),
    conversationId: input.conversationId.trim() || input.roomId.trim(),
    gatewayMatrixUserId: input.gatewayMatrixUserId?.trim() ?? "",
    gatewayMatrixDeviceId: input.gatewayMatrixDeviceId?.trim() ?? "",
    gatewayMatrixEd25519: input.gatewayMatrixEd25519?.trim() ?? "",
    workspaceRoutes: normalizeWorkspaceRoutes(input.workspaceRoutes ?? []),
  };
  const requiredFields: Array<keyof MatrixConnectionConfig> = [
    "homeserver",
    "userId",
    "accessToken",
    "matrixDeviceId",
    "roomId",
    "gatewayId",
    "conversationId",
  ];
  const missing = requiredFields.find((field) => !config[field]);
  if (missing) {
    throw new Error(`${humanizeField(missing)} is required.`);
  }
  if (!config.userId.startsWith("@")) {
    throw new Error("Matrix user ID must start with @.");
  }
  if (!config.roomId.startsWith("!")) {
    throw new Error("Encrypted room ID must start with !.");
  }
  gatewayPin(config);
  return config;
}

function normalizeWorkspaceRoutes(routes: readonly MatrixWorkspaceRoute[]): MatrixWorkspaceRoute[] {
  const normalized = routes.map(route => ({
    projectId: route.projectId.trim(),
    gatewayNodeId: route.gatewayNodeId.trim(),
    roomId: route.roomId.trim(),
    conversationId: route.conversationId.trim(),
    gatewayMatrixUserId: route.gatewayMatrixUserId.trim(),
    gatewayMatrixDeviceId: route.gatewayMatrixDeviceId.trim(),
    gatewayMatrixEd25519: route.gatewayMatrixEd25519.trim(),
  }));
  for (const route of normalized) {
    if (!route.projectId || !route.gatewayNodeId || !route.roomId.startsWith("!") ||
        !route.conversationId || !route.gatewayMatrixUserId.startsWith("@") ||
        !route.gatewayMatrixDeviceId || !route.gatewayMatrixEd25519) {
      throw new Error("Workspace project route is invalid.");
    }
  }
  if (new Set(normalized.map(route => route.projectId)).size !== normalized.length ||
      new Set(normalized.map(route => route.roomId)).size !== normalized.length) {
    throw new Error("Workspace project routes must be unique by project and room.");
  }
  return normalized.sort((left, right) => left.projectId.localeCompare(right.projectId));
}

export function normalizeHomeserver(value: string): string {
  const homeserver = value.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(homeserver);
  } catch {
    throw new Error("Homeserver must be a valid http(s) URL.");
  }
  const isLocal =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
    throw new Error("Use HTTPS for remote homeservers.");
  }
  return homeserver;
}

export async function resolveMatrixSession(
  input: MatrixConnectionConfig,
): Promise<MatrixConnectionConfig> {
  // Validate the QR-provided endpoint before attaching any bearer credential.
  const homeserver = normalizeHomeserver(input.homeserver);
  const accessToken = input.accessToken.trim();
  if (!homeserver) throw new Error("Homeserver is required.");
  if (!accessToken) throw new Error("Access token is required.");

  const response = await fetch(
    `${homeserver}/_matrix/client/v3/account/whoami`,
    {
      headers: { authorization: `Bearer ${accessToken}` },
    },
  );
  if (!response.ok) {
    throw new Error("Matrix sign-in was not accepted. Check the access token.");
  }
  const session = asRecord(await response.json());
  const userId = typeof session?.user_id === "string" ? session.user_id : "";
  const matrixDeviceId =
    typeof session?.device_id === "string" ? session.device_id : "";
  if (!userId || !matrixDeviceId) {
    throw new Error("Matrix did not identify this signed-in device.");
  }
  if (input.userId.trim() && input.userId.trim() !== userId) {
    throw new Error("The access token belongs to a different Matrix account.");
  }
  return {
    ...input,
    homeserver,
    accessToken,
    userId,
    matrixDeviceId,
  };
}

export function saveMatrixConfig(config: MatrixConnectionConfig): void {
  if (typeof localStorage === "undefined") return;
  const normalized = normalizeMatrixConfig(config);
  if (normalized.gatewayId) {
    const profileId = normalized.gatewayNodeId || normalized.gatewayId;
    const profiles = readMatrixConfigProfiles();
    writeMatrixConfigProfiles({
      version: 1,
      activeGatewayId: profileId,
      configs: { ...profiles.configs, [profileId]: normalized },
    });
  }
  localStorage.setItem(
    MATRIX_CONFIG_STORAGE_KEY,
    JSON.stringify(normalized),
  );
}

export function loadMatrixConfig(gatewayId?: string): MatrixConnectionConfig | null {
  if (typeof localStorage === "undefined") return null;
  migrateLegacyMatrixConfig();
  const profiles = readMatrixConfigProfiles();
  const selectedGatewayId = gatewayId ?? profiles.activeGatewayId;
  if (selectedGatewayId && profiles.configs[selectedGatewayId]) {
    return normalizeMatrixConfig(profiles.configs[selectedGatewayId]);
  }
  if (gatewayId) return null;
  const stored = localStorage.getItem(MATRIX_CONFIG_STORAGE_KEY);
  if (!stored) return null;
  try {
    return normalizeMatrixConfig(JSON.parse(stored) as MatrixConnectionConfig);
  } catch {
    return null;
  }
}

export function selectMatrixConfigGateway(gatewayId: string): MatrixConnectionConfig {
  if (typeof localStorage === "undefined") {
    throw new Error("Gateway profiles require browser storage.");
  }
  const profiles = readMatrixConfigProfiles();
  const config = profiles.configs[gatewayId];
  if (!config) throw new Error(`Gateway ${gatewayId} has no saved Matrix connection.`);
  const normalized = normalizeMatrixConfig(config);
  writeMatrixConfigProfiles({ ...profiles, activeGatewayId: gatewayId });
  localStorage.setItem(MATRIX_CONFIG_STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

export function clearMatrixConfig(gatewayId?: string): void {
  if (typeof localStorage === "undefined") return;
  migrateLegacyMatrixConfig();
  const profiles = readMatrixConfigProfiles();
  const target = gatewayId ?? profiles.activeGatewayId;
  if (!target) {
    localStorage.removeItem(MATRIX_CONFIG_STORAGE_KEY);
    return;
  }
  const configs = { ...profiles.configs };
  delete configs[target];
  const activeGatewayId =
    profiles.activeGatewayId === target
      ? Object.keys(configs)[0] ?? null
      : profiles.activeGatewayId;
  writeMatrixConfigProfiles({ version: 1, activeGatewayId, configs });
  const active = activeGatewayId ? configs[activeGatewayId] : undefined;
  if (active) {
    localStorage.setItem(MATRIX_CONFIG_STORAGE_KEY, JSON.stringify(active));
  } else {
    localStorage.removeItem(MATRIX_CONFIG_STORAGE_KEY);
  }
}

function readMatrixConfigProfiles(): MatrixConfigProfiles {
  migrateLegacyMatrixConfig();
  const value = localStorage.getItem(MATRIX_CONFIG_PROFILES_STORAGE_KEY);
  if (!value) return { version: 1, activeGatewayId: null, configs: {} };
  try {
    const parsed = JSON.parse(value) as Partial<MatrixConfigProfiles>;
    if (parsed.version !== 1 || !parsed.configs || typeof parsed.configs !== "object") {
      throw new Error("Invalid Matrix connection registry");
    }
    return {
      version: 1,
      activeGatewayId:
        typeof parsed.activeGatewayId === "string" ? parsed.activeGatewayId : null,
      configs: parsed.configs,
    };
  } catch (error) {
    throw new Error("Saved Matrix connection profiles are invalid and require explicit repair.", {
      cause: error,
    });
  }
}

function writeMatrixConfigProfiles(profiles: MatrixConfigProfiles): void {
  localStorage.setItem(MATRIX_CONFIG_PROFILES_STORAGE_KEY, JSON.stringify(profiles));
}

function migrateLegacyMatrixConfig(): void {
  if (localStorage.getItem(MATRIX_CONFIG_PROFILES_STORAGE_KEY)) return;
  const legacy = localStorage.getItem(MATRIX_CONFIG_STORAGE_KEY);
  if (!legacy) return;
  try {
    const config = normalizeMatrixConfig(JSON.parse(legacy) as MatrixConnectionConfig);
    if (!config.gatewayId) return;
    const profileId = config.gatewayNodeId || config.gatewayId;
    writeMatrixConfigProfiles({
      version: 1,
      activeGatewayId: profileId,
      configs: { [profileId]: config },
    });
  } catch {
    // The legacy loader will continue to report an unusable record as absent.
  }
}

export async function getOrCreateDeviceIdentity(): Promise<DeviceIdentity> {
  const database = await openIdentityDatabase();
  try {
    const existing = await readIdentity(database);
    if (existing) return existing;
    const generated = await generateDeviceKeyPair();
    const identity: DeviceIdentity = {
      keyId: generated.keyId,
      privateKey: generated.privateKey,
      publicKey: generated.publicKey,
      publicJwk: generated.publicJwk,
    };
    await writeIdentity(database, identity);
    return identity;
  } finally {
    database.close();
  }
}

export function createMatrixPairingTransport(
  client: MatrixClient,
  timelineEvent: string,
  decryptedEvent: string,
  noticeType: MsgType.Notice,
  roomId: string,
  onProgress?: (detail: string) => void,
  retryDelayMs: (completedRetries: number) => number = pairingRequestRetryDelayMs,
): PairingTransport {
  return {
    async exchange(request, offer, signal) {
      const response = waitForPairingResponse(
        client,
        timelineEvent,
        decryptedEvent,
        roomId,
        request,
        offer,
        signal,
        onProgress,
      );
      const sendRequest = async (recovery: boolean) => {
        const content = {
          msgtype: noticeType,
          body: "Malink device pairing request",
          "io.malink": {
            version: 1,
            kind: "pairing_request",
            pairing_request: request,
          },
        };
        onProgress?.(
          recovery
            ? "Recovering the approved pairing response…"
            : "Sending the encrypted pairing request…",
        );
        await withMatrixTimeout(
          client.sendMessage(
            roomId,
            content,
            `malink.pair.${request.request.requestId}.${crypto.randomUUID()}`,
          ),
          ENCRYPTED_SEND_TIMEOUT_MS,
          recovery
            ? "The pairing recovery request could not be sent in time."
            : "The encrypted pairing request could not be sent in time.",
        );
        if (recovery && response.isSettled()) return;
        onProgress?.("Waiting for the Gateway to approve this device…");
      };
      try {
        await sendRequest(false);
      } catch (error) {
        response.cancel();
        throw error;
      }
      let stopped = false;
      const retryWait = { wake: null as (() => void) | null };
      const retryLoop = (async () => {
        let completedRetries = 0;
        while (!stopped && !response.isSettled()) {
          await new Promise<void>((resolve) => {
            const timer = globalThis.setTimeout(
              resolve,
              retryDelayMs(completedRetries),
            );
            retryWait.wake = () => {
              globalThis.clearTimeout(timer);
              resolve();
            };
          });
          retryWait.wake = null;
          if (stopped || response.isSettled() || signal?.aborted) return;
          try {
            // Gateway pairing is a durable transaction. Re-sending these exact
            // signed bytes cannot mint a second authorization; it asks the
            // Gateway to publish the already persisted response in a fresh
            // Matrix event when this client missed the first one.
            await sendRequest(true);
          } catch {
            if (response.isSettled() || signal?.aborted) return;
            onProgress?.(
              "The approved response has not arrived yet. Malink will keep recovering it safely…",
            );
          }
          completedRetries += 1;
        }
      })();
      try {
        return await response.promise;
      } finally {
        stopped = true;
        retryWait.wake?.();
        void retryLoop.catch(() => undefined);
      }
    },
  };
}

export function pairingRequestRetryDelayMs(completedRetries: number): number {
  if (!Number.isSafeInteger(completedRetries) || completedRetries < 0) {
    throw new RangeError("Pairing retry count must be a non-negative integer.");
  }
  return PAIRING_REQUEST_RETRY_DELAYS_MS[
    Math.min(completedRetries, PAIRING_REQUEST_RETRY_DELAYS_MS.length - 1)
  ] ?? PAIRING_REQUEST_RETRY_DELAYS_MS.at(-1)!;
}

function waitForPairingResponse(
  client: MatrixClient,
  timelineEvent: string,
  decryptedEvent: string,
  roomId: string,
  request: SignedPairingRequest,
  offer: SignedPairingOffer,
  signal?: AbortSignal,
  onProgress?: (detail: string) => void,
  progressDelayMs = 45_000,
): {
  promise: Promise<SignedPairingResponse>;
  cancel(): void;
  isSettled(): boolean;
} {
  let cancel = () => {};
  let isSettled = false;
  const promise = new Promise<SignedPairingResponse>((resolve, reject) => {
    const responseDeadline = Math.max(
      request.request.expiresAt,
      Date.now() + PAIRING_RESPONSE_RECOVERY_WAIT_MS,
    );
    const finish = (
      outcome:
        | { response: SignedPairingResponse }
        | { error: Error },
    ) => {
      if (isSettled) return;
      isSettled = true;
      globalThis.clearTimeout(progressTimer);
      globalThis.clearTimeout(expiryTimer);
      client.off(timelineEvent as never, listener as never);
      signal?.removeEventListener("abort", abort);
      if ("response" in outcome) resolve(outcome.response);
      else reject(outcome.error);
    };
    const abort = () =>
      finish({ error: new DOMException("Pairing was cancelled.", "AbortError") });
    const listener = (
      event: MatrixEvent,
      room: Room | undefined,
      toStartOfTimeline: boolean | undefined,
    ) => {
      if (toStartOfTimeline || room?.roomId !== roomId) return;
      void processMatrixEventWithDecryptionRetry(
        event,
        decryptedEvent,
        async (candidate) => {
          if (
            candidate.getType() === "m.room.encrypted" ||
            candidate.isEncrypted()
          ) {
            await client.decryptEventIfNeeded(candidate);
          }
          if (
            candidate.isDecryptionFailure() ||
            candidate.getType() !== "m.room.message"
          ) {
            return;
          }
          const content = asRecord(candidate.getContent());
          const extension = asRecord(content?.["io.malink"]);
          if (extension?.kind === "pairing_rejection") {
            const candidate = extension.pairing_rejection;
            if (!candidate) return;
            try {
              const parsed = signedPairingRejectionSchema.parse(candidate);
              if (
                parsed.rejection.offerId !== offer.offer.offerId ||
                parsed.rejection.requestId !== request.request.requestId
              ) {
                return;
              }
              const rejection = await verifyPairingRejection(
                parsed,
                offer,
                request,
              );
              finish({
                error: new PairingRejectedError(
                  rejection.message,
                  rejection.code,
                  rejection.retryable,
                ),
              });
            } catch {
              // Only the pinned Gateway application key may reject pairing.
            }
            return;
          }
          const candidateResponse = extension?.pairing_response;
          if (
            extension?.kind !== "pairing_response" ||
            !candidateResponse
          ) {
            return;
          }
          const parsed = candidateResponse as SignedPairingResponse;
          if (
            parsed.response?.offerId !== offer.offer.offerId ||
            parsed.response?.requestId !== request.request.requestId
          ) {
            return;
          }
          // The response signature, hidden challenge, exact request hash and
          // certificate are the pairing authority. Allow Matrix to relay that
          // opaque response after a Gateway transport-device restart; the
          // homeserver cannot forge it with a substituted sender/device.
          try {
            await verifyPairingResponse(parsed, offer, request);
          } catch {
            // Untrusted room members may send lookalike responses. Ignore them
            // and keep waiting for the Gateway application-key signature.
            return;
          }
          finish({ response: parsed });
        },
        (error) => finish({ error: new Error(formatError(error)) }),
        Math.max(0, responseDeadline - Date.now()),
      ).catch((error) => finish({ error: new Error(formatError(error)) }));
    };
    const progressTimer = globalThis.setTimeout(() =>
      onProgress?.(
        "The Gateway is still preparing this device. Malink will keep waiting safely…",
      ),
      progressDelayMs,
    );
    const expiryTimer = globalThis.setTimeout(
      () =>
        finish({
          error: new Error(
            "The pairing request expired before its signed response arrived. Create a new invitation and try again.",
          ),
        }),
      Math.max(0, responseDeadline - Date.now()),
    );
    cancel = () =>
      finish({ error: new DOMException("Pairing was cancelled.", "AbortError") });
    client.on(timelineEvent as never, listener as never);
    if (signal?.aborted) abort();
    else {
      signal?.addEventListener("abort", abort, { once: true });
      const room = client.getRoom(roomId);
      if (room) {
        for (const event of room.getLiveTimeline().getEvents()) {
          listener(event, room, false);
        }
      }
    }
  });
  return { promise, cancel, isSettled: () => isSettled };
}

export async function verifyAndPinGatewayDevice(
  client: MatrixClient,
  gateway: MatrixTransportBinding,
): Promise<void> {
  const cryptoApi = client.getCrypto();
  if (!cryptoApi) throw new Error("Matrix encryption is not ready.");
  // Returning devices should already be present in the persisted Rust crypto
  // store. Verify that local record first so an ordinary reconnect does not
  // add a network key query to the startup critical path.
  const localDevices = await cryptoApi.getUserDeviceInfo([gateway.userId], false);
  let device: Device | undefined = localDevices
    .get(gateway.userId)
    ?.get(gateway.deviceId);
  // A newly logged-in Gateway device can appear in /keys/query before the
  // Rust crypto store has processed the corresponding /sync device-list
  // change. Keep the client syncing briefly instead of making the user retry.
  const deadline = Date.now() + 10_000;
  while (!device && Date.now() < deadline) {
    const devices = await cryptoApi.getUserDeviceInfo([gateway.userId], true);
    device = devices.get(gateway.userId)?.get(gateway.deviceId);
    if (device) break;
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  if (!device) {
    throw new Error(
      "The signed Gateway Matrix device is not present in the trusted device list. Log in the Gateway as a new Matrix device, then pair this browser again.",
    );
  }
  if (device.getFingerprint() !== gateway.ed25519) {
    throw new Error("The Gateway device fingerprint does not match the invitation.");
  }
  await cryptoApi.setDeviceVerified(gateway.userId, gateway.deviceId, true);
}

export async function waitForOwnMatrixDeviceKeys(
  config: MatrixConnectionConfig,
  expected: { ed25519: string; curve25519: string },
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  do {
    const remaining = Math.max(1, deadline - Date.now());
    let published:
      | { ed25519: unknown; curve25519: unknown }
      | undefined;
    try {
      const response = await fetch(
        `${config.homeserver}/_matrix/client/v3/keys/query`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            device_keys: { [config.userId]: [config.matrixDeviceId] },
          }),
          signal: AbortSignal.timeout(Math.min(5_000, remaining)),
        },
      );
      if (!response.ok) {
        throw new Error(`Matrix key query failed with HTTP ${response.status}.`);
      }
      const result = asRecord(await response.json());
      const users = asRecord(result?.device_keys);
      const devices = asRecord(users?.[config.userId]);
      const device = asRecord(devices?.[config.matrixDeviceId]);
      const keys = asRecord(device?.keys);
      published = {
        ed25519: keys?.[`ed25519:${config.matrixDeviceId}`],
        curve25519: keys?.[`curve25519:${config.matrixDeviceId}`],
      };
    } catch (error) {
      lastError = error;
    }
    if (
      typeof published?.ed25519 === "string" ||
      typeof published?.curve25519 === "string"
    ) {
      if (
        published.ed25519 !== expected.ed25519 ||
        published.curve25519 !== expected.curve25519
      ) {
        throw new Error(
          "Matrix published different encryption keys for this device. Scan a new invitation to create a fresh Matrix device.",
        );
      }
      return;
    }
    if (Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
  } while (Date.now() < deadline);
  throw new Error(
    `This device did not publish its Matrix encryption keys in time.${
      lastError ? ` ${formatError(lastError)}` : ""
    }`,
  );
}

export function withMatrixTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => reject(new Error(message)), timeoutMs);
    operation.then(
      (value) => {
        globalThis.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        globalThis.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export function gatewayPin(config: MatrixConnectionConfig): {
  homeserver: string;
  roomId: string;
  userId: string;
  deviceId: string;
  ed25519: string;
} | null {
  const values = [
    config.gatewayMatrixUserId,
    config.gatewayMatrixDeviceId,
    config.gatewayMatrixEd25519,
  ];
  if (values.every((value) => !value)) return null;
  if (values.some((value) => !value)) {
    throw new Error(
      "Gateway Matrix user, device ID, and Ed25519 fingerprint must be provided together.",
    );
  }
  if (!config.gatewayMatrixUserId.startsWith("@")) {
    throw new Error("Gateway Matrix user ID must start with @.");
  }
  return {
    homeserver: config.homeserver,
    roomId: config.roomId,
    userId: config.gatewayMatrixUserId,
    deviceId: config.gatewayMatrixDeviceId,
    ed25519: config.gatewayMatrixEd25519,
  };
}

export function waitForInitialSync(
  client: MatrixClient,
  syncEvent: string,
  timeoutMs = 30_000,
): Promise<void> {
  if (client.getSyncState() === "PREPARED" || client.getSyncState() === "SYNCING") {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      client.off(syncEvent as never, listener as never);
      reject(new Error("Timed out waiting for the first Matrix sync."));
    }, timeoutMs);
    const listener = (state: string) => {
      if (state === "PREPARED" || state === "SYNCING") {
        window.clearTimeout(timeout);
        client.off(syncEvent as never, listener as never);
        resolve();
      } else if (state === "ERROR") {
        window.clearTimeout(timeout);
        client.off(syncEvent as never, listener as never);
        reject(new Error("Matrix rejected the connection or access token."));
      }
    };
    client.on(syncEvent as never, listener as never);
  });
}

function openIdentityDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(MATRIX_IDENTITY_DATABASE_NAME, 3);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DEVICE_STORE)) {
        request.result.createObjectStore(DEVICE_STORE);
      }
      if (!request.result.objectStoreNames.contains(COMMAND_SEQUENCE_STORE)) {
        request.result.createObjectStore(COMMAND_SEQUENCE_STORE);
      }
      if (!request.result.objectStoreNames.contains(TIMELINE_KEY_STORE)) {
        request.result.createObjectStore(TIMELINE_KEY_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open the device key store."));
  });
}

export async function ensureMatrixIdentityDatabase(): Promise<void> {
  const database = await openIdentityDatabase();
  try {
    for (const store of [DEVICE_STORE, COMMAND_SEQUENCE_STORE, TIMELINE_KEY_STORE]) {
      if (!database.objectStoreNames.contains(store)) {
        throw new Error(`The Matrix identity database is missing ${store}.`);
      }
    }
  } finally {
    database.close();
  }
}

function readIdentity(database: IDBDatabase): Promise<DeviceIdentity | null> {
  return new Promise((resolve, reject) => {
    const request = database
      .transaction(DEVICE_STORE, "readonly")
      .objectStore(DEVICE_STORE)
      .get(DEVICE_KEY);
    request.onsuccess = () =>
      resolve((request.result as DeviceIdentity | undefined) ?? null);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not read the device key."));
  });
}

function writeIdentity(
  database: IDBDatabase,
  identity: DeviceIdentity,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(DEVICE_STORE, "readwrite");
    transaction.objectStore(DEVICE_STORE).put(identity, DEVICE_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Could not save the device key."));
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function humanizeField(value: string): string {
  return value
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
