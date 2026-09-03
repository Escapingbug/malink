import { describe, expect, it } from "vitest";
import {
  BridgeProtocolError,
  MUTATION_METHODS,
  NATIVE_BRIDGE_LIMITS,
  RPC_ERROR_NUMBERS,
  failureResponse,
  negotiateHello,
  isMutationMethod,
  parseEventsDeliverNotification,
  parseHelloParams,
  parseHelloResult,
  parseMethodRpcResponse,
  parseRpcError,
  parseRpcRequest,
  parseRpcResponse,
} from "../src/index.js";

const context = { bridgeSessionId: "bridge-session-1" };
const idempotencyKey = "550e8400-e29b-41d4-a716-446655440000";
const webInstanceId = "550e8400-e29b-41d4-a716-446655440001";

function request(method: string, params: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id: "request-1",
    method,
    params,
  };
}

function response(result: unknown, id = "request-1") {
  return { jsonrpc: "2.0", id, result };
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    deviceId: "native-device-1",
    cursor: "journal-1:42",
    generatedAt: 1_722_000_000_000,
    lifecycle: { phase: "ready", since: 1_721_999_999_000 },
    foregroundService: {
      required: true,
      active: true,
      notificationVisible: true,
    },
    trust: { state: "unpaired" },
    commands: [],
    ...overrides,
  };
}

describe("native bridge JSON-RPC conformance", () => {
  it("strictly parses a version and capability hello", () => {
    const parsed = parseRpcRequest(
      request("malink.bridge.hello", {
        application: "malink-web",
        webBuild: "42cdc51",
        webInstanceId,
        supportedProtocolVersions: [1],
        requiredCapabilities: [
          { name: "commands.durable", versions: [1] },
          { name: "background.foreground-service", versions: [1] },
        ],
        optionalCapabilities: [{ name: "attachments.binary-port", versions: [1] }],
      }),
    );

    expect(parsed.method).toBe("malink.bridge.hello");
    expect(parsed.params.supportedProtocolVersions).toEqual([1]);
  });

  it("rejects unknown hello fields and duplicate capability versions", () => {
    expect(() =>
      parseHelloParams({
        application: "malink-web",
        webBuild: "build",
        webInstanceId,
        supportedProtocolVersions: [1],
        requiredCapabilities: [
          { name: "commands.durable", versions: [1, 1] },
        ],
        optionalCapabilities: [],
        powerSavingMode: true,
      }),
    ).toThrow(BridgeProtocolError);
  });

  it("selects the highest shared versions and fails closed on required capabilities", () => {
    const hello = parseHelloParams({
      application: "malink-web",
      webBuild: "build",
      webInstanceId,
      supportedProtocolVersions: [1, 2],
      requiredCapabilities: [{ name: "commands.durable", versions: [1, 2] }],
      optionalCapabilities: [
        { name: "attachments.chunked", versions: [1] },
        { name: "future.optional", versions: [1] },
      ],
    });
    const support = {
      protocolVersions: [1] as const,
      native: {
        runtimeVersion: "1.0.0",
        runtimeBuild: "android-1",
        platform: "android" as const,
      },
      capabilities: {
        "commands.durable": { versions: [1] },
        "attachments.chunked": {
          versions: [1],
          options: { chunkBytes: 262_144 },
        },
      },
    };

    const result = negotiateHello(hello, support, "bridge-session-1");
    expect(result.protocolVersion).toBe(1);
    expect(result.capabilities).toEqual({
      "commands.durable": { version: 1 },
      "attachments.chunked": {
        version: 1,
        options: { chunkBytes: 262_144 },
      },
    });

    expect(() =>
      negotiateHello(
        { ...hello, requiredCapabilities: [{ name: "trust.native", versions: [1] }] },
        support,
        "bridge-session-1",
      ),
    ).toThrowError(expect.objectContaining({
      errorCode: "CAPABILITY_UNAVAILABLE",
    }));
  });

  it("strictly parses native hello and JSON-RPC responses", () => {
    const result = parseHelloResult({
      protocolVersion: 1,
      bridgeSessionId: "bridge-session-1",
      native: {
        runtimeVersion: "0.1.0",
        runtimeBuild: "android-debug",
        platform: "android",
      },
      capabilities: {
        "background.foreground-service": { version: 1 },
      },
      limits: NATIVE_BRIDGE_LIMITS,
    });
    expect(result.native.platform).toBe("android");
    expect(parseRpcResponse({
      jsonrpc: "2.0",
      id: "request-1",
      result,
    })).toMatchObject({ id: "request-1", result });
    expect(() => parseRpcResponse({
      jsonrpc: "2.0",
      id: "request-1",
      result: {},
      error: { code: -32603, message: "ambiguous", data: {} },
    })).toThrow(/exactly one/);
  });

  it("strictly parses a device-bound start snapshot and correlates response ids", () => {
    const parsed = parseMethodRpcResponse(
      "malink.client.start",
      response({ deviceId: "native-device-1", snapshot: snapshot() }),
      { expectedId: "request-1" },
    );
    expect("result" in parsed && parsed.result.deviceId).toBe("native-device-1");

    expect(() =>
      parseMethodRpcResponse(
        "malink.client.start",
        response({ deviceId: "other-device", snapshot: snapshot() }),
      ),
    ).toThrow(/must match snapshot/);
    expect(() =>
      parseMethodRpcResponse(
        "malink.client.snapshot",
        response(snapshot(), "response-for-another-request"),
        { expectedId: "request-1" },
      ),
    ).toThrow(/does not match/);
  });

  it("bootstraps a public Matrix session only with a one-time login token", () => {
    const roomBinding = {
      roomId: "!room:matrix.example",
      gatewayId: "gateway-1",
      conversationId: "conversation-1",
      gatewayUserId: "@gateway:matrix.example",
      gatewayDeviceId: "GATEWAYDEVICE",
      gatewayDeviceEd25519: "a".repeat(43),
    };
    const parsed = parseRpcRequest(request("malink.client.bootstrap", {
      context,
      idempotencyKey,
      homeserver: "https://matrix.example",
      oneTimeLoginToken: "one-time-login-token",
      expectedUserId: "@device:matrix.example",
      deviceName: "Pixel 10",
      roomBinding,
    }));
    expect(parsed.method).toBe("malink.client.bootstrap");

    const result = parseMethodRpcResponse(
      "malink.client.bootstrap",
      response({
        deviceId: "native-device-1",
        session: {
          homeserver: "https://matrix.example",
          userId: "@device:matrix.example",
          matrixDeviceId: "ANDROIDDEVICE",
          roomBinding,
        },
        snapshot: snapshot(),
      }),
    );
    expect("result" in result && result.result.session.matrixDeviceId)
      .toBe("ANDROIDDEVICE");

    expect(() =>
      parseRpcRequest(request("malink.client.bootstrap", {
        context,
        idempotencyKey,
        homeserver: "http://matrix.example",
        oneTimeLoginToken: "one-time-login-token",
        expectedUserId: "@device:matrix.example",
        deviceName: "Pixel 10",
        roomBinding,
      })),
    ).toThrow(/HTTPS/);
    expect(() =>
      parseRpcRequest(request("malink.client.bootstrap", {
        context,
        idempotencyKey,
        homeserver: "https://matrix.example",
        oneTimeLoginToken: "one-time-login-token",
        expectedUserId: "@device:matrix.example",
        deviceName: "Pixel 10",
        roomBinding,
        accessToken: "must-never-cross-the-bridge",
      })),
    ).toThrow(/unknown field: accessToken/);
    expect(() =>
      parseRpcRequest(request("malink.client.bootstrap", {
        context,
        idempotencyKey,
        homeserver: "https://matrix.example",
        oneTimeLoginToken: "one-time-login-token",
        expectedUserId: "@device:matrix.example",
        deviceName: "Pixel 10",
        roomBinding: { ...roomBinding, roomId: "not-a-matrix-room" },
      })),
    ).toThrow(/Matrix room id/);

    expect(() =>
      parseRpcRequest(request("malink.client.bootstrap", {
        context,
        idempotencyKey: "550e8400-e29b-41d4-a716-446655440002",
        homeserver: "https://matrix.example",
        password: "must-not-be-accepted",
        expectedUserId: "@device:matrix.example",
        deviceName: "Pixel 10",
        roomBinding,
      })),
    ).toThrow(/unknown field: password/);
  });

  it("parses an additive account rejoin without exposing Matrix credentials", () => {
    const roomBinding = {
      roomId: "!room:matrix.example",
      gatewayId: "workspace-1",
      conversationId: "conversation-1",
      gatewayUserId: "@gateway:matrix.example",
      gatewayDeviceId: "GATEWAYDEVICE",
      gatewayDeviceEd25519: "a".repeat(43),
    };
    const parsed = parseRpcRequest(request("malink.client.rejoin", {
      context,
      idempotencyKey,
      pairingLink: "malink://pair?data=signed-offer",
      homeserver: "https://matrix.example",
      oneTimeLoginToken: "one-time-login-token",
      expectedUserId: "@workspace-client:matrix.example",
      deviceName: "Pixel 10",
      roomBinding,
    }));
    expect(parsed.method).toBe("malink.client.rejoin");
    expect(isMutationMethod(parsed.method)).toBe(true);

    const result = parseMethodRpcResponse(
      "malink.client.rejoin",
      response({
        deviceId: "native-device-1",
        session: {
          homeserver: "https://matrix.example",
          userId: "@workspace-client:matrix.example",
          matrixDeviceId: "ANDROID-REJOINED",
          roomBinding,
        },
        snapshot: snapshot(),
      }),
    );
    expect("result" in result && result.result.session.userId)
      .toBe("@workspace-client:matrix.example");
    expect(JSON.stringify(result)).not.toContain("one-time-login-token");

    expect(() => parseRpcRequest(request("malink.client.rejoin", {
      context,
      idempotencyKey,
      pairingLink: "malink://pair?data=signed-offer",
      homeserver: "https://matrix.example",
      oneTimeLoginToken: "one-time-login-token",
      expectedUserId: "@workspace-client:matrix.example",
      deviceName: "Pixel 10",
      roomBinding,
      accessToken: "must-never-cross-the-bridge",
    }))).toThrow(/unknown field: accessToken/);
  });

  it("issues a bounded one-time Matrix token for a completed invitation", () => {
    const parsed = parseRpcRequest(request("malink.matrix.loginToken", {
      context,
      idempotencyKey,
      invitationId: "device-invite-command-1",
    }));
    expect(parsed.method).toBe("malink.matrix.loginToken");

    const ready = parseMethodRpcResponse(
      "malink.matrix.loginToken",
      response({
        status: "ready",
        loginToken: "single-use-login-token",
        expiresAt: 1_722_000_120_000,
      }),
    );
    expect("result" in ready && ready.result.status).toBe("ready");

    const reauth = parseMethodRpcResponse(
      "malink.matrix.loginToken",
      response({ status: "reauth-required", passwordSupported: true }),
    );
    expect(
      "result" in reauth &&
        reauth.result.status === "reauth-required" &&
        reauth.result.passwordSupported,
    ).toBe(true);

    expect(() =>
      parseRpcRequest(request("malink.matrix.loginToken", {
        context,
        idempotencyKey,
        invitationId: "device-invite-command-1",
        password: "x".repeat(4_097),
      })),
    ).toThrow(/password/);
    expect(() =>
      parseMethodRpcResponse(
        "malink.matrix.loginToken",
        response({
          status: "ready",
          loginToken: "single-use-login-token",
          expiresAt: 1_722_000_120_000,
          accessToken: "must-never-cross-the-bridge",
        }),
      ),
    ).toThrow(/unknown field: accessToken/);
  });

  it("parses durable command receipts, completion state, and release", () => {
    const receipt = {
      operationId: "operation-1",
      commandId: "command-1",
      idempotencyKey,
      state: "accepted",
      submittedAt: 1_722_000_000_000,
      updatedAt: 1_722_000_000_100,
      sessionId: "session-1",
      sequence: 4,
      revision: 7,
    };
    const sent = parseMethodRpcResponse(
      "malink.command.send",
      response(receipt),
    );
    expect("result" in sent && sent.result.state).toBe("accepted");

    const completed = parseMethodRpcResponse(
      "malink.command.get",
      response({
        ...receipt,
        state: "succeeded",
        completion: {
          commandId: "command-1",
          sequence: 4,
          revision: 8,
          outcome: "succeeded",
          sessionId: "session-1",
          result: { created: true },
        },
      }),
    );
    expect(
      "result" in completed && completed.result.completion?.outcome,
    ).toBe("succeeded");

    const released = parseMethodRpcResponse(
      "malink.command.release",
      response({ commandId: "command-1", released: true }),
    );
    expect("result" in released && released.result.released).toBe(true);
    expect(() =>
      parseRpcRequest(request("malink.command.release", {
        context,
        commandId: "command-1",
      })),
    ).toThrow(/idempotencyKey/);

    const retired = parseMethodRpcResponse(
      "malink.command.retire",
      response({ commandId: "command-2", retired: true }),
    );
    expect("result" in retired && retired.result.retired).toBe(true);
    expect(() =>
      parseRpcRequest(request("malink.command.retire", {
        context,
        commandId: "command-2",
      })),
    ).toThrow(/idempotencyKey/);
  });

  it("uses a native-safe history message DTO without raw Matrix events", () => {
    expect(
      parseRpcRequest(request("malink.history.page", {
        context,
        sessionId: "session-1",
        limit: 100,
        source: "local",
      })).method,
    ).toBe("malink.history.page");
    expect(() =>
      parseRpcRequest(request("malink.history.page", {
        context,
        sessionId: "session-1",
        limit: 100,
      })),
    ).toThrow(/source/);

    const page = parseMethodRpcResponse(
      "malink.history.page",
      response({
        sessionId: "session-1",
        messages: [{
          eventId: "event-1",
          sender: "gateway-1",
          timestamp: 1_722_000_000_000,
          encrypted: true,
          kind: "tool",
          text: "done",
          sessionId: "session-1",
          deliveryMode: "history",
          historical: true,
          activeDeviceCount: 2,
          format: "markdown",
          semantic: { kind: "message", operation_id: "operation-1" },
          toolGroup: {
            kind: "tool_group",
            version: 1,
            groupId: "tool-group-1",
            tools: [{
              id: "tool-1",
              name: "read_file",
              title: "Read file",
              category: "read",
              phase: "completed",
              isError: false,
              startedAt: 1_721_999_999_000,
              updatedAt: 1_722_000_000_000,
            }],
          },
        }],
        hasMore: false,
        asOfCursor: "journal-1:42",
      }),
    );
    expect("result" in page && page.result.messages[0]?.encrypted).toBe(true);
    expect("result" in page && page.result.messages[0]?.deliveryMode).toBe("history");

    expect(() =>
      parseMethodRpcResponse(
        "malink.history.page",
        response({
          sessionId: "session-1",
          messages: [{
            eventId: "event-invalid-delivery",
            sender: "gateway-1",
            timestamp: 1,
            encrypted: true,
            kind: "agent",
            deliveryMode: "replay",
            format: "plain",
          }],
          hasMore: false,
          asOfCursor: "journal-1:42",
        }),
      ),
    ).toThrow(/deliveryMode/);

    expect(() =>
      parseMethodRpcResponse(
        "malink.history.page",
        response({
          sessionId: "session-1",
          messages: [{
            eventId: "event-1",
            sender: "gateway-1",
            timestamp: 1,
            encrypted: true,
            kind: "agent",
            format: "plain",
            raw: { matrixEvent: true },
          }],
          hasMore: false,
          asOfCursor: "journal-1:42",
        }),
      ),
    ).toThrow(/unknown field: raw/);
  });

  it("parses native-confirmed pairing without exposing Web private trust state", () => {
    const preview = parseMethodRpcResponse(
      "malink.pairing.inspect",
      response({
        pairingId: "pairing-1",
        gatewayId: "gateway-1",
        gatewayName: "Workstation",
        verificationCode: "123 456",
        expiresAt: 1_722_000_060_000,
        requiresNativeConfirmation: true,
      }),
    );
    expect(
      "result" in preview && preview.result.requiresNativeConfirmation,
    ).toBe(true);

    const trust = {
      state: "trusted",
      gatewayId: "gateway-1",
      gatewayName: "Workstation",
      certificateId: "certificate-1",
      pairedAt: 1_722_000_000_000,
      activeDeviceCount: 2,
    };
    const completed = parseMethodRpcResponse(
      "malink.pairing.complete",
      response({ trust, snapshot: snapshot({ trust }) }),
    );
    expect("result" in completed && completed.result.trust.gatewayId)
      .toBe("gateway-1");
  });

  it("strictly parses resumable attachment chunk results", () => {
    const opened = parseMethodRpcResponse(
      "malink.attachment.upload.open",
      response({
        transferId: "transfer-1",
        chunkBytes: 262_144,
        nextIndex: 0,
        expiresAt: 1_722_000_060_000,
      }),
    );
    expect("result" in opened && opened.result.nextIndex).toBe(0);

    const chunk = parseMethodRpcResponse(
      "malink.attachment.upload.chunk",
      response({
        transferId: "transfer-1",
        index: 0,
        receivedBytes: 128,
        nextIndex: 1,
      }),
    );
    expect("result" in chunk && chunk.result.receivedBytes).toBe(128);

    const digest = "a".repeat(43);
    const downloaded = parseMethodRpcResponse(
      "malink.attachment.download.read",
      response({
        transferId: "transfer-2",
        index: 0,
        dataBase64Url: "YWJj",
        chunkSha256: digest,
        eof: true,
      }),
    );
    expect("result" in downloaded && downloaded.result.eof).toBe(true);
  });

  it.each([
    ["missing id", { jsonrpc: "2.0", method: "malink.trust.get", params: { context } }],
    ["numeric id", { ...request("malink.trust.get", { context }), id: 1 }],
    ["batch", [request("malink.trust.get", { context })]],
    ["unknown method", request("malink.native.eval", { context })],
    ["unknown field", { ...request("malink.trust.get", { context }), origin: "https://evil.test" }],
  ])("rejects %s", (_label, input) => {
    expect(() => parseRpcRequest(input)).toThrow(BridgeProtocolError);
  });

  it("enforces byte and nesting limits before dispatch", () => {
    expect(() =>
      parseRpcRequest(JSON.stringify(request("malink.pairing.inspect", {
        context,
        link: "x".repeat(512),
      })), { maxBytes: 128 }),
    ).toThrow(/size limit/);

    let nested: unknown = "leaf";
    for (let index = 0; index < 6; index += 1) nested = [nested];
    expect(() => parseRpcRequest(nested, { maxDepth: 3 })).toThrow(/depth limit/);
  });

  it("requires a UUID idempotency key for every declared mutation", () => {
    expect(MUTATION_METHODS.every(isMutationMethod)).toBe(true);
    expect(() =>
      parseRpcRequest(request("malink.command.recover", {
        context,
        commandId: "command-1",
      })),
    ).toThrow(/idempotencyKey/);

    expect(
      parseRpcRequest(request("malink.command.recover", {
        context,
        idempotencyKey,
        commandId: "command-1",
      })).params.idempotencyKey,
    ).toBe(idempotencyKey);
  });

  it("validates session receipt mutations and synchronized snapshot markers", () => {
    const parsed = parseRpcRequest(request("malink.session.markRead", {
      context,
      idempotencyKey,
      sessionId: "session-1",
      projectId: "project-1",
    }));
    expect(parsed.method).toBe("malink.session.markRead");
    expect(parseMethodRpcResponse(
      "malink.session.markRead",
      response({
        sessionId: "session-1",
        projectId: "project-1",
        readUpdatedAt: 42,
      }),
    )).toMatchObject({ result: { readUpdatedAt: 42 } });
    expect(parseMethodRpcResponse(
      "malink.client.snapshot",
      response(snapshot({ sessionReadState: { "session-1": 42 } })),
    )).toMatchObject({ result: { sessionReadState: { "session-1": 42 } } });
  });

  it("does not require idempotency keys for reads or monotonic event acknowledgement", () => {
    expect(parseRpcRequest(request("malink.client.snapshot", { context })).method)
      .toBe("malink.client.snapshot");
    expect(parseRpcRequest(request("malink.events.ack", {
      context,
      subscriptionId: "subscription-1",
      throughCursor: "journal-1:42",
    })).method).toBe("malink.events.ack");
  });

  it("strictly validates native update commands and progress", () => {
    expect(parseRpcRequest(request("malink.update.status", { context })).method)
      .toBe("malink.update.status");
    expect(() => parseRpcRequest(request("malink.update.check", { context })))
      .toThrow(/idempotencyKey/);
    expect(parseRpcRequest(request("malink.update.check", {
      context,
      idempotencyKey,
    })).method).toBe("malink.update.check");
    expect(() => parseRpcRequest(request("malink.update.install", { context })))
      .toThrow(/idempotencyKey/);

    const parsed = parseMethodRpcResponse("malink.update.status", response({
      phase: "downloading",
      currentVersionCode: 41,
      currentVersionName: "0.1.0-alpha.41",
      latestVersionCode: 42,
      latestVersionName: "0.1.0-alpha.42",
      buildId: "android-alpha-42",
      downloadedBytes: 500,
      totalBytes: 1_000,
      checkedAt: 1_787_400_000_000,
    }));
    expect("result" in parsed && parsed.result.phase).toBe("downloading");
    expect("result" in parseMethodRpcResponse("malink.update.check", response({
      phase: "checking",
      currentVersionCode: 41,
      currentVersionName: "0.1.0-alpha.41",
    }))).toBe(true);
    expect(() => parseMethodRpcResponse("malink.update.status", response({
      phase: "downloading",
      currentVersionCode: 41,
      currentVersionName: "0.1.0-alpha.41",
      downloadedBytes: 2,
      totalBytes: 1,
    }))).toThrow(/cannot exceed/);
  });

  it("strictly validates native diagnostic export", () => {
    expect(parseRpcRequest(request("malink.diagnostics.export", { context })).method)
      .toBe("malink.diagnostics.export");
    const parsed = parseMethodRpcResponse("malink.diagnostics.export", response({
      status: "share_opened",
      filename: "malink-native-diagnostics.txt",
    }));
    expect("result" in parsed && parsed.result.filename)
      .toBe("malink-native-diagnostics.txt");
    expect(() => parseMethodRpcResponse("malink.diagnostics.export", response({
      status: "downloaded",
      filename: "malink-native-diagnostics.txt",
    }))).toThrow(/share_opened/);
  });

  it("strictly validates idempotent native PNG saving", () => {
    const parsed = parseRpcRequest(request("malink.image.save", {
      context,
      idempotencyKey,
      filename: "malink-invitation-qr-20260903T100000Z.png",
      mimeType: "image/png",
      dataBase64: "iVBORw0KGgo=",
    }));
    expect(parsed.method).toBe("malink.image.save");
    expect(isMutationMethod(parsed.method)).toBe(true);

    const result = parseMethodRpcResponse("malink.image.save", response({
      status: "saved",
      filename: "malink-invitation-qr-20260903T100000Z.png",
    }));
    expect("result" in result && result.result.status).toBe("saved");

    expect(() => parseRpcRequest(request("malink.image.save", {
      context,
      idempotencyKey,
      filename: "../invitation.png",
      mimeType: "image/png",
      dataBase64: "iVBORw0KGgo=",
    }))).toThrow(/safe PNG filename/);
    expect(() => parseRpcRequest(request("malink.image.save", {
      context,
      idempotencyKey,
      filename: "invitation.png",
      mimeType: "image/jpeg",
      dataBase64: "iVBORw0KGgo=",
    }))).toThrow(/image\/png/);
    expect(() => parseRpcRequest(request("malink.image.save", {
      context,
      idempotencyKey,
      filename: "invitation.png",
      mimeType: "image/png",
      dataBase64: "bm90LWEtcG5n",
    }))).toThrow(/bounded PNG/);
  });

  it("strictly validates replay subscription and activation cursors", () => {
    const subscribe = parseRpcRequest(request("malink.events.subscribe", {
      context,
      afterCursor: "journal-1:41",
      maxReplayEvents: 100,
    }));
    expect(subscribe.params.afterCursor).toBe("journal-1:41");

    expect(() =>
      parseRpcRequest(request("malink.events.subscribe", {
        context,
        maxReplayEvents: NATIVE_BRIDGE_LIMITS.maxReplayEvents + 1,
      })),
    ).toThrow(/maxReplayEvents/);

    expect(() =>
      parseRpcRequest(request("malink.events.activate", {
        context,
        subscriptionId: "subscription-1",
      })),
    ).toThrow(/throughCursor/);
  });

  it("parses only bounded, negotiated native event notifications", () => {
    const notification = parseEventsDeliverNotification({
      jsonrpc: "2.0",
      method: "malink.events.deliver",
      params: {
        subscriptionId: "subscription-1",
        events: [{
          schemaVersion: 1,
          eventId: "event-1",
          cursor: "journal-1:42",
          occurredAt: 1_722_000_000_000,
          type: "command.changed",
          payload: { operationId: "operation-1", state: "accepted" },
        }],
      },
    });
    expect(notification.params.events[0]?.cursor).toBe("journal-1:42");

    expect(() =>
      parseEventsDeliverNotification({
        ...notification,
        params: {
          ...notification.params,
          events: [{ ...notification.params.events[0], type: "native.secret.exposed" }],
        },
      }),
    ).toThrow(/not negotiated/);
  });

  it("validates attachment metadata and bounds chunk payloads", () => {
    const digest = "a".repeat(43);
    const upload = parseRpcRequest(request("malink.attachment.upload.open", {
      context,
      idempotencyKey,
      name: "report.pdf",
      mimeType: "application/pdf",
      size: 1024,
      sha256: digest,
    }));
    expect(upload.params.size).toBe(1024);

    try {
      parseRpcRequest(request("malink.attachment.upload.open", {
        context,
        idempotencyKey,
        name: "too-large.bin",
        mimeType: "application/octet-stream",
        size: NATIVE_BRIDGE_LIMITS.maxAttachmentBytes + 1,
        sha256: digest,
      }));
      throw new Error("Expected the oversized attachment to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({ errorCode: "ATTACHMENT_TOO_LARGE" });
    }
  });

  it("uses stable machine-readable errors and preserves retry metadata", () => {
    const error = parseRpcError({
      code: RPC_ERROR_NUMBERS.TIMEOUT,
      message: "The native operation is still pending.",
      data: {
        errorCode: "TIMEOUT",
        retryable: true,
        retryAfterMs: 1000,
        operationId: "operation-1",
        userAction: "retry",
      },
    });
    expect(error.data).toMatchObject({
      errorCode: "TIMEOUT",
      retryable: true,
      operationId: "operation-1",
    });

    const failure = failureResponse(
      "request-1",
      new BridgeProtocolError("CURSOR_EXPIRED", "Snapshot required.", {
        retryable: true,
      }),
    );
    expect(failure.error.code).toBe(RPC_ERROR_NUMBERS.CURSOR_EXPIRED);
  });
});
