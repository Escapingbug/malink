import {
  BridgeProtocolError,
  type ClientBootstrapResult,
  type HelloResult,
  type NativeUpdateStatus,
  type PublicMatrixSession,
} from "@malink/native-bridge";
import { MALINK_BUILD_VERSION } from "../buildInfo";
import { ConnectionFailureError } from "../connectionFailure";
import type { MatrixConnectionConfig } from "../matrix";
import type { MalinkClient, MalinkClientHandlers } from "./MalinkClient";
import type { MalinkNativeRuntimeInfo } from "./MalinkClient";
import {
  OPTIONAL_NATIVE_CAPABILITIES,
  REQUIRED_NATIVE_CAPABILITIES,
  hasCurrentNativeCapability,
  nativeCapabilityVersions,
  bootstrapNativeSession,
  checkNativeUpdateWithCompatibility,
  createNativeBridgeClient,
  readNativeMatrixSession,
  type NativeBootstrapInput,
} from "./native/NativeBridgeClient";
import {
  acquireNativeRpcBridge,
  NativeRpcBridge,
  injectedNativeBridgePort,
  type NativeBridgePort,
} from "./native/NativeRpcBridge";
import { createWebMalinkClient } from "./web/WebMalinkClient";

const NATIVE_FALLBACK_DETAIL =
  "This native host does not yet provide the complete Malink runtime; using the Web connection without background continuity.";
const WEB_SESSION_DETAIL =
  "This Matrix sign-in is owned by the browser. Use a Gateway device invitation to create a background-capable native session.";

export const NATIVE_MANAGED_ACCESS_TOKEN = "malink-native-managed-session-v1";

export type CreateMalinkClientDependencies = {
  nativePort(): NativeBridgePort | null;
  createWeb: typeof createWebMalinkClient;
  createBridge(port: NativeBridgePort):
    | NativeRpcBridge
    | Promise<NativeRpcBridge>;
};

const defaultDependencies: CreateMalinkClientDependencies = {
  nativePort: () => injectedNativeBridgePort(),
  createWeb: createWebMalinkClient,
  createBridge: (port) => acquireNativeRpcBridge(port),
};

/**
 * Selects native only after every domain capability required by MalinkClient
 * was negotiated. An older/partial host remains usable, but the UI explicitly
 * reports that its Matrix transport is the foreground Web implementation.
 */
export async function createMalinkClient(
  config: MatrixConnectionConfig,
  handlers: MalinkClientHandlers,
  dependencies: CreateMalinkClientDependencies = defaultDependencies,
): Promise<MalinkClient> {
  const nativeManaged = isNativeManagedMatrixConfig(config);
  const port = dependencies.nativePort();
  if (!port) {
    handlers.onNativeRuntime?.(null);
    if (nativeManaged) throw nativeRuntimeUnavailable();
    return dependencies.createWeb(config, handlers);
  }

  const bridge = await dependencies.createBridge(port);
  let hello: HelloResult;
  try {
    hello = await bridge.hello({
      webBuild: MALINK_BUILD_VERSION,
      requiredCapabilities: [],
      optionalCapabilities: [
        ...REQUIRED_NATIVE_CAPABILITIES,
        ...OPTIONAL_NATIVE_CAPABILITIES,
      ].map((name) => ({
        name,
        versions: nativeCapabilityVersions(name),
      })),
    });
  } catch (error) {
    bridge.close();
    handlers.onNativeRuntime?.(null);
    if (nativeManaged) throw nativeRuntimeUnavailable(error);
    handlers.onStatus(
      "connecting",
      `${NATIVE_FALLBACK_DETAIL} Native handshake failed: ${formatError(error)}`,
    );
    return dependencies.createWeb(config, handlers);
  }
  handlers.onNativeRuntime?.(nativeRuntimeInfo(hello));
  const fullNative = REQUIRED_NATIVE_CAPABILITIES.every(
    (name) => hasCurrentNativeCapability(hello, name),
  );
  if (fullNative && nativeManaged) {
    // Once a runtime claims the complete durable domain, startup failures are
    // fail-closed. Falling back could create a second Matrix device/command.
    return createNativeBridgeClient(bridge, hello, handlers);
  }
  bridge.close();
  if (fullNative) {
    handlers.onStatus("connecting", WEB_SESSION_DETAIL);
    return dependencies.createWeb(config, handlers);
  }
  if (nativeManaged) throw nativeRuntimeOutdated();
  handlers.onStatus("connecting", NATIVE_FALLBACK_DETAIL);
  return dependencies.createWeb(config, handlers);
}

export function nativeRuntimeInfo(hello: HelloResult): MalinkNativeRuntimeInfo {
  const commandJournalReconciliation =
    hello.capabilities["commands.journal-reconciliation"]?.version === 1;
  const orphanCommandRetirement =
    hello.capabilities["commands.orphan-retirement"]?.version === 1;
  const capability = hello.capabilities["client.pwa-source"];
  const options = capability?.version === 1 ? capability.options : undefined;
  const currentBaseUrl = options?.currentBaseUrl;
  const officialBaseUrl = options?.officialBaseUrl;
  const source = options?.source;
  if (
    typeof currentBaseUrl !== "string" ||
    typeof officialBaseUrl !== "string" ||
    (source !== "official" && source !== "custom")
  ) {
    return {
      ...hello.native,
      ...(commandJournalReconciliation ? { commandJournalReconciliation: true } : {}),
      ...(orphanCommandRetirement ? { orphanCommandRetirement: true } : {}),
    };
  }
  return {
    ...hello.native,
    ...(commandJournalReconciliation ? { commandJournalReconciliation: true } : {}),
    ...(orphanCommandRetirement ? { orphanCommandRetirement: true } : {}),
    pwaSource: { currentBaseUrl, officialBaseUrl, source },
  };
}

/**
 * Keeps native app recovery available even when the installed shell is too old
 * to construct the full durable Malink client. The update capability has its
 * own short-lived bridge lease so a compatibility failure never leaves the
 * user with diagnostics as the only possible action.
 */
export async function advanceNativeAppUpdate(
  options: {
    installReady?: boolean;
    checkNow?: boolean;
    dependencies?: Pick<
      CreateMalinkClientDependencies,
      "nativePort" | "createBridge"
    >;
  } = {},
): Promise<NativeUpdateStatus> {
  const dependencies = options.dependencies ?? defaultDependencies;
  const port = dependencies.nativePort();
  if (!port) {
    throw new BridgeProtocolError(
      "BRIDGE_NOT_READY",
      "The native app did not answer the update request.",
      { retryable: true, userAction: "update_native" },
    );
  }
  const bridge = await dependencies.createBridge(port);
  try {
    const hello = await bridge.hello({
      webBuild: MALINK_BUILD_VERSION,
      requiredCapabilities: [{ name: "client.update", versions: [1] }],
    });
    const updateVersion = hello.capabilities["client.update"]?.version ?? 0;
    if (updateVersion < 1) {
      throw new BridgeProtocolError(
        "CAPABILITY_UNAVAILABLE",
        "This APK cannot install direct native updates.",
        { userAction: "update_native" },
      );
    }
    const status = options.checkNow
      ? await checkNativeUpdateWithCompatibility(bridge)
      : await bridge.request("malink.update.status", {
          context: bridge.context(),
        });
    if (
      options.installReady === false ||
      (status.phase !== "ready" && status.phase !== "permission_required")
    ) {
      return status;
    }
    return await bridge.request("malink.update.install", {
      context: bridge.context(),
      idempotencyKey: crypto.randomUUID(),
    });
  } finally {
    bridge.close();
  }
}

/**
 * Keeps Android diagnostics available when the ordinary Malink client cannot
 * be constructed. A broken connection is the most important time for this
 * support surface, so it owns a short-lived bridge lease just like the native
 * updater instead of depending on Matrix or Gateway readiness.
 */
export async function exportNativeDiagnosticsIfAvailable(
  dependencies: Pick<
    CreateMalinkClientDependencies,
    "nativePort" | "createBridge"
  > = defaultDependencies,
): Promise<boolean> {
  const port = dependencies.nativePort();
  if (!port) return false;
  const bridge = await dependencies.createBridge(port);
  try {
    await bridge.hello({
      webBuild: MALINK_BUILD_VERSION,
      requiredCapabilities: [{ name: "client.diagnostics", versions: [1] }],
    });
    const result = await bridge.request("malink.diagnostics.export", {
      context: bridge.context(),
    });
    return result.status === "share_opened";
  } finally {
    bridge.close();
  }
}

/**
 * Consumes a one-time Matrix login token in native code only when the host
 * implements the complete durable Malink runtime. A partial/older host leaves
 * the token untouched so the browser implementation may consume it instead.
 */
export async function bootstrapNativeMatrixSessionIfAvailable(
  input: NativeBootstrapInput,
  dependencies: Pick<
    CreateMalinkClientDependencies,
    "nativePort" | "createBridge"
  > = defaultDependencies,
): Promise<ClientBootstrapResult | null> {
  const port = dependencies.nativePort();
  if (!port) return null;
  const bridge = await dependencies.createBridge(port);
  try {
    const hello = await bridge.hello({
      webBuild: MALINK_BUILD_VERSION,
      requiredCapabilities: [],
      optionalCapabilities: [
        ...REQUIRED_NATIVE_CAPABILITIES,
        ...OPTIONAL_NATIVE_CAPABILITIES,
      ].map((name) => ({
        name,
        versions: nativeCapabilityVersions(name),
      })),
    });
    if (
      !REQUIRED_NATIVE_CAPABILITIES.every(
        (name) => hasCurrentNativeCapability(hello, name),
      )
    ) {
      return null;
    }
    return await bootstrapNativeSession(bridge, input);
  } finally {
    bridge.close();
  }
}

/** Removes an Android-owned account even when the ordinary client failed to start. */
export async function signOutNativeMatrixSessionIfAvailable(
  dependencies: Pick<
    CreateMalinkClientDependencies,
    "nativePort" | "createBridge"
  > = defaultDependencies,
): Promise<boolean> {
  const port = dependencies.nativePort();
  if (!port) return false;
  const bridge = await dependencies.createBridge(port);
  try {
    await bridge.hello({
      webBuild: MALINK_BUILD_VERSION,
      requiredCapabilities: [{ name: "client.lifecycle", versions: [1] }],
    });
    await bridge.request("malink.client.disconnect", {
      context: bridge.context(),
      idempotencyKey: crypto.randomUUID(),
      mode: "revoke",
    });
    return true;
  } finally {
    bridge.close();
  }
}

/**
 * Lets a newly loaded Android WebView origin discover the Matrix session that
 * already belongs to the native service. No token or private key crosses the
 * bridge; the returned fields are presentation routing metadata only.
 */
export async function resumeNativeMatrixSessionIfAvailable(
  dependencies: Pick<
    CreateMalinkClientDependencies,
    "nativePort" | "createBridge"
  > = defaultDependencies,
): Promise<PublicMatrixSession | null> {
  const port = dependencies.nativePort();
  if (!port) return null;
  const bridge = await dependencies.createBridge(port);
  try {
    const hello = await bridge.hello({
      webBuild: MALINK_BUILD_VERSION,
      requiredCapabilities: [],
      optionalCapabilities: [
        ...REQUIRED_NATIVE_CAPABILITIES,
        ...OPTIONAL_NATIVE_CAPABILITIES,
      ].map((name) => ({
        name,
        versions: nativeCapabilityVersions(name),
      })),
    });
    const bootstrapVersion =
      hello.capabilities["matrix.session-bootstrap"]?.version;
    if (bootstrapVersion !== 2 && bootstrapVersion !== 3) {
      return null;
    }
    return await readNativeMatrixSession(bridge);
  } finally {
    bridge.close();
  }
}

export function nativeMatrixSessionConfig(
  session: PublicMatrixSession,
): MatrixConnectionConfig {
  const binding = session.roomBinding;
  return {
    homeserver: session.homeserver,
    userId: session.userId,
    accessToken: NATIVE_MANAGED_ACCESS_TOKEN,
    matrixDeviceId: session.matrixDeviceId,
    roomId: binding.roomId,
    gatewayId: binding.gatewayId,
    gatewayNodeId: binding.gatewayId,
    conversationId: binding.conversationId,
    gatewayMatrixUserId: binding.gatewayUserId,
    gatewayMatrixDeviceId: binding.gatewayDeviceId,
    gatewayMatrixEd25519: binding.gatewayDeviceEd25519,
  };
}

export function isNativeManagedMatrixConfig(
  config: MatrixConnectionConfig,
): boolean {
  return config.accessToken === NATIVE_MANAGED_ACCESS_TOKEN;
}

function nativeRuntimeUnavailable(cause?: unknown): Error {
  return new ConnectionFailureError(
    "matrix_native_runtime_unavailable",
    "This Matrix session is owned by the native runtime, but the installed native host is unavailable or incompatible. Update or reopen the native app; Malink will not create a duplicate Web Matrix device.",
    cause === undefined ? undefined : { cause },
  );
}

function nativeRuntimeOutdated(): Error {
  return new ConnectionFailureError(
    "matrix_native_runtime_outdated",
    "This Matrix session needs a newer native runtime. Update the native app; Malink will not create a duplicate Web Matrix device.",
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
