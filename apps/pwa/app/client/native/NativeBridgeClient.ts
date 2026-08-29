import {
  BridgeProtocolError,
  NATIVE_BRIDGE_LIMITS,
  parseClientMessage,
  parseCommandView,
  parsePublicTrustState,
  type BridgeMethodParams,
  type ClientBootstrapResult,
  type ClientEvent,
  type ClientSnapshot,
  type CommandReceipt,
  type CommandView,
  type HelloResult,
  type JsonObject,
  type MessageDeliveryMode,
  type NativeUpdateStatus,
  type PublicMatrixSession,
} from "@malink/native-bridge";
import type { MalinkAttachment, CommandPayload } from "@malink/protocol";
import {
  CommandCompletionExpiredError,
  CommandCompletionTimeoutError,
  type CommandCompletion,
} from "../../commandLifecycle";
import { parseGatewayStateExtension } from "../../gatewayState";
import { parseToolGroupPresentation } from "../../presentation";
import {
  MatrixRateLimitError,
  type MatrixLoginTokenResult,
} from "../../matrixAuth";
import type {
  MalinkClient,
  MalinkClientHandlers,
  MalinkCommandReview,
  MalinkCommandSendResult,
  MalinkHistoryPage,
  MalinkPublicTrust,
} from "../MalinkClient";
import { CommandReviewRequiredError } from "../MalinkClient";
import { NativeRpcBridge } from "./NativeRpcBridge";
import { NATIVE_CURSOR_STORAGE_PREFIX } from "./storageKeys";

export const REQUIRED_NATIVE_CAPABILITIES = [
  "client.lifecycle",
  "events.replay",
  "state.snapshot",
  "commands.durable",
  "history.page",
  "attachments.chunked",
  "pairing.native",
  "trust.native",
  "matrix.session-bootstrap",
  "background.foreground-service",
] as const;

export const OPTIONAL_NATIVE_CAPABILITIES = [
  "matrix.login-token",
  "client.update",
  "client.pwa-source",
] as const;

export function nativeCapabilityVersions(
  name: (typeof REQUIRED_NATIVE_CAPABILITIES)[number] |
    (typeof OPTIONAL_NATIVE_CAPABILITIES)[number],
): number[] {
  // history.page v2 separates local projection reads from explicit Matrix
  // pagination. commands.durable v2 adds project settings and provider-history
  // operations; v3 adds explicit project routing for simultaneous multi-Gateway
  // management; v4 adds atomic project metadata/default updates and deletion.
  // Request older versions as negotiation fallbacks only so an old
  // APK can return an actionable update requirement instead of failing hello.
  if (name === "commands.durable") return [4, 3, 2, 1];
  if (name === "history.page") return [2, 1];
  if (name === "matrix.session-bootstrap") return [2, 1];
  return [1];
}

export const LEGACY_NATIVE_MANUAL_CHECK_UNAVAILABLE =
  "manual_check_unavailable";
const NATIVE_CATCHUP_PRESENTATION_LIMIT_PER_SESSION = 30;
const NATIVE_CATCHUP_SETTLE_MS = 500;

/**
 * `malink.update.check` is an additive client.update v1 operation. APKs
 * released before that operation return METHOD_NOT_FOUND; the online PWA must
 * keep their status/install path usable instead of turning the additive
 * method into a new minimum capability version.
 */
export async function checkNativeUpdateWithCompatibility(
  bridge: NativeRpcBridge,
): Promise<NativeUpdateStatus> {
  try {
    return await bridge.request("malink.update.check", {
      context: bridge.context(),
      idempotencyKey: crypto.randomUUID(),
    });
  } catch (error) {
    if (
      !(error instanceof BridgeProtocolError) ||
      (error.errorCode !== "METHOD_NOT_FOUND" &&
        error.errorCode !== "CAPABILITY_UNAVAILABLE")
    ) {
      throw error;
    }
    const status = await bridge.request("malink.update.status", {
      context: bridge.context(),
    });
    if (
      status.phase === "available" ||
      status.phase === "downloading" ||
      status.phase === "ready" ||
      status.phase === "installing" ||
      status.phase === "permission_required"
    ) {
      return status;
    }
    return {
      ...status,
      phase: "failed",
      detailCode: LEGACY_NATIVE_MANUAL_CHECK_UNAVAILABLE,
    };
  }
}

export function hasCurrentNativeCapability(
  hello: HelloResult,
  name: (typeof REQUIRED_NATIVE_CAPABILITIES)[number],
): boolean {
  if (name === "matrix.session-bootstrap") {
    // v2 adds origin-independent session discovery. v1 remains sufficient for
    // an already configured Web origin during a staged PWA/APK rollout.
    const version = hello.capabilities[name]?.version;
    return version === 1 || version === 2;
  }
  return hello.capabilities[name]?.version ===
    (name === "commands.durable"
      ? 4
      : name === "history.page"
        ? 2
        : 1);
}

const DEFAULT_COMMAND_TIMEOUT_MS = 24 * 60 * 60_000;
const DEFAULT_BLOCKED_COMMAND_RETRY_WINDOW_MS = 2 * 60_000;

type CompletionWaiter = {
  resolve(value: CommandCompletion): void;
  reject(error: Error): void;
};

type BlockingCommand = MalinkCommandReview & {
  state: "queued" | "transmitting" | "recovery_required" | "needs_review";
};

export type NativeBootstrapInput = Omit<
  BridgeMethodParams["malink.client.bootstrap"],
  "context" | "idempotencyKey"
>;

export type NativeCursorStore = {
  load(deviceId: string): string | undefined;
  save(deviceId: string, cursor: string): void;
};

const defaultCursorStore: NativeCursorStore = {
  load(deviceId) {
    if (typeof localStorage === "undefined") return undefined;
    return localStorage.getItem(`${NATIVE_CURSOR_STORAGE_PREFIX}.${deviceId}`) ?? undefined;
  },
  save(deviceId, cursor) {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(`${NATIVE_CURSOR_STORAGE_PREFIX}.${deviceId}`, cursor);
  },
};

export class NativeBridgeClient implements MalinkClient {
  readonly runtime = "native" as const;
  readonly ready: Promise<void>;
  #deviceId = "";
  #deviceName = "Malink native device";
  #subscriptionId: string | null = null;
  #disposed = false;
  #detachEventListener: (() => void) | null = null;
  #eventChain: Promise<void> = Promise.resolve();
  readonly #historyBefore = new Map<string, string>();
  readonly #commandOperations = new Map<string, string>();
  readonly #reviewCommands = new Map<string, string>();
  readonly #completions = new Map<string, CommandCompletion>();
  readonly #completionWaiters = new Map<string, Set<CompletionWaiter>>();
  readonly #loadedHistoryEventIds = new Map<string, Set<string>>();
  #networkCatchupActive = false;
  #networkCatchupConnected = false;
  #networkCatchupSettleTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #networkCatchupBySession = new Map<
    string,
    MalinkHistoryPage["messages"]
  >();
  readonly #networkCatchupUnscoped: MalinkHistoryPage["messages"] = [];

  constructor(
    private readonly bridge: NativeRpcBridge,
    private readonly helloResult: HelloResult,
    private readonly handlers: MalinkClientHandlers,
    private readonly cursorStore: NativeCursorStore = defaultCursorStore,
  ) {
    assertFullNativeCapabilities(helloResult);
    this.ready = this.#initialize().catch((error) => {
      this.#discardNetworkCatchup();
      this.#detachEventListener?.();
      this.#detachEventListener = null;
      this.bridge.close();
      throw error;
    });
  }

  get deviceId(): string {
    return this.#deviceId;
  }

  get deviceName(): string {
    return this.#deviceName;
  }

  async nativeUpdateStatus(): Promise<NativeUpdateStatus> {
    this.#requireNativeUpdateCapability();
    return this.bridge.request("malink.update.status", {
      context: this.bridge.context(),
    });
  }

  async checkNativeUpdate(): Promise<NativeUpdateStatus> {
    this.#requireNativeUpdateCapability();
    return checkNativeUpdateWithCompatibility(this.bridge);
  }

  async installNativeUpdate(): Promise<NativeUpdateStatus> {
    this.#requireNativeUpdateCapability();
    return this.bridge.request("malink.update.install", {
      context: this.bridge.context(),
      idempotencyKey: crypto.randomUUID(),
    });
  }

  #requireNativeUpdateCapability(): void {
    if ((this.helloResult.capabilities["client.update"]?.version ?? 0) < 1) {
      throw new BridgeProtocolError(
        "CAPABILITY_UNAVAILABLE",
        "This APK does not support direct native updates.",
        { userAction: "update_native" },
      );
    }
  }

  async pair(
    pairingLink: string,
    deviceName: string,
    signal?: AbortSignal,
  ): Promise<MalinkPublicTrust> {
    await this.ready;
    throwIfAborted(signal);
    const preview = await this.bridge.request("malink.pairing.inspect", {
      context: this.bridge.context(),
      link: pairingLink,
    });
    throwIfAborted(signal);
    const completion = this.bridge.request("malink.pairing.complete", {
      context: this.bridge.context(),
      idempotencyKey: crypto.randomUUID(),
      pairingId: preview.pairingId,
      deviceName,
    });
    const result = await withPairingAbort(
      completion,
      signal,
    );
    this.#applySnapshot(result.snapshot);
    this.#deviceName = deviceName;
    return result.trust;
  }

  async send(payload: CommandPayload, projectId?: string): Promise<MalinkCommandSendResult> {
    await this.ready;
    const idempotencyKey = crypto.randomUUID();
    const receipt = await this.#sendWhenOutboxAvailable(payload, idempotencyKey, projectId);
    return this.#sendResult(receipt, payload.operation === "session.create");
  }

  async requestMatrixLoginToken(
    invitationId: string,
    password?: string,
  ): Promise<MatrixLoginTokenResult> {
    await this.ready;
    if (this.helloResult.capabilities["matrix.login-token"]?.version !== 1) {
      throw new BridgeProtocolError(
        "CAPABILITY_UNAVAILABLE",
        "The installed native app cannot create another-device Matrix sign-ins. Update the native app and retry.",
        { userAction: "update_native" },
      );
    }
    try {
      return await this.bridge.request(
        "malink.matrix.loginToken",
        {
          context: this.bridge.context(),
          idempotencyKey: crypto.randomUUID(),
          invitationId,
          ...(password === undefined ? {} : { password }),
        },
        45_000,
      );
    } catch (error) {
      if (error instanceof BridgeProtocolError && error.errorCode === "RATE_LIMITED") {
        throw new MatrixRateLimitError(error.data.retryAfterMs ?? 60_000);
      }
      throw error;
    }
  }

  async recoverCommand(commandId: string): Promise<MalinkCommandSendResult> {
    await this.ready;
    const receipt = await this.bridge.request("malink.command.recover", {
      context: this.bridge.context(),
      idempotencyKey: crypto.randomUUID(),
      commandId,
    });
    // A terminal command may have completed while the WebView was stopped or
    // while an APK update replaced it. Its command.changed notification is not
    // replayed forever, so the recovery receipt alone is insufficient: a
    // receipt intentionally omits the persisted completion payload. Hydrate
    // the current durable view before installing a new completion waiter.
    //
    // A legacy outbox may retain a retired command-id alias. The receipt names
    // the stable current identity that owns any terminal event.
    if (receipt.commandId) {
      const current = await this.bridge.request("malink.command.get", {
        context: this.bridge.context(),
        commandId: receipt.commandId,
      });
      this.#recordCommand(current);
    }
    return this.#sendResult(receipt);
  }

  async confirmRevisionRetry(commandId: string): Promise<MalinkCommandSendResult> {
    await this.ready;
    const receipt = await this.bridge.request("malink.command.resolveConflict", {
      context: this.bridge.context(),
      idempotencyKey: crypto.randomUUID(),
      commandId,
      action: "retry",
    });
    return this.#sendResult(receipt);
  }

  async discardRevisionConflict(commandId: string): Promise<void> {
    await this.ready;
    const receipt = await this.bridge.request("malink.command.resolveConflict", {
      context: this.bridge.context(),
      idempotencyKey: crypto.randomUUID(),
      commandId,
      action: "discard",
    });
    await this.releaseCommand(receipt.commandId ?? commandId);
  }

  async uploadAttachment(file: File): Promise<MalinkAttachment> {
    await this.ready;
    if (file.size > NATIVE_BRIDGE_LIMITS.maxAttachmentBytes) {
      throw new BridgeProtocolError(
        "ATTACHMENT_TOO_LARGE",
        "Attachment exceeds the native bridge limit.",
      );
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const digest = await sha256Base64Url(bytes);
    const opened = await this.bridge.request("malink.attachment.upload.open", {
      context: this.bridge.context(),
      idempotencyKey: crypto.randomUUID(),
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      size: bytes.byteLength,
      sha256: digest,
    });
    try {
      let index = opened.nextIndex;
      while (index * opened.chunkBytes < bytes.byteLength) {
        const start = index * opened.chunkBytes;
        const chunk = bytes.subarray(start, start + opened.chunkBytes);
        const acknowledged = await this.bridge.request(
          "malink.attachment.upload.chunk",
          {
            context: this.bridge.context(),
            transferId: opened.transferId,
            index,
            dataBase64Url: base64UrlEncode(chunk),
            chunkSha256: await sha256Base64Url(chunk),
          },
          30_000,
        );
        if (
          acknowledged.transferId !== opened.transferId ||
          acknowledged.index !== index ||
          acknowledged.nextIndex <= index
        ) {
          throw new BridgeProtocolError(
            "CHUNK_CONFLICT",
            "The native attachment upload acknowledged a different chunk.",
          );
        }
        index = acknowledged.nextIndex;
      }
      const finished = await this.bridge.request(
        "malink.attachment.upload.finish",
        {
          context: this.bridge.context(),
          idempotencyKey: crypto.randomUUID(),
          transferId: opened.transferId,
        },
        60_000,
      );
      return finished.attachment;
    } catch (error) {
      void this.bridge.request("malink.attachment.upload.abort", {
        context: this.bridge.context(),
        idempotencyKey: crypto.randomUUID(),
        transferId: opened.transferId,
      }).catch(() => {});
      throw error;
    }
  }

  async downloadAttachment(attachment: MalinkAttachment): Promise<Blob> {
    await this.ready;
    const opened = await this.bridge.request("malink.attachment.download.open", {
      context: this.bridge.context(),
      attachment,
    });
    const chunks: Uint8Array[] = [];
    try {
      for (let index = 0; index < opened.chunkCount; index += 1) {
        const part = await this.bridge.request(
          "malink.attachment.download.read",
          {
            context: this.bridge.context(),
            transferId: opened.transferId,
            index,
          },
          30_000,
        );
        if (part.transferId !== opened.transferId || part.index !== index) {
          throw new BridgeProtocolError(
            "CHUNK_CONFLICT",
            "The native attachment download returned a different chunk.",
          );
        }
        const chunk = base64UrlDecode(part.dataBase64Url);
        if ((await sha256Base64Url(chunk)) !== part.chunkSha256) {
          throw new BridgeProtocolError("HASH_MISMATCH", "Attachment chunk hash mismatch.");
        }
        if (part.eof !== (index === opened.chunkCount - 1)) {
          throw new BridgeProtocolError("CHUNK_CONFLICT", "Attachment EOF marker is invalid.");
        }
        chunks.push(chunk);
      }
      const bytes = concatenate(chunks, opened.size);
      if ((await sha256Base64Url(bytes)) !== opened.sha256) {
        throw new BridgeProtocolError("HASH_MISMATCH", "Attachment hash mismatch.");
      }
      return new Blob([toArrayBuffer(bytes)], { type: attachment.mimeType });
    } finally {
      void this.bridge.request("malink.attachment.download.close", {
        context: this.bridge.context(),
        transferId: opened.transferId,
      }).catch(() => {});
    }
  }

  markHistoryLoaded(sessionId: string, eventIds: readonly string[]): void {
    const loaded = this.#loadedHistoryEventIds.get(sessionId) ?? new Set<string>();
    eventIds.forEach((eventId) => loaded.add(eventId));
    this.#loadedHistoryEventIds.set(sessionId, loaded);
  }

  async loadLocalHistory(
    sessionId: string,
  ): Promise<MalinkHistoryPage> {
    this.#historyBefore.delete(sessionId);
    const loaded = this.#loadedHistoryEventIds.get(sessionId) ?? new Set<string>();
    const page = await this.#loadHistory(
      sessionId,
      NATIVE_CATCHUP_PRESENTATION_LIMIT_PER_SESSION,
      undefined,
      "local",
    );
    return {
      messages: page.messages
        .filter((message) => !loaded.has(message.eventId))
        .sort(
          (left, right) =>
            left.timestamp - right.timestamp ||
            left.eventId.localeCompare(right.eventId),
        ),
      hasMore: page.hasMore,
    };
  }

  async loadHistoryPage(
    sessionId: string,
    limit = 30,
  ): Promise<MalinkHistoryPage> {
    return this.#loadHistory(
      sessionId,
      limit,
      this.#historyBefore.get(sessionId),
      "matrix",
    );
  }

  async observeCommandCompletion(
    commandId: string,
    timeoutMs: number,
  ): Promise<CommandCompletion> {
    await this.ready;
    const current = await this.bridge.request("malink.command.get", {
      context: this.bridge.context(),
      commandId,
    });
    this.#recordCommand(current);
    const completed = this.#completions.get(commandId);
    if (completed) return completed;
    return this.#waitForCompletion(
      commandId,
      timeoutMs,
      () => new CommandCompletionTimeoutError(),
    );
  }

  async releaseCommand(commandId: string): Promise<void> {
    await this.ready;
    await this.bridge.request("malink.command.release", {
      context: this.bridge.context(),
      idempotencyKey: crypto.randomUUID(),
      commandId,
    });
    const operationId = this.#commandOperations.get(commandId);
    if (operationId) {
      const aliases: string[] = [];
      for (const [knownCommandId, knownOperationId] of this.#commandOperations) {
        if (knownOperationId === operationId) {
          aliases.push(knownCommandId);
        }
      }
      for (const alias of aliases) {
        this.#completions.delete(alias);
        this.#commandOperations.delete(alias);
        this.#rejectCompletion(alias, new CommandCompletionExpiredError(alias));
      }
    } else {
      this.#completions.delete(commandId);
      this.#commandOperations.delete(commandId);
      this.#rejectCompletion(commandId, new CommandCompletionExpiredError(commandId));
    }
  }

  async disconnect(): Promise<void> {
    await this.ready;
    if (this.#disposed) return;
    this.#disposed = true;
    this.#discardNetworkCatchup();
    this.#detachEventListener?.();
    this.#detachEventListener = null;
    this.#subscriptionId = null;
    await this.bridge.request("malink.client.disconnect", {
      context: this.bridge.context(),
      idempotencyKey: crypto.randomUUID(),
      mode: "stop",
    });
    this.bridge.close();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#discardNetworkCatchup();
    this.#detachEventListener?.();
    this.#detachEventListener = null;
    const subscriptionId = this.#subscriptionId;
    this.#subscriptionId = null;
    if (!subscriptionId) {
      this.bridge.close();
      return;
    }
    // Posting the unsubscribe is synchronous. Release the injected port
    // immediately afterwards so a bootstrap/reconnect can acquire it without
    // racing the asynchronous native response.
    void this.bridge.request("malink.events.unsubscribe", {
      context: this.bridge.context(),
      subscriptionId,
    })
      .catch(() => undefined);
    this.bridge.close();
  }

  async #initialize(): Promise<void> {
    this.#detachEventListener = this.bridge.onEvents((notification) => {
      if (notification.params.subscriptionId !== this.#subscriptionId) return;
      this.#eventChain = this.#eventChain
        .then(() => this.#acceptEvents(notification.params.events, true, "live"))
        .catch((error) => {
          this.handlers.onStatus("error", formatError(error));
        });
    });
    const started = await this.bridge.request("malink.client.start", {
      context: this.bridge.context(),
      idempotencyKey: crypto.randomUUID(),
    });
    this.#deviceId = started.deviceId;
    this.#applySnapshot(started.snapshot);
    const subscribed = await this.bridge.request("malink.events.subscribe", {
      context: this.bridge.context(),
      afterCursor: this.cursorStore.load(this.#deviceId),
      maxReplayEvents: NATIVE_BRIDGE_LIMITS.maxReplayEvents,
    });
    this.#subscriptionId = subscribed.subscriptionId;
    if (subscribed.mode === "snapshot") {
      this.#applySnapshot(subscribed.snapshot);
    } else {
      await this.#acceptEvents(subscribed.events, false, "catchup");
    }
    await this.bridge.request("malink.events.activate", {
      context: this.bridge.context(),
      subscriptionId: subscribed.subscriptionId,
      throughCursor: subscribed.barrierCursor,
    });
    this.cursorStore.save(this.#deviceId, subscribed.barrierCursor);
  }

  async #acceptEvents(
    events: ClientEvent[],
    acknowledge: boolean,
    deliveryMode: MessageDeliveryMode,
  ): Promise<void> {
    const immediateCatchup: MalinkHistoryPage["messages"] = [];
    for (const event of events) {
      if (event.type !== "message.upserted") {
        this.#acceptEvent(event, deliveryMode);
        continue;
      }
      const effectiveDeliveryMode =
        deliveryMode === "live" && this.#networkCatchupActive
          ? "catchup"
          : deliveryMode;
      if (effectiveDeliveryMode === "live") {
        this.#acceptEvent(event, "live");
        continue;
      }
      const message = this.#messageForDelivery(
        event.payload,
        effectiveDeliveryMode,
      );
      if (deliveryMode === "live") {
        this.#queueNetworkCatchupMessage(message);
      } else {
        immediateCatchup.push(message);
      }
    }
    this.#deliverCatchupMessages(immediateCatchup);
    this.#scheduleNetworkCatchupSettle();
    const throughCursor = events.at(-1)?.cursor;
    if (!throughCursor || !this.#subscriptionId) return;
    if (acknowledge) {
      await this.bridge.request("malink.events.ack", {
        context: this.bridge.context(),
        subscriptionId: this.#subscriptionId,
        throughCursor,
      });
    }
    if (acknowledge) this.cursorStore.save(this.#deviceId, throughCursor);
  }

  #deliverCatchupMessages(
    messages: MalinkHistoryPage["messages"],
  ): void {
    const catchupBySession = new Map<string, MalinkHistoryPage["messages"]>();
    const unscoped: MalinkHistoryPage["messages"] = [];
    for (const message of messages) {
      if (!message.sessionId) {
        unscoped.push(message);
        continue;
      }
      const sessionMessages = catchupBySession.get(message.sessionId) ?? [];
      sessionMessages.push(message);
      catchupBySession.set(message.sessionId, sessionMessages);
    }
    for (const [sessionId, sessionMessages] of catchupBySession) {
      const bounded = sessionMessages.slice(
        -NATIVE_CATCHUP_PRESENTATION_LIMIT_PER_SESSION,
      );
      if (this.handlers.onHistoryRecovered) {
        this.handlers.onHistoryRecovered({ sessionId, messages: bounded, hasMore: true });
      } else {
        bounded.forEach((message) => this.handlers.onMessage(message));
      }
    }
    unscoped
      .slice(-NATIVE_CATCHUP_PRESENTATION_LIMIT_PER_SESSION)
      .forEach((message) => this.handlers.onMessage(message));
  }

  #queueNetworkCatchupMessage(
    message: MalinkHistoryPage["messages"][number],
  ): void {
    const target = message.sessionId
      ? this.#networkCatchupBySession.get(message.sessionId) ?? []
      : this.#networkCatchupUnscoped;
    target.push(message);
    if (target.length > NATIVE_CATCHUP_PRESENTATION_LIMIT_PER_SESSION) {
      target.splice(
        0,
        target.length - NATIVE_CATCHUP_PRESENTATION_LIMIT_PER_SESSION,
      );
    }
    if (message.sessionId) {
      this.#networkCatchupBySession.set(message.sessionId, target);
    }
  }

  #noteNetworkPresentationStatus(
    status: Parameters<MalinkClientHandlers["onStatus"]>[0],
  ): void {
    if (status === "offline" || status === "reconnecting") {
      this.#networkCatchupActive = true;
      this.#networkCatchupConnected = false;
      if (this.#networkCatchupSettleTimer !== null) {
        clearTimeout(this.#networkCatchupSettleTimer);
        this.#networkCatchupSettleTimer = null;
      }
      return;
    }
    if (status === "connected" && this.#networkCatchupActive) {
      this.#networkCatchupConnected = true;
      this.#scheduleNetworkCatchupSettle();
    }
  }

  #scheduleNetworkCatchupSettle(): void {
    if (
      !this.#networkCatchupActive
      || !this.#networkCatchupConnected
      || this.#disposed
    ) return;
    if (this.#networkCatchupSettleTimer !== null) {
      clearTimeout(this.#networkCatchupSettleTimer);
    }
    this.#networkCatchupSettleTimer = setTimeout(() => {
      this.#networkCatchupSettleTimer = null;
      if (this.#disposed || !this.#networkCatchupActive) return;
      const messages = [
        ...this.#networkCatchupBySession.values(),
        this.#networkCatchupUnscoped,
      ].flat();
      this.#networkCatchupBySession.clear();
      this.#networkCatchupUnscoped.length = 0;
      this.#networkCatchupActive = false;
      this.#networkCatchupConnected = false;
      try {
        this.#deliverCatchupMessages(messages);
      } catch (error) {
        this.handlers.onStatus("error", formatError(error));
      }
    }, NATIVE_CATCHUP_SETTLE_MS);
  }

  #discardNetworkCatchup(): void {
    if (this.#networkCatchupSettleTimer !== null) {
      clearTimeout(this.#networkCatchupSettleTimer);
      this.#networkCatchupSettleTimer = null;
    }
    this.#networkCatchupBySession.clear();
    this.#networkCatchupUnscoped.length = 0;
    this.#networkCatchupActive = false;
    this.#networkCatchupConnected = false;
  }

  #acceptEvent(event: ClientEvent, deliveryMode: MessageDeliveryMode): void {
    switch (event.type) {
      case "message.upserted":
        this.handlers.onMessage(this.#messageForDelivery(event.payload, deliveryMode));
        break;
      case "command.changed":
        this.#recordCommand(parseCommandView(event.payload));
        break;
      case "trust.changed": {
        const trust = parsePublicTrustState(event.payload);
        this.handlers.onTrustUpdated?.(trust.state === "trusted" ? trust : null);
        break;
      }
      case "client.status.changed": {
        const status = parseStatusPayload(event.payload);
        this.handlers.onStatus(status.status, status.detail);
        this.#noteNetworkPresentationStatus(status.status);
        break;
      }
      case "gateway.state.changed":
        this.#applyGatewayState(event.payload);
        break;
      case "message.removed":
      case "attachment.changed":
      case "pairing.changed":
        break;
    }
  }

  #messageForDelivery(
    payload: ClientEvent["payload"],
    deliveryMode: MessageDeliveryMode,
  ): MalinkHistoryPage["messages"][number] {
    const message = parseCompatibleClientMessage(payload);
    return {
      ...message,
      deliveryMode: message.historical ? "history" : deliveryMode,
    };
  }

  #applySnapshot(snapshot: ClientSnapshot): void {
    this.#deviceId = snapshot.deviceId;
    this.handlers.onStatus(
      matrixStatus(snapshot.lifecycle.phase),
      snapshot.lifecycle.detailCode,
    );
    this.#noteNetworkPresentationStatus(matrixStatus(snapshot.lifecycle.phase));
    this.handlers.onTrustUpdated?.(
      snapshot.trust.state === "trusted" ? snapshot.trust : null,
    );
    snapshot.commands.forEach((command) => {
      this.#recordCommand(command);
      if (command.commandId) {
        this.handlers.onDurableCommandRecovered?.({
          commandId: command.commandId,
          state: command.state,
          submittedAt: command.submittedAt,
          updatedAt: command.updatedAt,
          ...(command.sessionId === undefined
            ? {}
            : { sessionId: command.sessionId }),
        });
      }
    });
    if (snapshot.gatewayState) this.#applyGatewayState(snapshot.gatewayState);
  }

  #applyGatewayState(input: unknown): void {
    const gatewayState = parseGatewayStateExtension(input);
    if (!gatewayState) return;
    this.handlers.onCollaborationState?.({
      activeDeviceCount: gatewayState.activeDeviceCount,
      revision: gatewayState.revision,
      gatewayState,
    });
  }

  #recordCommand(command: CommandView): void {
    if (command.commandId) {
      this.#rememberCommandOperation(command.commandId, command.operationId);
    }
    if (command.commandId && command.state === "needs_review") {
      const review: MalinkCommandReview = { commandId: command.commandId };
      this.#reviewCommands.set(command.operationId, command.commandId);
      this.handlers.onCommandReviewRequired?.(review);
    } else if (this.#reviewCommands.delete(command.operationId)) {
      this.handlers.onCommandReviewRequired?.(null);
    }
    const completion = command.completion;
    if (!completion) return;
    this.#rememberCommandOperation(completion.commandId, command.operationId);
    const normalized: CommandCompletion = {
      commandId: completion.commandId,
      sequence: completion.sequence,
      revision: completion.revision,
      outcome: completion.outcome,
      ...(completion.sessionId === undefined
        ? {}
        : { sessionId: completion.sessionId }),
      ...(completion.result === undefined ? {} : { result: completion.result }),
      ...(completion.error === undefined ? {} : { error: completion.error }),
    };
    const aliases = [...this.#commandOperations]
      .filter(([, operationId]) => operationId === command.operationId)
      .map(([commandId]) => commandId);
    if (!aliases.includes(completion.commandId)) aliases.push(completion.commandId);
    const primaryCommandId = aliases[0] ?? completion.commandId;
    for (const commandId of aliases) {
      const aliased = commandId === completion.commandId
        ? normalized
        : { ...normalized, commandId };
      this.#completions.set(commandId, aliased);
      this.#resolveCompletion(commandId, aliased);
    }
    if (!command.sessionId && normalized.sessionId) {
      this.handlers.onSessionCreateRecovered?.({
        commandId: primaryCommandId,
        submittedAt: command.submittedAt,
        completion: primaryCommandId === normalized.commandId
          ? { ...normalized, sessionId: normalized.sessionId }
          : {
              ...normalized,
              commandId: primaryCommandId,
              sessionId: normalized.sessionId,
            },
      });
    }
    this.handlers.onCommandResult?.(
      primaryCommandId === completion.commandId
        ? normalized
        : { ...normalized, commandId: primaryCommandId },
    );
  }

  async #sendWhenOutboxAvailable(
    payload: CommandPayload,
    idempotencyKey: string,
    projectId?: string,
  ): Promise<CommandReceipt> {
    const deadline = Date.now() + DEFAULT_BLOCKED_COMMAND_RETRY_WINDOW_MS;
    while (true) {
      try {
        return await this.bridge.request("malink.command.send", {
          context: this.bridge.context(),
          idempotencyKey,
          ...(projectId ? { projectId } : {}),
          payload: { ...jsonObject(payload), operation: payload.operation },
        });
      } catch (error) {
        const blocking = parseBlockingCommand(error);
        if (!blocking) throw error;
        if (blocking.state === "needs_review") {
          this.handlers.onCommandReviewRequired?.(blocking);
          throw new CommandReviewRequiredError(blocking);
        }
        if (
          !(error instanceof BridgeProtocolError) ||
          !error.data.retryable ||
          Date.now() >= deadline
        ) {
          throw error;
        }
        const retryAfterMs = Math.max(
          250,
          Math.min(error.data.retryAfterMs ?? 1_000, 5_000),
        );
        await delay(retryAfterMs);
      }
    }
  }

  async #sendResult(
    receipt: CommandReceipt,
    createsSession = false,
  ): Promise<MalinkCommandSendResult> {
    if (!receipt.commandId) {
      throw new BridgeProtocolError(
        "INVALID_REQUEST",
        "Native command receipt omitted its durable command identity.",
      );
    }
    const commandId = receipt.commandId;
    this.#rememberCommandOperation(commandId, receipt.operationId);
    if (receipt.state === "needs_review") {
      const review: MalinkCommandReview = { commandId };
      this.#reviewCommands.set(receipt.operationId, commandId);
      this.handlers.onCommandReviewRequired?.(review);
      throw new CommandReviewRequiredError(review);
    }
    // The RPC result means the native service has atomically persisted and
    // taken responsibility for the command. Matrix publication, Gateway
    // progress, and the signed terminal event continue independently.
    const completion = this.#waitForCompletion(
      commandId,
      DEFAULT_COMMAND_TIMEOUT_MS,
      () => new CommandCompletionExpiredError(commandId),
    );
    return {
      operationId: receipt.operationId,
      commandId,
      ...(receipt.sessionId
        ? { sessionId: receipt.sessionId }
        : createsSession
          ? { sessionId: commandId }
          : {}),
      // Compatibility presentation fields for callers that still render
      // legacy command metadata. They carry no MLP/3 authorization meaning.
      sequence: receipt.sequence ?? 1,
      revision: receipt.revision ?? 0,
      completion,
    };
  }

  #waitForCompletion(
    commandId: string,
    timeoutMs: number,
    timeoutError: () => Error,
  ): Promise<CommandCompletion> {
    const completed = this.#completions.get(commandId);
    if (completed) return Promise.resolve(completed);
    return new Promise((resolve, reject) => {
      const waiters = this.#completionWaiters.get(commandId) ?? new Set();
      const remove = () => {
        waiters.delete(waiter);
        if (waiters.size === 0) this.#completionWaiters.delete(commandId);
      };
      const timer = globalThis.setTimeout(() => {
        remove();
        reject(timeoutError());
      }, Math.max(1, timeoutMs));
      const waiter: CompletionWaiter = {
        resolve: (completion) => {
          globalThis.clearTimeout(timer);
          remove();
          resolve(completion);
        },
        reject: (error) => {
          globalThis.clearTimeout(timer);
          remove();
          reject(error);
        },
      };
      waiters.add(waiter);
      this.#completionWaiters.set(commandId, waiters);
    });
  }

  #rejectCompletion(commandId: string, error: Error): void {
    const waiters = this.#completionWaiters.get(commandId);
    if (!waiters) return;
    this.#completionWaiters.delete(commandId);
    waiters.forEach((waiter) => waiter.reject(error));
  }

  #rememberCommandOperation(commandId: string, operationId: string): void {
    this.#commandOperations.set(commandId, operationId);
    if (this.#completions.has(commandId)) return;
    for (const [knownCommandId, knownOperationId] of this.#commandOperations) {
      if (knownOperationId !== operationId || knownCommandId === commandId) continue;
      const completed = this.#completions.get(knownCommandId);
      if (!completed) continue;
      const aliased = { ...completed, commandId };
      this.#completions.set(commandId, aliased);
      this.#resolveCompletion(commandId, aliased);
      return;
    }
  }

  #resolveCompletion(commandId: string, completion: CommandCompletion): void {
    const waiters = this.#completionWaiters.get(commandId);
    if (!waiters) return;
    this.#completionWaiters.delete(commandId);
    waiters.forEach((waiter) => waiter.resolve(completion));
  }

  async #loadHistory(
    sessionId: string,
    limit: number,
    before: string | undefined,
    source: "local" | "matrix",
  ): Promise<MalinkHistoryPage> {
    await this.ready;
    const page = await this.bridge.request("malink.history.page", {
      context: this.bridge.context(),
      sessionId,
      ...(before === undefined ? {} : { before }),
      limit: Math.max(1, Math.min(limit, 100)),
      source,
    });
    if (page.sessionId !== sessionId) {
      throw new BridgeProtocolError(
        "HISTORY_CURSOR_INVALID",
        "Native history returned a different session.",
      );
    }
    if (page.nextBefore) this.#historyBefore.set(sessionId, page.nextBefore);
    else this.#historyBefore.delete(sessionId);
    return {
      messages: page.messages.map((payload) => ({
        ...parseCompatibleClientMessage(payload),
        deliveryMode: "history" as const,
        historical: true,
      })),
      hasMore: page.hasMore,
    };
  }
}

/**
 * APKs released before native tool-presentation support still authenticate
 * the MLP/3 assistant payload, but expose it as an agent message. Recover the
 * structured UI in the web layer so Android and browser rendering stay equal
 * while those APKs are upgraded.
 */
function parseCompatibleClientMessage(input: unknown) {
  const message = parseClientMessage(input);
  if (
    message.kind !== "agent" ||
    message.toolGroup ||
    message.semantic?.type !== "assistant.message"
  ) {
    return message;
  }
  const toolGroup = parseToolGroupPresentation(message.semantic.ui);
  return toolGroup
    ? { ...message, kind: "tool" as const, toolGroup }
    : message;
}

export async function createNativeBridgeClient(
  bridge: NativeRpcBridge,
  hello: HelloResult,
  handlers: MalinkClientHandlers,
  cursorStore?: NativeCursorStore,
): Promise<NativeBridgeClient> {
  const client = new NativeBridgeClient(bridge, hello, handlers, cursorStore);
  await client.ready;
  return client;
}

export async function bootstrapNativeSession(
  bridge: NativeRpcBridge,
  input: NativeBootstrapInput,
): Promise<ClientBootstrapResult> {
  return bridge.request("malink.client.bootstrap", {
    context: bridge.context(),
    idempotencyKey: crypto.randomUUID(),
    ...input,
  });
}

export async function readNativeMatrixSession(
  bridge: NativeRpcBridge,
): Promise<PublicMatrixSession | null> {
  const result = await bridge.request("malink.client.session", {
    context: bridge.context(),
  });
  return result.session;
}

export function assertFullNativeCapabilities(hello: HelloResult): void {
  const missing = REQUIRED_NATIVE_CAPABILITIES.find(
    (name) => !hasCurrentNativeCapability(hello, name),
  );
  if (missing) {
    throw new BridgeProtocolError(
      "CAPABILITY_UNAVAILABLE",
      `Native runtime is missing required capability: ${missing}.`,
      { userAction: "update_native" },
    );
  }
}

function matrixStatus(
  phase: ClientSnapshot["lifecycle"]["phase"],
): Parameters<MalinkClientHandlers["onStatus"]>[0] {
  switch (phase) {
    case "ready": return "connected";
    case "securing": return "securing";
    case "reconnecting": return "reconnecting";
    case "offline":
    case "stopped": return "offline";
    case "blocked": return "error";
    case "starting":
    case "unpaired":
    case "connecting": return "connecting";
  }
}

function parseStatusPayload(input: unknown): {
  status: Parameters<MalinkClientHandlers["onStatus"]>[0];
  detail?: string;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new BridgeProtocolError("INVALID_PARAMS", "Native status payload is invalid.");
  }
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "phase" && key !== "detail")) {
    throw new BridgeProtocolError("INVALID_PARAMS", "Native status payload has unknown fields.");
  }
  if (typeof value.phase !== "string") {
    throw new BridgeProtocolError("INVALID_PARAMS", "Native status phase is invalid.");
  }
  const allowed = new Set([
    "stopped", "starting", "unpaired", "connecting", "securing",
    "ready", "reconnecting", "offline", "blocked",
  ]);
  if (!allowed.has(value.phase)) {
    throw new BridgeProtocolError("INVALID_PARAMS", "Native status phase is unsupported.");
  }
  if (value.detail !== undefined && typeof value.detail !== "string") {
    throw new BridgeProtocolError("INVALID_PARAMS", "Native status detail is invalid.");
  }
  return {
    status: matrixStatus(value.phase as ClientSnapshot["lifecycle"]["phase"]),
    ...(value.detail === undefined ? {} : { detail: value.detail }),
  };
}

function jsonObject(value: unknown): JsonObject {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BridgeProtocolError("INVALID_PARAMS", "Value must be a JSON object.");
  }
  return parsed as JsonObject;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
}

async function withPairingAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      // Detaching or reloading the hosted UI must not revoke a transaction
      // that the user already confirmed in native UI. The service owns that
      // durable request and continues it independently of this waiter.
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function sha256Base64Url(bytes: Uint8Array): Promise<string> {
  return base64UrlEncode(
    new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes))),
  );
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function concatenate(chunks: Uint8Array[], size: number): Uint8Array {
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset + chunk.byteLength > size) {
      throw new BridgeProtocolError("HASH_MISMATCH", "Attachment size is invalid.");
    }
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== size) {
    throw new BridgeProtocolError("HASH_MISMATCH", "Attachment size is invalid.");
  }
  return output;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseBlockingCommand(error: unknown): BlockingCommand | null {
  if (!(error instanceof BridgeProtocolError)) return null;
  const details = error.data.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  if (details.kind !== "command_blocked" || typeof details.commandId !== "string") {
    return null;
  }
  if (
    details.state !== "queued" &&
    details.state !== "transmitting" &&
    details.state !== "recovery_required" &&
    details.state !== "needs_review"
  ) {
    return null;
  }
  const operation = parseCommandOperation(details.operation);
  const expectedRevision = typeof details.expectedRevision === "number" &&
      Number.isSafeInteger(details.expectedRevision) && details.expectedRevision >= 0
    ? details.expectedRevision
    : undefined;
  return {
    commandId: details.commandId,
    state: details.state,
    ...(operation === undefined ? {} : { operation }),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  };
}

function parseCommandOperation(input: unknown): CommandPayload["operation"] | undefined {
  switch (input) {
    case "session.create":
    case "project.create":
    case "project.settings":
    case "project.delete":
    case "provider.sessions.list":
    case "provider.session.inspect":
    case "session.settings":
    case "session.archive":
    case "session.restore":
    case "session.delete":
    case "prompt":
    case "cancel":
    case "decision":
    case "artifact.materialize":
    case "device.invite":
    case "gateway.enrollment.invite":
    case "gateway.enrollment.approve":
    case "gateway.profile.update":
    case "gateway.update.stage":
    case "gateway.update.apply":
    case "gateway.update.status":
      return input;
    default:
      return undefined;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}
