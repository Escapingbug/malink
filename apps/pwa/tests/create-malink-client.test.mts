import assert from "node:assert/strict";
import test from "node:test";
import {
  BridgeProtocolError,
  NATIVE_BRIDGE_LIMITS,
  type HelloResult,
} from "@malink/native-bridge";
import type { MatrixConnectionConfig } from "../app/matrix.ts";
import type {
  MalinkClient,
  MalinkClientHandlers,
} from "../app/client/MalinkClient.ts";
import {
  NATIVE_MANAGED_ACCESS_TOKEN,
  advanceNativeAppUpdate,
  bootstrapNativeMatrixSessionIfAvailable,
  createMalinkClient,
  nativeRuntimeInfo,
  nativeMatrixSessionConfig,
  rejoinNativeMatrixSessionIfAvailable,
  resumeNativeMatrixSessionIfAvailable,
} from "../app/client/createMalinkClient.ts";
import {
  REQUIRED_NATIVE_CAPABILITIES,
  nativeCapabilityVersions,
} from "../app/client/native/NativeBridgeClient.ts";
import {
  NativeRpcBridge,
  type NativeBridgePort,
} from "../app/client/native/NativeRpcBridge.ts";
import type { createWebMalinkClient } from "../app/client/web/WebMalinkClient.ts";

const config: MatrixConnectionConfig = {
  homeserver: "https://matrix.example.test",
  userId: "@device:example.test",
  accessToken: "web-token",
  matrixDeviceId: "WEB_DEVICE",
  roomId: "!room:example.test",
  gatewayId: "gateway-1",
  conversationId: "conversation-1",
  gatewayMatrixUserId: "@gateway:example.test",
  gatewayMatrixDeviceId: "GATEWAY_DEVICE",
  gatewayMatrixEd25519: "gateway-ed25519",
};

class HelloPort implements NativeBridgePort {
  onmessage: NativeBridgePort["onmessage"] = null;

  postMessage(message: string): void {
    const request = JSON.parse(message) as { id: string; method: string };
    assert.equal(request.method, "malink.bridge.hello");
    const result: HelloResult = {
      protocolVersion: 1,
      bridgeSessionId: "bridge-partial-1",
      native: {
        runtimeVersion: "0.1.0",
        runtimeBuild: "android-test",
        platform: "android",
      },
      capabilities: {
        "background.foreground-service": { version: 1 },
        "matrix.session-bootstrap": { version: 1 },
      },
      limits: NATIVE_BRIDGE_LIMITS,
    };
    queueMicrotask(() => {
      this.onmessage?.({
        data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
      });
    });
  }
}

test("uses Web directly when no native host is injected", async () => {
  const webClient = { runtime: "web" } as MalinkClient;
  let webCreates = 0;
  const client = await createMalinkClient(
    config,
    quietHandlers(),
    {
      nativePort: () => null,
      createBridge: (port) => new NativeRpcBridge(port),
      createWeb: (async () => {
        webCreates += 1;
        return webClient;
      }) as typeof createWebMalinkClient,
    },
  );
  assert.equal(client, webClient);
  assert.equal(webCreates, 1);
});

test("reads a negotiated PWA source without changing the shared hello envelope", () => {
  const hello: HelloResult = {
    protocolVersion: 1,
    bridgeSessionId: "bridge-pwa-source-1",
    native: {
      runtimeVersion: "0.1.0",
      runtimeBuild: "android-source",
      platform: "android",
    },
    capabilities: {
      "client.pwa-source": {
        version: 1,
        options: {
          currentBaseUrl: "https://mirror.example/malink/",
          officialBaseUrl: "https://official.example/malink/",
          source: "custom",
        },
      },
    },
    limits: NATIVE_BRIDGE_LIMITS,
  };

  assert.deepEqual(nativeRuntimeInfo(hello).pwaSource, {
    currentBaseUrl: "https://mirror.example/malink/",
    officialBaseUrl: "https://official.example/malink/",
    source: "custom",
  });
});

test("reports journal reconciliation only when the native host negotiated it", () => {
  const base: HelloResult = {
    protocolVersion: 1,
    bridgeSessionId: "bridge-command-recovery-1",
    native: {
      runtimeVersion: "0.1.0",
      runtimeBuild: "android-command-recovery",
      platform: "android",
    },
    capabilities: {},
    limits: NATIVE_BRIDGE_LIMITS,
  };

  assert.equal(nativeRuntimeInfo(base).commandJournalReconciliation, undefined);
  assert.equal(
    nativeRuntimeInfo({
      ...base,
      capabilities: {
        "commands.journal-reconciliation": { version: 1 },
      },
    }).commandJournalReconciliation,
    true,
  );
  assert.equal(nativeRuntimeInfo(base).orphanCommandRetirement, undefined);
  assert.equal(
    nativeRuntimeInfo({
      ...base,
      capabilities: {
        "commands.orphan-retirement": { version: 1 },
      },
    }).orphanCommandRetirement,
    true,
  );
});

test("falls back explicitly when the native host is only a Matrix scaffold", async () => {
  const port = new HelloPort();
  const webClient = { runtime: "web" } as MalinkClient;
  const statusDetails: string[] = [];
  const nativeBuilds: string[] = [];
  const client = await createMalinkClient(
    config,
    {
      ...quietHandlers(),
      onStatus(_status, detail) {
        if (detail) statusDetails.push(detail);
      },
      onNativeRuntime(runtime) {
        if (runtime) nativeBuilds.push(runtime.runtimeBuild);
      },
    },
    {
      nativePort: () => port,
      createBridge: (nativePort) => new NativeRpcBridge(nativePort),
      createWeb: (async () => webClient) as typeof createWebMalinkClient,
    },
  );
  assert.equal(client, webClient);
  assert.equal(port.onmessage, null);
  assert.match(statusDetails.join("\n"), /complete Malink runtime/i);
  assert.deepEqual(nativeBuilds, ["android-test"]);
});

test("keeps a browser-owned Matrix session on Web even with a complete native host", async () => {
  const port = new BootstrapPort();
  const webClient = { runtime: "web" } as MalinkClient;
  const statusDetails: string[] = [];
  const client = await createMalinkClient(
    config,
    {
      ...quietHandlers(),
      onStatus(_status, detail) {
        if (detail) statusDetails.push(detail);
      },
    },
    {
      nativePort: () => port,
      createBridge: (nativePort) => new NativeRpcBridge(nativePort),
      createWeb: (async () => webClient) as typeof createWebMalinkClient,
    },
  );
  assert.equal(client, webClient);
  assert.match(statusDetails.join("\n"), /browser-owned|device invitation/i);
});

test("fails closed when a native-owned Matrix session loses its host", async () => {
  let webCreates = 0;
  await assert.rejects(
    createMalinkClient(
      { ...config, accessToken: NATIVE_MANAGED_ACCESS_TOKEN },
      quietHandlers(),
      {
        nativePort: () => null,
        createBridge: (port) => new NativeRpcBridge(port),
        createWeb: (async () => {
          webCreates += 1;
          return { runtime: "web" } as MalinkClient;
        }) as typeof createWebMalinkClient,
      },
    ),
    (error) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "matrix_native_runtime_unavailable" &&
      /duplicate Web Matrix device/i.test(error.message),
  );
  assert.equal(webCreates, 0);
});

test("fails closed before command submission when the native host only supports commands.durable v2", async () => {
  const outdated = new BootstrapPort(2);
  await assert.rejects(
    createMalinkClient(
      { ...config, accessToken: NATIVE_MANAGED_ACCESS_TOKEN },
      quietHandlers(),
      {
        nativePort: () => outdated,
        createBridge: (port) => new NativeRpcBridge(port),
        createWeb: (async () => {
          throw new Error("Web fallback must remain disabled for a native-owned session.");
        }) as typeof createWebMalinkClient,
      },
    ),
    (error) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "matrix_native_runtime_outdated" &&
      /update/i.test(error.message),
  );
  assert.equal(outdated.bootstrapToken, "");
});

test("an outdated full client can still advance the independent native updater", async () => {
  const port = new NativeUpdatePort();
  const result = await advanceNativeAppUpdate({
    dependencies: {
      nativePort: () => port,
      createBridge: (nativePort) => new NativeRpcBridge(nativePort),
    },
  });
  assert.equal(result.phase, "installing");
  assert.deepEqual(port.methods, [
    "malink.bridge.hello",
    "malink.update.status",
    "malink.update.install",
  ]);
  assert.equal(port.onmessage, null);
});

test("a manual retry uses the additive v1 static-channel check", async () => {
  const port = new NativeUpdatePort();
  const result = await advanceNativeAppUpdate({
    checkNow: true,
    installReady: false,
    dependencies: {
      nativePort: () => port,
      createBridge: (nativePort) => new NativeRpcBridge(nativePort),
    },
  });
  assert.equal(result.phase, "checking");
  assert.deepEqual(port.methods, [
    "malink.bridge.hello",
    "malink.update.check",
  ]);
});

test("a manual retry keeps pre-extension v1 APK status and install recovery usable", async () => {
  const port = new NativeUpdatePort(false);
  const result = await advanceNativeAppUpdate({
    checkNow: true,
    installReady: false,
    dependencies: {
      nativePort: () => port,
      createBridge: (nativePort) => new NativeRpcBridge(nativePort),
    },
  });
  assert.equal(result.phase, "ready");
  assert.deepEqual(port.methods, [
    "malink.bridge.hello",
    "malink.update.check",
    "malink.update.status",
  ]);
});

test("a pre-extension v1 APK reports an actionable manual-check boundary", async () => {
  const port = new NativeUpdatePort(false, "current");
  const result = await advanceNativeAppUpdate({
    checkNow: true,
    installReady: false,
    dependencies: {
      nativePort: () => port,
      createBridge: (nativePort) => new NativeRpcBridge(nativePort),
    },
  });
  assert.equal(result.phase, "failed");
  assert.equal(result.detailCode, "manual_check_unavailable");
});

test("consumes a one-time login token only after complete native negotiation", async () => {
  const partial = new HelloPort();
  const input = nativeBootstrapInput();
  assert.equal(
    await bootstrapNativeMatrixSessionIfAvailable(input, {
      nativePort: () => partial,
      createBridge: (port) => new NativeRpcBridge(port),
    }),
    null,
  );

  const complete = new BootstrapPort();
  const result = await bootstrapNativeMatrixSessionIfAvailable(input, {
    nativePort: () => complete,
    createBridge: (port) => new NativeRpcBridge(port),
  });
  assert.equal(result?.session.matrixDeviceId, "NATIVE_MATRIX_DEVICE");
  assert.equal(complete.bootstrapToken, "single-use-secret");
});

test("requires the additive native account-rejoin capability before replacing a session", async () => {
  const input = nativeBootstrapInput();
  const oldHostError = await rejoinNativeMatrixSessionIfAvailable(
    input,
    "malink://pair?data=signed-offer",
    {
      nativePort: () => new BootstrapPort(),
      createBridge: (port) => new NativeRpcBridge(port),
    },
  ).catch((error: unknown) => error);
  assert.ok(oldHostError instanceof BridgeProtocolError);
  assert.equal(oldHostError.errorCode, "CAPABILITY_UNAVAILABLE");

  const port = new RejoinPort();
  const result = await rejoinNativeMatrixSessionIfAvailable(
    input,
    "malink://pair?data=signed-offer",
    {
      nativePort: () => port,
      createBridge: (nativePort) => new NativeRpcBridge(nativePort),
    },
  );
  assert.equal(result?.session.matrixDeviceId, "NATIVE_REJOINED_DEVICE");
  assert.equal(port.pairingLink, "malink://pair?data=signed-offer");
  assert.equal(port.loginToken, "single-use-secret");
});

test("recovers an existing native session without exporting credentials", async () => {
  const port = new SessionPort(true);
  const session = await resumeNativeMatrixSessionIfAvailable({
    nativePort: () => port,
    createBridge: (nativePort) => new NativeRpcBridge(nativePort),
  });
  assert.ok(session);
  assert.equal(port.onmessage, null);
  const recovered = nativeMatrixSessionConfig(session);
  assert.equal(recovered.accessToken, NATIVE_MANAGED_ACCESS_TOKEN);
  assert.equal(recovered.roomId, "!room:example.test");
  assert.doesNotMatch(JSON.stringify(session), /accessToken|privateKey/iu);

  const emptyPort = new SessionPort(false);
  assert.equal(await resumeNativeMatrixSessionIfAvailable({
    nativePort: () => emptyPort,
    createBridge: (nativePort) => new NativeRpcBridge(nativePort),
  }), null);
});

function quietHandlers(): MalinkClientHandlers {
  return {
    onMessage() {},
    onStatus() {},
  };
}

function nativeBootstrapInput() {
  return {
    homeserver: "https://matrix.example.test",
    oneTimeLoginToken: "single-use-secret",
    expectedUserId: "@device:example.test",
    deviceName: "Android test",
    roomBinding: {
      roomId: "!room:example.test",
      gatewayId: "gateway-1",
      conversationId: "conversation-1",
      gatewayUserId: "@gateway:example.test",
      gatewayDeviceId: "GATEWAY_DEVICE",
      gatewayDeviceEd25519: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    },
  } as const;
}

class BootstrapPort implements NativeBridgePort {
  onmessage: NativeBridgePort["onmessage"] = null;
  bootstrapToken = "";

  constructor(private readonly commandsDurableVersion = 5) {}

  postMessage(message: string): void {
    const request = JSON.parse(message) as {
      id: string;
      method: string;
      params: Record<string, unknown>;
    };
    let result: unknown;
    if (request.method === "malink.bridge.hello") {
      result = {
        protocolVersion: 1,
        bridgeSessionId: "bridge-complete-1",
        native: {
          runtimeVersion: "1.0.0",
          runtimeBuild: "android-complete",
          platform: "android",
        },
        capabilities: Object.fromEntries(
          REQUIRED_NATIVE_CAPABILITIES.map((name) => [
            name,
            {
              version: name === "commands.durable"
                ? this.commandsDurableVersion
                : nativeCapabilityVersions(name)[0],
            },
          ]),
        ),
        limits: NATIVE_BRIDGE_LIMITS,
      };
    } else {
      assert.equal(request.method, "malink.client.bootstrap");
      this.bootstrapToken = String(request.params.oneTimeLoginToken);
      result = {
        deviceId: "native-device-1",
        session: {
          homeserver: "https://matrix.example.test",
          userId: "@device:example.test",
          matrixDeviceId: "NATIVE_MATRIX_DEVICE",
          roomBinding: nativeBootstrapInput().roomBinding,
        },
        snapshot: {
          schemaVersion: 1,
          deviceId: "native-device-1",
          cursor: "cursor-bootstrap-1",
          generatedAt: 1,
          lifecycle: { phase: "connecting", since: 1 },
          foregroundService: {
            required: true,
            active: true,
            notificationVisible: true,
          },
          trust: { state: "unpaired" },
          commands: [],
        },
      };
    }
    queueMicrotask(() => {
      this.onmessage?.({
        data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
      });
    });
  }
}

class RejoinPort implements NativeBridgePort {
  onmessage: NativeBridgePort["onmessage"] = null;
  pairingLink = "";
  loginToken = "";

  postMessage(message: string): void {
    const request = JSON.parse(message) as {
      id: string;
      method: string;
      params: Record<string, unknown>;
    };
    let result: unknown;
    if (request.method === "malink.bridge.hello") {
      result = {
        protocolVersion: 1,
        bridgeSessionId: "bridge-rejoin-1",
        native: {
          runtimeVersion: "1.1.0",
          runtimeBuild: "android-rejoin",
          platform: "android",
        },
        capabilities: Object.fromEntries([
          ...REQUIRED_NATIVE_CAPABILITIES.map((name) => [
            name,
            { version: nativeCapabilityVersions(name)[0] },
          ]),
          ["matrix.account-rejoin", { version: 1 }],
        ]),
        limits: NATIVE_BRIDGE_LIMITS,
      };
    } else {
      assert.equal(request.method, "malink.client.rejoin");
      this.pairingLink = String(request.params.pairingLink);
      this.loginToken = String(request.params.oneTimeLoginToken);
      result = {
        deviceId: "native-device-1",
        session: {
          homeserver: "https://matrix.example.test",
          userId: "@device:example.test",
          matrixDeviceId: "NATIVE_REJOINED_DEVICE",
          roomBinding: nativeBootstrapInput().roomBinding,
        },
        snapshot: {
          schemaVersion: 1,
          deviceId: "native-device-1",
          cursor: "cursor-rejoin-1",
          generatedAt: 1,
          lifecycle: { phase: "connecting", since: 1 },
          foregroundService: {
            required: true,
            active: true,
            notificationVisible: true,
          },
          trust: { state: "unpaired" },
          commands: [],
        },
      };
    }
    queueMicrotask(() => this.onmessage?.({
      data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
    }));
  }
}

class SessionPort implements NativeBridgePort {
  onmessage: NativeBridgePort["onmessage"] = null;

  constructor(private readonly hasSession: boolean) {}

  postMessage(message: string): void {
    const request = JSON.parse(message) as { id: string; method: string };
    const binding = nativeBootstrapInput().roomBinding;
    const result = request.method === "malink.bridge.hello"
      ? {
          protocolVersion: 1,
          bridgeSessionId: "bridge-session-reader-1",
          native: {
            runtimeVersion: "1.0.0",
            runtimeBuild: "android-session-reader",
            platform: "android",
          },
          capabilities: { "matrix.session-bootstrap": { version: 2 } },
          limits: NATIVE_BRIDGE_LIMITS,
        }
      : request.method === "malink.client.session"
        ? {
            session: this.hasSession
              ? {
                  homeserver: "https://matrix.example.test",
                  userId: "@device:example.test",
                  matrixDeviceId: "NATIVE_MATRIX_DEVICE",
                  roomBinding: binding,
                  roomBindings: [binding],
                }
              : null,
          }
        : assert.fail(`Unexpected native method: ${request.method}`);
    queueMicrotask(() => {
      this.onmessage?.({
        data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
      });
    });
  }
}

class NativeUpdatePort implements NativeBridgePort {
  onmessage: NativeBridgePort["onmessage"] = null;
  methods: string[] = [];

  constructor(
    private readonly supportsManualCheck = true,
    private readonly statusPhase: "current" | "ready" = "ready",
  ) {}

  postMessage(message: string): void {
    const request = JSON.parse(message) as {
      id: string;
      method: string;
    };
    this.methods.push(request.method);
    const result = request.method === "malink.bridge.hello"
      ? {
          protocolVersion: 1,
          bridgeSessionId: "bridge-update-1",
          native: {
            runtimeVersion: "0.1.0-old",
            runtimeBuild: "android-outdated",
            platform: "android",
          },
          capabilities: { "client.update": { version: 1 } },
          limits: NATIVE_BRIDGE_LIMITS,
        }
      : request.method === "malink.update.status"
        ? {
            phase: this.statusPhase,
            currentVersionCode: 1,
            currentVersionName: "0.1.0-old",
            latestVersionCode: 2,
            latestVersionName: "0.1.0-new",
          }
        : request.method === "malink.update.check" && this.supportsManualCheck
          ? {
              phase: "checking",
              currentVersionCode: 1,
              currentVersionName: "0.1.0-old",
            }
          : {
            phase: "installing",
            currentVersionCode: 1,
            currentVersionName: "0.1.0-old",
            latestVersionCode: 2,
            latestVersionName: "0.1.0-new",
          };
    queueMicrotask(() => {
      if (request.method === "malink.update.check" && !this.supportsManualCheck) {
        this.onmessage?.({
          data: JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: -32601,
              message: "Unsupported native bridge method: malink.update.check",
              data: { errorCode: "METHOD_NOT_FOUND", retryable: false },
            },
          }),
        });
        return;
      }
      this.onmessage?.({
        data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
      });
    });
  }
}
