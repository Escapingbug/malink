import assert from "node:assert/strict";
import test from "node:test";
import {
  BridgeProtocolError,
  NATIVE_BRIDGE_LIMITS,
  type BridgeMethodParams,
  type CapabilityName,
  type ClientSnapshot,
  type HelloResult,
  type RequestMethod,
} from "@malink/native-bridge";
import {
  NativeBridgeClient,
  OPTIONAL_NATIVE_CAPABILITIES,
  REQUIRED_NATIVE_CAPABILITIES,
  nativeCapabilityVersions,
} from "../app/client/native/NativeBridgeClient.ts";
import {
  acquireNativeRpcBridge,
  type NativeBridgePort,
} from "../app/client/native/NativeRpcBridge.ts";
import {
  CommandReviewRequiredError,
  type MalinkCommandReview,
  type MalinkRecoveredDurableCommand,
} from "../app/client/MalinkClient.ts";
import { gatewayStateExtension } from "../app/gatewayState.ts";
import { gatewayProjectOwners } from "../app/projectCatalog.ts";

type Request = {
  jsonrpc: "2.0";
  id: string;
  method: RequestMethod;
  params: BridgeMethodParams[RequestMethod];
};

const NO_RESPONSE = Symbol("no native response");

class RuntimePort implements NativeBridgePort {
  onmessage: NativeBridgePort["onmessage"] = null;
  readonly requests: Request[] = [];

  constructor(
    private readonly responder: (request: Request) => unknown = responseFor,
  ) {}

  postMessage(message: string): void {
    const request = JSON.parse(message) as Request;
    this.requests.push(request);
    queueMicrotask(() => this.#respond(request));
  }

  deliver(notification: unknown): void {
    this.onmessage?.({ data: JSON.stringify(notification) });
  }

  respond(request: Request, result: unknown): void {
    this.onmessage?.({
      data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
    });
  }

  #respond(request: Request): void {
    try {
      const result = this.responder(request);
      if (result === NO_RESPONSE) return;
      this.respond(request, result);
    } catch (error) {
      if (!(error instanceof BridgeProtocolError)) throw error;
      this.onmessage?.({
        data: JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: error.toRpcError(),
        }),
      });
    }
  }
}

test("returns a durable native receipt immediately and acknowledges event cursors", async () => {
  const port = new RuntimePort();
  const bridge = await acquireNativeRpcBridge(port);
  const hello = await bridge.hello({
    webBuild: "test-build",
    requiredCapabilities: [],
    optionalCapabilities: [
      ...REQUIRED_NATIVE_CAPABILITIES.map((name) => ({
        name,
        versions: nativeCapabilityVersions(name),
      })),
      ...OPTIONAL_NATIVE_CAPABILITIES.map((name) => ({
        name,
        versions: [1],
      })),
    ],
  });
  const statuses: string[] = [];
  const commandResults: string[] = [];
  const savedCursors: string[] = [];
  const client = new NativeBridgeClient(
    bridge,
    hello,
    {
      onMessage() {},
      onStatus(status) {
        statuses.push(status);
      },
      onCommandResult(result) {
        commandResults.push(result.commandId);
      },
    },
    {
      load: () => "cursor-previous",
      save: (_deviceId, cursor) => savedCursors.push(cursor),
    },
  );
  await client.ready;
  assert.equal(client.runtime, "native");
  assert.equal(client.deviceId, "native-device-1");
  assert.deepEqual(statuses, ["connected"]);
  assert.deepEqual(savedCursors, ["cursor-barrier-1"]);

  const pendingSend = client.send({
    operation: "cancel",
    sessionId: "s1",
    targetCommandId: "turn-1",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const commandRequest = port.requests.find(
    (request) => request.method === "malink.command.send",
  );
  assert.deepEqual(
    (commandRequest?.params as BridgeMethodParams["malink.command.send"] | undefined)?.payload,
    {
      operation: "cancel",
      sessionId: "s1",
      targetCommandId: "turn-1",
    },
  );
  const sent = await pendingSend;
  assert.equal(sent.commandId, "command-1");
  assert.equal(sent.revision, 0);
  port.deliver({
    jsonrpc: "2.0",
    method: "malink.events.deliver",
    params: {
      subscriptionId: "subscription-1",
      events: [
        {
          schemaVersion: 1,
          eventId: "event-command-1",
          cursor: "cursor-event-2",
          occurredAt: 2,
          type: "command.changed",
          payload: {
            operationId: "operation-1",
            commandId: "command-1",
            idempotencyKey: "00000000-0000-4000-8000-000000000001",
            state: "succeeded",
            submittedAt: 1,
            updatedAt: 2,
            sequence: 1,
            revision: 4,
            completion: {
              commandId: "command-1",
              sequence: 1,
              revision: 4,
              outcome: "succeeded",
            },
          },
        },
      ],
    },
  });
  assert.deepEqual(await sent.completion, {
    commandId: "command-1",
    sequence: 1,
    revision: 4,
    outcome: "succeeded",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(commandResults, ["command-1"]);
  assert.deepEqual(savedCursors, [
    "cursor-barrier-1",
    "cursor-event-2",
  ]);
  assert.ok(port.requests.some((request) => request.method === "malink.events.ack"));

  const token = await client.requestMatrixLoginToken("invite-command-1");
  assert.deepEqual(token, {
    status: "ready",
    loginToken: "single-use-token",
    expiresAt: 120_000,
  });
  const tokenRequest = port.requests.find(
    (request) => request.method === "malink.matrix.loginToken",
  );
  assert.ok(tokenRequest);
  assert.equal(
    (tokenRequest.params as BridgeMethodParams["malink.matrix.loginToken"])
      .invitationId,
    "invite-command-1",
  );
  assert.equal(JSON.stringify(tokenRequest).includes("accessToken"), false);

  await client.retireUnverifiedCommand("command-orphaned-1");
  const retirementRequest = port.requests.find(
    (request) => request.method === "malink.command.retire",
  );
  assert.ok(retirementRequest);
  assert.equal(
    (retirementRequest.params as BridgeMethodParams["malink.command.retire"])
      .commandId,
    "command-orphaned-1",
  );

  client.dispose();
  assert.equal(port.onmessage, null);
  assert.ok(
    port.requests.some((request) => request.method === "malink.events.unsubscribe"),
  );
  const replacement = await acquireNativeRpcBridge(port);
  replacement.close();
});

test("signs the Android Matrix device out through the revocation boundary", async () => {
  const port = new RuntimePort();
  const client = await createTestClient(port);

  await client.signOut();

  const request = port.requests.find(
    (candidate) => candidate.method === "malink.client.disconnect",
  );
  assert.ok(request);
  assert.equal(
    (request.params as BridgeMethodParams["malink.client.disconnect"]).mode,
    "revoke",
  );
  assert.equal(port.onmessage, null);
});

test("keeps the native connection usable when Matrix revocation fails", async () => {
  const port = new RuntimePort((request) => {
    if (request.method === "malink.client.disconnect") {
      throw new BridgeProtocolError(
        "NATIVE_INTERNAL",
        "Matrix did not confirm logout.",
      );
    }
    return responseFor(request);
  });
  const client = await createTestClient(port);

  await assert.rejects(client.signOut(), /Matrix did not confirm logout/);
  assert.deepEqual(await client.requestMatrixLoginToken("invite-command-1"), {
    status: "ready",
    loginToken: "single-use-token",
    expiresAt: 120_000,
  });
  assert.notEqual(port.onmessage, null);
  client.dispose();
});

test("bounds native replay as catch-up while later events remain live", async () => {
  const replayEvents = Array.from({ length: 35 }, (_, index) => ({
    schemaVersion: 1,
    eventId: `replay-event-${index}`,
    cursor: `replay-cursor-${index}`,
    occurredAt: index + 1,
    type: "message.upserted" as const,
    payload: {
      eventId: `replay-message-${index}`,
      sender: "gateway",
      timestamp: index + 1,
      encrypted: true,
      kind: "agent",
      text: `restored ${index}`,
      sessionId: "session-catchup",
      format: "plain",
    },
  }));
  const port = new RuntimePort((request) => {
    if (request.method !== "malink.events.subscribe") {
      return responseFor(request);
    }
    return {
      subscriptionId: "subscription-1",
      barrierCursor: "replay-cursor-34",
      mode: "replay",
      events: replayEvents,
    };
  });
  const liveMessages: Array<{ eventId: string; deliveryMode?: string }> = [];
  const recoveries: Array<{
    sessionId: string;
    messages: Array<{ eventId: string; deliveryMode?: string }>;
    hasMore: boolean;
  }> = [];
  const bridge = await acquireNativeRpcBridge(port);
  const hello = await bridge.hello({
    webBuild: "test-build",
    requiredCapabilities: [],
    optionalCapabilities: REQUIRED_NATIVE_CAPABILITIES.map((name) => ({
      name,
      versions: nativeCapabilityVersions(name),
    })),
  });
  const client = new NativeBridgeClient(bridge, hello, {
    onMessage(message) {
      liveMessages.push({
        eventId: message.eventId,
        deliveryMode: message.deliveryMode,
      });
    },
    onStatus() {},
    onHistoryRecovered(recovery) {
      recoveries.push(recovery);
    },
  });

  await client.ready;

  assert.equal(liveMessages.length, 0);
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0]?.sessionId, "session-catchup");
  assert.equal(recoveries[0]?.hasMore, true);
  assert.equal(recoveries[0]?.messages.length, 30);
  assert.equal(recoveries[0]?.messages[0]?.eventId, "replay-message-5");
  assert.equal(recoveries[0]?.messages.at(-1)?.eventId, "replay-message-34");
  assert.ok(
    recoveries[0]?.messages.every(
      (message) => message.deliveryMode === "catchup",
    ),
  );

  port.deliver({
    jsonrpc: "2.0",
    method: "malink.events.deliver",
    params: {
      subscriptionId: "subscription-1",
      events: [{
        schemaVersion: 1,
        eventId: "live-event-1",
        cursor: "live-cursor-1",
        occurredAt: 100,
        type: "message.upserted",
        payload: {
          eventId: "live-message-1",
          sender: "gateway",
          timestamp: 100,
          encrypted: true,
          kind: "agent",
          text: "live",
          sessionId: "session-catchup",
          format: "plain",
        },
      }],
    },
  });
  await nextTurn();

  assert.deepEqual(liveMessages, [{
    eventId: "live-message-1",
    deliveryMode: "live",
  }]);

  port.deliver({
    jsonrpc: "2.0",
    method: "malink.events.deliver",
    params: {
      subscriptionId: "subscription-1",
      events: [{
        schemaVersion: 1,
        eventId: "status-offline-1",
        cursor: "status-offline-cursor-1",
        occurredAt: 200,
        type: "client.status.changed",
        payload: { phase: "offline", detail: "network_unavailable" },
      }],
    },
  });
  port.deliver({
    jsonrpc: "2.0",
    method: "malink.events.deliver",
    params: {
      subscriptionId: "subscription-1",
      events: [{
        schemaVersion: 1,
        eventId: "status-ready-1",
        cursor: "status-ready-cursor-1",
        occurredAt: 201,
        type: "client.status.changed",
        payload: { phase: "ready" },
      }, ...replayEvents.map((event, index) => ({
        ...event,
        eventId: `network-catchup-event-${index}`,
        cursor: `network-catchup-cursor-${index}`,
        occurredAt: 202 + index,
        payload: {
          ...event.payload,
          eventId: `network-catchup-message-${index}`,
          timestamp: 202 + index,
        },
      }))],
    },
  });
  await nextTurn();

  assert.equal(recoveries.length, 1);
  assert.equal(liveMessages.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(recoveries.length, 2);
  assert.equal(recoveries[1]?.messages.length, 30);
  assert.equal(
    recoveries[1]?.messages[0]?.eventId,
    "network-catchup-message-5",
  );
  assert.ok(
    recoveries[1]?.messages.every(
      (message) => message.deliveryMode === "catchup",
    ),
  );

  port.deliver({
    jsonrpc: "2.0",
    method: "malink.events.deliver",
    params: {
      subscriptionId: "subscription-1",
      events: [{
        schemaVersion: 1,
        eventId: "live-event-2",
        cursor: "live-cursor-2",
        occurredAt: 300,
        type: "message.upserted",
        payload: {
          eventId: "live-message-2",
          sender: "gateway",
          timestamp: 300,
          encrypted: true,
          kind: "agent",
          text: "live again",
          sessionId: "session-catchup",
          format: "plain",
        },
      }],
    },
  });
  await nextTurn();
  assert.deepEqual(liveMessages.at(-1), {
    eventId: "live-message-2",
    deliveryMode: "live",
  });
  client.dispose();
});

test("keeps native local projection reads separate from Matrix pagination", async () => {
  const historySources: string[] = [];
  const port = new RuntimePort((request) => {
    if (request.method !== "malink.history.page") return responseFor(request);
    const params = request.params as BridgeMethodParams["malink.history.page"];
    historySources.push(params.source);
    return {
      sessionId: params.sessionId,
      messages: params.source === "local" ? [{
        eventId: "native-local-history-1",
        sender: "gateway",
        timestamp: 1,
        encrypted: true,
        kind: "agent",
        text: "Restored immediately",
        sessionId: params.sessionId,
        historical: true,
        format: "markdown",
      }] : [],
      hasMore: false,
      asOfCursor: `cursor-${params.source}`,
    };
  });
  const client = await createTestClient(port);

  const initial = await client.loadLocalHistory("session-history-1");
  assert.deepEqual(initial.messages.map((message) => message.eventId), [
    "native-local-history-1",
  ]);
  assert.equal(initial.hasMore, false);
  assert.deepEqual(historySources, ["local"]);

  const older = await client.loadHistoryPage("session-history-1");
  assert.deepEqual(older.messages, []);
  assert.equal(older.hasMore, false);
  assert.deepEqual(historySources, ["local", "matrix"]);

  await client.loadHistoryPage("session-history-2");
  assert.deepEqual(historySources, ["local", "matrix", "matrix"]);
  client.dispose();
});

test("identifies a terminal native session creation for orphaned UI recovery", async () => {
  const recovered: string[] = [];
  const bridgePort = new RuntimePort();
  const bridge = await acquireNativeRpcBridge(bridgePort);
  const hello = await bridge.hello({
    webBuild: "test-build",
    requiredCapabilities: [],
    optionalCapabilities: REQUIRED_NATIVE_CAPABILITIES.map((name) => ({
      name,
      versions: nativeCapabilityVersions(name),
    })),
  });
  const client = new NativeBridgeClient(bridge, hello, {
    onMessage() {},
    onStatus() {},
    onSessionCreateRecovered(recovery) {
      recovered.push(
        `${recovery.commandId}:${recovery.completion.sessionId}:${recovery.submittedAt}`,
      );
    },
  });
  await client.ready;

  deliverCommand(bridgePort, {
    operationId: "operation-create-orphaned",
    commandId: "command-create-orphaned",
    idempotencyKey: "00000000-0000-4000-8000-000000000021",
    state: "succeeded",
    submittedAt: 42,
    updatedAt: 45,
    sequence: 1,
    revision: 0,
    completion: {
      commandId: "command-create-orphaned",
      sequence: 1,
      revision: 0,
      outcome: "succeeded",
      sessionId: "session-created-orphaned",
    },
  }, "cursor-create-orphaned");
  await nextTurn();

  assert.deepEqual(recovered, [
    "command-create-orphaned:session-created-orphaned:42",
  ]);
  client.dispose();
});

test("reports durable commands restored from the native startup snapshot", async () => {
  const recovered: string[] = [];
  const port = new RuntimePort((request) => {
    if (request.method === "malink.client.start") {
      return {
        deviceId: "native-device-1",
        snapshot: {
          ...snapshot(),
          commands: [{
            operationId: "operation-interrupted-archive",
            commandId: "command-interrupted-archive",
            idempotencyKey: "00000000-0000-4000-8000-000000000031",
            state: "recovery_required",
            submittedAt: 31,
            updatedAt: 32,
            sessionId: "session-archive-1",
            sequence: 1,
            revision: 0,
          }],
        },
      };
    }
    return responseFor(request);
  });
  const bridge = await acquireNativeRpcBridge(port);
  const hello = await bridge.hello({
    webBuild: "test-build",
    requiredCapabilities: [],
    optionalCapabilities: REQUIRED_NATIVE_CAPABILITIES.map((name) => ({
      name,
      versions: nativeCapabilityVersions(name),
    })),
  });
  const client = new NativeBridgeClient(bridge, hello, {
    onMessage() {},
    onStatus() {},
    onDurableCommandRecovered(command) {
      recovered.push(
        `${command.commandId}:${command.state}:${command.sessionId}:${command.submittedAt}:${command.updatedAt}`,
      );
    },
  });
  await client.ready;

  assert.deepEqual(recovered, [
    "command-interrupted-archive:recovery_required:session-archive-1:31:32",
  ]);
  client.dispose();
});

test("projects Android native Gateway Directory ownership into the hosted UI", async () => {
  const gatewayState = nativeGatewayDirectoryState();
  let projectedGatewayState: Parameters<
    NonNullable<ConstructorParameters<typeof NativeBridgeClient>[2]["onCollaborationState"]>
  >[0]["gatewayState"] | undefined;
  const port = new RuntimePort((request) => {
    if (request.method === "malink.client.start") {
      return {
        deviceId: "native-device-1",
        snapshot: snapshot(gatewayState),
      };
    }
    return responseFor(request);
  });
  const bridge = await acquireNativeRpcBridge(port);
  const hello = await bridge.hello({
    webBuild: "test-build",
    requiredCapabilities: [],
    optionalCapabilities: REQUIRED_NATIVE_CAPABILITIES.map((name) => ({
      name,
      versions: nativeCapabilityVersions(name),
    })),
  });
  const client = new NativeBridgeClient(bridge, hello, {
    onMessage() {},
    onStatus() {},
    onCollaborationState(state) {
      projectedGatewayState = state.gatewayState;
    },
  });
  await client.ready;

  assert.ok(projectedGatewayState?.gatewayDirectory);
  const owners = gatewayProjectOwners(
    projectedGatewayState.gatewayDirectory.directory.gateways,
  );
  assert.deepEqual(owners.get("project-phone"), {
    gatewayNodeId: "gateway-home",
    gatewayName: "Home Gateway",
    computerName: "home-mac",
    shortId: "EWAYHOME",
    label: "Home Gateway · home-mac",
  });
  client.dispose();
});

test("hydrates and publishes Matrix session read receipts through the native bridge", async () => {
  const reads: Array<{ sessionId: string; readUpdatedAt: number }> = [];
  const port = new RuntimePort((request) => {
    if (request.method === "malink.client.start") {
      return {
        deviceId: "native-device-1",
        snapshot: { ...snapshot(), sessionReadState: { "session-1": 40 } },
      };
    }
    return responseFor(request);
  });
  const bridge = await acquireNativeRpcBridge(port);
  const hello = await bridge.hello({
    webBuild: "test-build",
    requiredCapabilities: [],
    optionalCapabilities: [
      ...REQUIRED_NATIVE_CAPABILITIES,
      ...OPTIONAL_NATIVE_CAPABILITIES,
    ].map((name) => ({ name, versions: nativeCapabilityVersions(name) })),
  });
  const client = new NativeBridgeClient(bridge, hello, {
    onMessage() {},
    onStatus() {},
    onSessionRead(update) {
      reads.push(update);
    },
  });
  await client.ready;
  await client.markSessionRead("session-1", "project-1");

  assert.deepEqual(reads, [
    { sessionId: "session-1", readUpdatedAt: 40 },
    { sessionId: "session-1", projectId: "project-1", readUpdatedAt: 42 },
  ]);
  client.dispose();
});

test("keeps the durable receipt identity while Gateway progress arrives", async () => {
  const port = new RuntimePort((request) => {
    if (request.method !== "malink.command.send") return responseFor(request);
    const params = request.params as BridgeMethodParams["malink.command.send"];
    return {
      operationId: "operation-stable-1",
      commandId: "command-stable-1",
      idempotencyKey: params.idempotencyKey,
      state: "transmitting",
      submittedAt: 1,
      updatedAt: 1,
      sequence: 2,
    };
  });
  const client = await createTestClient(port);
  const pending = client.send({
    operation: "session.delete",
    sessionId: "session-delete-1",
  });
  await nextTurn();
  const sent = await pending;
  assert.equal(sent.commandId, "command-stable-1");
  assert.equal(sent.revision, 0);
  deliverCommand(port, {
    operationId: "operation-stable-1",
    commandId: "command-stable-1",
    idempotencyKey: "00000000-0000-4000-8000-000000000002",
    state: "running",
    submittedAt: 1,
    updatedAt: 3,
    sequence: 2,
    revision: 8,
  }, "cursor-stable-progress");
  deliverCommand(port, {
    operationId: "operation-stable-1",
    commandId: "command-stable-1",
    idempotencyKey: "00000000-0000-4000-8000-000000000002",
    state: "succeeded",
    submittedAt: 1,
    updatedAt: 4,
    sequence: 2,
    revision: 8,
    completion: {
      commandId: "command-stable-1",
      sequence: 2,
      revision: 8,
      outcome: "succeeded",
      sessionId: "session-delete-1",
    },
  }, "cursor-stable-result");
  assert.equal((await sent.completion).sessionId, "session-delete-1");
  client.dispose();
});

test("projects durable command state changes into the active PWA", async () => {
  const changes: MalinkRecoveredDurableCommand[] = [];
  const port = new RuntimePort();
  const client = await createTestClient(port, () => {}, (command) => {
    changes.push(command);
  });

  deliverCommand(port, {
    operationId: "operation-recovery-state-1",
    commandId: "command-recovery-state-1",
    idempotencyKey: "00000000-0000-4000-8000-000000000013",
    state: "recovery_required",
    submittedAt: 10,
    updatedAt: 20,
    sessionId: "session-recovery-state-1",
    sequence: 1,
  }, "cursor-recovery-state");
  await nextTurn();

  assert.deepEqual(changes, [{
    commandId: "command-recovery-state-1",
    state: "recovery_required",
    submittedAt: 10,
    updatedAt: 20,
    sessionId: "session-recovery-state-1",
  }]);
  client.dispose();
});

test("rebinds a retried command completion even when the event precedes its receipt", async () => {
  const port = new RuntimePort((request) =>
    request.method === "malink.command.send" ? NO_RESPONSE : responseFor(request)
  );
  const commandResults: string[] = [];
  const bridge = await acquireNativeRpcBridge(port);
  const hello = await bridge.hello({
    webBuild: "test-build",
    requiredCapabilities: [],
    optionalCapabilities: REQUIRED_NATIVE_CAPABILITIES.map((name) => ({
      name,
      versions: nativeCapabilityVersions(name),
    })),
  });
  const client = new NativeBridgeClient(bridge, hello, {
    onMessage() {},
    onStatus() {},
    onCommandResult(result) {
      commandResults.push(result.commandId);
    },
  });
  await client.ready;

  const sending = client.send({
    operation: "session.delete",
    sessionId: "session-rebased-1",
  });
  await nextTurn();
  const request = port.requests.find(
    (candidate) => candidate.method === "malink.command.send",
  );
  assert.ok(request);
  const params = request.params as BridgeMethodParams["malink.command.send"];
  const receipt = {
    operationId: "operation-rebased-1",
    commandId: "command-original-1",
    idempotencyKey: params.idempotencyKey,
    state: "transmitting" as const,
    submittedAt: 1,
    updatedAt: 1,
    sequence: 4,
  };
  deliverCommand(port, {
    ...receipt,
    commandId: "command-rebased-1",
    state: "succeeded",
    updatedAt: 3,
    revision: 9,
    completion: {
      commandId: "command-rebased-1",
      sequence: 4,
      revision: 9,
      outcome: "succeeded",
      sessionId: "session-rebased-1",
    },
  }, "cursor-rebased-before-receipt");
  await nextTurn();
  port.respond(request, receipt);

  const sent = await sending;
  assert.equal(sent.commandId, "command-original-1");
  assert.deepEqual(await sent.completion, {
    commandId: "command-original-1",
    sequence: 4,
    revision: 9,
    outcome: "succeeded",
    sessionId: "session-rebased-1",
  });
  assert.deepEqual(commandResults, ["command-rebased-1"]);
  client.dispose();
});

test("does not serialize independent native commands behind a Gateway ack lane", async () => {
  let next = 0;
  const port = new RuntimePort((request) => {
    if (request.method !== "malink.command.send") return responseFor(request);
    const params = request.params as BridgeMethodParams["malink.command.send"];
    next += 1;
    return {
      operationId: `operation-independent-${next}`,
      commandId: `command-independent-${next}`,
      idempotencyKey: params.idempotencyKey,
      state: "transmitting",
      submittedAt: 1,
      updatedAt: 1,
      sequence: 1,
    };
  });
  const client = await createTestClient(port);
  const [first, second] = await Promise.all([
    client.send({ operation: "prompt", sessionId: "session-1", text: "one" }),
    client.send({ operation: "prompt", sessionId: "session-2", text: "two" }),
  ]);

  assert.equal(first.commandId, "command-independent-1");
  assert.equal(second.commandId, "command-independent-2");
  deliverCommand(port, {
    operationId: "operation-independent-1",
    commandId: "command-independent-1",
    idempotencyKey: "00000000-0000-4000-8000-000000000011",
    state: "succeeded",
    submittedAt: 1,
    updatedAt: 2,
    sequence: 1,
    revision: 0,
    completion: {
      commandId: "command-independent-1",
      sequence: 1,
      revision: 0,
      outcome: "succeeded",
    },
  }, "cursor-independent-1");
  deliverCommand(port, {
    operationId: "operation-independent-2",
    commandId: "command-independent-2",
    idempotencyKey: "00000000-0000-4000-8000-000000000012",
    state: "succeeded",
    submittedAt: 1,
    updatedAt: 2,
    sequence: 1,
    revision: 0,
    completion: {
      commandId: "command-independent-2",
      sequence: 1,
      revision: 0,
      outcome: "succeeded",
    },
  }, "cursor-independent-2");
  await Promise.all([first.completion, second.completion]);
  client.dispose();
});

test("waits for transient outbox recovery with one idempotency key", async () => {
  let attempts = 0;
  const port = new RuntimePort((request) => {
    if (request.method !== "malink.command.send") return responseFor(request);
    attempts += 1;
    if (attempts === 1) {
      throw new BridgeProtocolError(
        "INVALID_STATE",
        "Malink is restoring the previous queued action.",
        {
          retryable: true,
          retryAfterMs: 1,
          userAction: "retry",
          details: {
            kind: "command_blocked",
            commandId: "command-blocking-1",
            state: "recovery_required",
            operation: "prompt",
          },
        },
      );
    }
    const params = request.params as BridgeMethodParams["malink.command.send"];
    return {
      operationId: "operation-after-recovery-1",
      commandId: "command-after-recovery-1",
      idempotencyKey: params.idempotencyKey,
      state: "accepted",
      submittedAt: 2,
      updatedAt: 2,
      sequence: 3,
      revision: 9,
    };
  });
  const client = await createTestClient(port);
  const sent = await client.send({ operation: "session.create" });
  assert.equal(
    sent.sessionId,
    sent.commandId,
    "native MLP/3 creation exposes its preallocated session identity immediately",
  );
  const sends = port.requests.filter((request) => request.method === "malink.command.send");
  assert.equal(sends.length, 2);
  assert.equal(
    (sends[0]!.params as BridgeMethodParams["malink.command.send"]).idempotencyKey,
    (sends[1]!.params as BridgeMethodParams["malink.command.send"]).idempotencyKey,
  );
  deliverCommand(port, {
    operationId: sent.operationId,
    commandId: sent.commandId,
    idempotencyKey:
      (sends[1]!.params as BridgeMethodParams["malink.command.send"]).idempotencyKey,
    state: "succeeded",
    submittedAt: 2,
    updatedAt: 3,
    sequence: sent.sequence,
    revision: sent.revision,
    completion: {
      commandId: sent.commandId,
      sequence: sent.sequence,
      revision: sent.revision,
      outcome: "succeeded",
    },
  }, "cursor-recovered-result");
  await sent.completion;
  client.dispose();
});

test("hydrates a completed recovered command when its terminal event preceded the WebView", async () => {
  const completion = {
    commandId: "command-completed-before-webview",
    sequence: 7,
    revision: 19,
    outcome: "succeeded" as const,
    sessionId: "session-created-before-webview",
  };
  const port = new RuntimePort((request) => {
    if (request.method === "malink.command.recover") {
      return {
        operationId: "operation-completed-before-webview",
        commandId: completion.commandId,
        idempotencyKey: "00000000-0000-4000-8000-000000000007",
        state: "succeeded",
        submittedAt: 1,
        updatedAt: 3,
        sequence: completion.sequence,
        revision: completion.revision,
      };
    }
    if (request.method === "malink.command.get") {
      return {
        operationId: "operation-completed-before-webview",
        commandId: completion.commandId,
        idempotencyKey: "00000000-0000-4000-8000-000000000007",
        state: "succeeded",
        submittedAt: 1,
        updatedAt: 3,
        sequence: completion.sequence,
        revision: completion.revision,
        completion,
      };
    }
    return responseFor(request);
  });
  const client = await createTestClient(port);

  const recovered = await client.recoverCommand(completion.commandId);

  assert.deepEqual(await recovered.completion, completion);
  assert.deepEqual(
    port.requests
      .filter((request) => request.method.startsWith("malink.command."))
      .map((request) => request.method),
    ["malink.command.recover", "malink.command.get"],
  );
  client.dispose();
});

test("detaching the WebView waiter does not cancel a native-confirmed pairing", async () => {
  const port = new RuntimePort((request) => {
    if (request.method === "malink.pairing.inspect") {
      return {
        pairingId: "pairing-one",
        gatewayId: "gateway-one",
        gatewayName: "Gateway",
        verificationCode: "123 456",
        expiresAt: Date.now() + 60_000,
        requiresNativeConfirmation: true,
      };
    }
    if (request.method === "malink.pairing.complete") {
      return NO_RESPONSE;
    }
    return responseFor(request);
  });
  const client = await createTestClient(port);
  const abort = new AbortController();
  const pairing = client.pair("malink://pair?data=fixture", "Phone", abort.signal);
  await nextTurn();

  abort.abort();

  await assert.rejects(pairing, (error) =>
    error instanceof DOMException && error.name === "AbortError"
  );
  assert.equal(
    port.requests.some((request) => request.method === "malink.pairing.cancel"),
    false,
  );
  client.dispose();
});

test("surfaces a review-required project creation blocker immediately", async () => {
  const reviews: string[] = [];
  const port = new RuntimePort((request) => {
    if (request.method !== "malink.command.send") return responseFor(request);
    throw new BridgeProtocolError(
      "INVALID_STATE",
      "The previous Malink action needs review before another action can start.",
      {
        details: {
          kind: "command_blocked",
          commandId: "command-review-1",
          state: "needs_review",
          operation: "project.create",
          expectedRevision: 12,
        },
      },
    );
  });
  const client = await createTestClient(port, (review) => {
    if (review) {
      reviews.push(
        `${review.commandId}:${review.operation}:${review.expectedRevision}`,
      );
    }
  });
  await assert.rejects(
    client.send({
      operation: "project.create",
      name: "New project",
      cwd: "/workspace/new-project",
    }),
    (error) => error instanceof CommandReviewRequiredError &&
      error.review.commandId === "command-review-1" &&
      error.review.operation === "project.create" &&
      error.review.expectedRevision === 12,
  );
  assert.deepEqual(reviews, ["command-review-1:project.create:12"]);
  client.dispose();
});

test("clears a startup review after native safely resumes the operation", async () => {
  const changes: Array<string | null> = [];
  const port = new RuntimePort();
  const client = await createTestClient(port, (review) => {
    changes.push(review?.commandId ?? null);
  });
  const common = {
    operationId: "operation-startup-review-1",
    idempotencyKey: "00000000-0000-4000-8000-000000000004",
    submittedAt: 1,
    sequence: 4,
  };
  deliverCommand(port, {
    ...common,
    commandId: "command-startup-review-1",
    state: "needs_review",
    updatedAt: 2,
  }, "cursor-startup-review");
  deliverCommand(port, {
    ...common,
    commandId: "command-startup-rebased-1",
    state: "queued",
    updatedAt: 3,
  }, "cursor-startup-rebased");
  await nextTurn();
  assert.deepEqual(changes, ["command-startup-review-1", null]);
  client.dispose();
});

test("recovers structured tool cards from older native agent messages", async () => {
  const messages: Array<Record<string, unknown>> = [];
  const port = new RuntimePort();
  const bridge = await acquireNativeRpcBridge(port);
  const hello = await bridge.hello({
    webBuild: "test-build",
    requiredCapabilities: [],
    optionalCapabilities: REQUIRED_NATIVE_CAPABILITIES.map((name) => ({
      name,
      versions: nativeCapabilityVersions(name),
    })),
  });
  const client = new NativeBridgeClient(bridge, hello, {
    onMessage(message) {
      messages.push(message as unknown as Record<string, unknown>);
    },
    onStatus() {},
  });
  await client.ready;

  port.deliver({
    jsonrpc: "2.0",
    method: "malink.events.deliver",
    params: {
      subscriptionId: "subscription-1",
      events: [{
        schemaVersion: 1,
        eventId: "event-old-native-tool-1",
        cursor: "cursor-old-native-tool-1",
        occurredAt: 10,
        type: "message.upserted",
        payload: {
          eventId: "assistant:tool-message-1:0",
          sender: "gateway-1",
          timestamp: 10,
          encrypted: true,
          kind: "agent",
          text: "Bash",
          sessionId: "session-1",
          format: "plain",
          semantic: {
            type: "assistant.message",
            messageId: "tool-message-1",
            messageVersion: 1,
            ui: {
              kind: "tool_group",
              version: 1,
              groupId: "bash-1",
              tools: [{
                id: "bash-1",
                name: "Bash",
                title: "Bash",
                detail: "pnpm test",
                category: "execute",
                phase: "completed",
                isError: false,
                startedAt: 1,
                updatedAt: 10,
              }],
            },
          },
        },
      }],
    },
  });
  await nextTurn();

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, "tool");
  assert.deepEqual(messages[0].toolGroup, {
    kind: "tool_group",
    version: 1,
    groupId: "bash-1",
    tools: [{
      id: "bash-1",
      name: "Bash",
      title: "Bash",
      detail: "pnpm test",
      category: "execute",
      phase: "completed",
      isError: false,
      startedAt: 1,
      updatedAt: 10,
    }],
  });
  client.dispose();
});

test("does not expire native Gateway update commands while Agent work is active", async () => {
  const port = new RuntimePort();
  const client = await createTestClient(port);
  const originalSetTimeout = globalThis.setTimeout;
  const scheduledDelays: number[] = [];
  globalThis.setTimeout = ((handler, timeout, ...args) => {
    scheduledDelays.push(Number(timeout));
    return originalSetTimeout(handler, timeout, ...args);
  }) as typeof globalThis.setTimeout;
  try {
    const sent = await client.send({
      operation: "gateway.update.apply",
      releaseId: "release-2",
      mode: "when_idle",
    });
    void sent.completion.catch(() => undefined);
    assert.equal(scheduledDelays.includes(24 * 60 * 60_000), false);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    client.dispose();
  }
});

test("checks the static APK channel and installs a verified release", async () => {
  const port = new RuntimePort();
  const client = await createTestClient(port);

  assert.equal((await client.nativeUpdateStatus()).phase, "ready");
  assert.equal((await client.checkNativeUpdate()).phase, "checking");
  assert.equal((await client.installNativeUpdate()).phase, "installing");
  const check = port.requests.find((request) => request.method === "malink.update.check");
  assert.match(
    (check?.params as BridgeMethodParams["malink.update.check"]).idempotencyKey,
    /^[0-9a-f-]{36}$/,
  );
  const install = port.requests.find((request) => request.method === "malink.update.install");
  assert.match(
    (install?.params as BridgeMethodParams["malink.update.install"]).idempotencyKey,
    /^[0-9a-f-]{36}$/,
  );
  client.dispose();
});

test("opens the Android diagnostic share surface when negotiated", async () => {
  const port = new RuntimePort();
  const client = await createTestClient(port);

  assert.equal(await client.exportDiagnostics(), true);
  assert.ok(port.requests.some(request => request.method === "malink.diagnostics.export"));
  client.dispose();
});

async function createTestClient(
  port: RuntimePort,
  onReview: (review: MalinkCommandReview | null) => void = () => {},
  onCommandChanged: (command: MalinkRecoveredDurableCommand) => void = () => {},
): Promise<NativeBridgeClient> {
  const bridge = await acquireNativeRpcBridge(port);
  const hello = await bridge.hello({
    webBuild: "test-build",
    requiredCapabilities: [],
    optionalCapabilities: [
      ...REQUIRED_NATIVE_CAPABILITIES,
      ...OPTIONAL_NATIVE_CAPABILITIES,
    ].map((name) => ({
      name,
      versions: nativeCapabilityVersions(name),
    })),
  });
  const client = new NativeBridgeClient(bridge, hello, {
    onMessage() {},
    onStatus() {},
    onCommandReviewRequired: onReview,
    onDurableCommandChanged: onCommandChanged,
  });
  await client.ready;
  return client;
}

function deliverCommand(
  port: RuntimePort,
  payload: Record<string, unknown>,
  cursor: string,
): void {
  port.deliver({
    jsonrpc: "2.0",
    method: "malink.events.deliver",
    params: {
      subscriptionId: "subscription-1",
      events: [{
        schemaVersion: 1,
        eventId: `event-${cursor}`,
        cursor,
        occurredAt: Date.now(),
        type: "command.changed",
        payload,
      }],
    },
  });
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function responseFor(request: Request): unknown {
  switch (request.method) {
    case "malink.bridge.hello":
      return helloResult();
    case "malink.client.start":
      return { deviceId: "native-device-1", snapshot: snapshot() };
    case "malink.events.subscribe":
      return {
        subscriptionId: "subscription-1",
        barrierCursor: "cursor-barrier-1",
        mode: "replay",
        events: [],
      };
    case "malink.events.activate":
    case "malink.events.ack":
      return {
        subscriptionId: "subscription-1",
        throughCursor:
          request.method === "malink.events.ack"
            ? "cursor-event-2"
            : "cursor-barrier-1",
      };
    case "malink.events.unsubscribe":
      return { subscriptionId: "subscription-1", unsubscribed: true };
    case "malink.command.send": {
      const params = request.params as BridgeMethodParams["malink.command.send"];
      return {
        operationId: "operation-1",
        commandId: "command-1",
        idempotencyKey: params.idempotencyKey,
        state: "transmitting",
        submittedAt: 1,
        updatedAt: 1,
        sessionId: "s1",
        sequence: 1,
      };
    }
    case "malink.session.markRead": {
      const params = request.params as BridgeMethodParams["malink.session.markRead"];
      return {
        sessionId: params.sessionId,
        ...(params.projectId ? { projectId: params.projectId } : {}),
        readUpdatedAt: 42,
      };
    }
    case "malink.matrix.loginToken":
      return {
        status: "ready",
        loginToken: "single-use-token",
        expiresAt: 120_000,
      };
    case "malink.update.status":
      return nativeUpdateStatus("ready");
    case "malink.update.check":
      return nativeUpdateStatus("checking");
    case "malink.update.install":
      return nativeUpdateStatus("installing");
    case "malink.diagnostics.export":
      return {
        status: "share_opened",
        filename: "malink-native-diagnostics.txt",
      };
    case "malink.client.disconnect": {
      const params = request.params as BridgeMethodParams["malink.client.disconnect"];
      return { mode: params.mode, snapshot: snapshot() };
    }
    case "malink.command.retire": {
      const params = request.params as BridgeMethodParams["malink.command.retire"];
      return { commandId: params.commandId, retired: true };
    }
    default:
      throw new Error(`Unexpected native method in test: ${request.method}`);
  }
}

function nativeUpdateStatus(phase: "checking" | "ready" | "installing") {
  return {
    phase,
    currentVersionCode: 41,
    currentVersionName: "0.1.0-alpha.41",
    latestVersionCode: 42,
    latestVersionName: "0.1.0-alpha.42",
    buildId: "android-alpha-42",
    totalBytes: 1_000,
    checkedAt: 1_787_400_000_000,
  };
}

function helloResult(): HelloResult {
  const capabilities = Object.fromEntries(
    [...REQUIRED_NATIVE_CAPABILITIES, ...OPTIONAL_NATIVE_CAPABILITIES]
      .map((name) => [name, { version: nativeCapabilityVersions(name)[0] }]),
  ) as Record<CapabilityName, { version: number }>;
  return {
    protocolVersion: 1,
    bridgeSessionId: "bridge-session-native-1",
    native: {
      runtimeVersion: "0.1.0",
      runtimeBuild: "android-test",
      platform: "android",
    },
    capabilities,
    limits: NATIVE_BRIDGE_LIMITS,
  };
}

function snapshot(gatewayState?: ClientSnapshot["gatewayState"]): ClientSnapshot {
  return {
    schemaVersion: 1,
    deviceId: "native-device-1",
    cursor: "cursor-snapshot-1",
    generatedAt: 1,
    lifecycle: { phase: "ready", since: 1 },
    foregroundService: {
      required: true,
      active: true,
      notificationVisible: true,
    },
    trust: { state: "unpaired" },
    ...(gatewayState ? { gatewayState } : {}),
    commands: [],
  };
}

function nativeGatewayDirectoryState(): NonNullable<ClientSnapshot["gatewayState"]> {
  const keyId = "A".repeat(43);
  return gatewayStateExtension({
    stateVersion: 1,
    revision: 0,
    revisionEpoch: "matrix-native-v3",
    revisionEpochGeneration: 1,
    activeDeviceCount: 1,
    updatedAt: 1,
    currentSessionId: null,
    sessions: [],
    workspace: {
      projectId: "project-phone",
      projectName: "Malink",
      cwd: "/workspace/malink",
      provider: "agent",
      permissionMode: "default",
    },
    projects: [{
      projectId: "project-phone",
      projectName: "Malink",
      cwd: "/workspace/malink",
      provider: "agent",
      permissionMode: "default",
    }],
    capabilities: {
      models: [],
      providers: [],
      permissionModes: [],
      canCreateSession: true,
      canSelectSession: true,
      sessionExtensions: [],
    },
    gatewayDirectory: {
      directory: {
        kind: "malink.workspace.gateway-directory",
        version: 1,
        directoryId: "directory-1",
        workspaceId: "workspace-1",
        revision: 1,
        gateways: [{
          gatewayNodeId: "gateway-home",
          workspaceId: "workspace-1",
          gatewayName: "Home Gateway",
          computerName: "home-mac",
          transport: {
            homeserver: "https://matrix.example.test",
            roomId: "!project-phone:example.test",
            userId: "@gateway:example.test",
            deviceId: "GATEWAYHOME",
            ed25519: "gateway-ed25519-key",
          },
          publicKey: {
            version: 1,
            algorithm: "ES256",
            keyId,
            publicKey: {
              kty: "EC",
              crv: "P-256",
              x: keyId,
              y: keyId,
            },
          },
          projects: [{
            projectId: "project-phone",
            roomId: "!project-phone:example.test",
            conversationId: "conversation-phone",
          }],
          issuedAt: 1,
        }],
        issuedAt: 1,
      },
      signature: {
        algorithm: "ES256",
        keyId,
        value: "signature",
      },
    },
  }) as NonNullable<ClientSnapshot["gatewayState"]>;
}
