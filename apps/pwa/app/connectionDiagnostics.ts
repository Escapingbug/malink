import type { MatrixConnectionStatus } from "./matrix";

export type ConnectionDiagnosticsInput = {
  buildVersion: string;
  status: MatrixConnectionStatus;
  detail?: string | null;
  deviceKeyId?: string | null;
  nativeRuntime?: {
    runtimeVersion: string;
    runtimeBuild: string;
  } | null;
  gateways?: readonly {
    gatewayNodeId: string;
    gatewayName: string;
    computerName?: string;
    buildId?: string;
  }[];
  online: boolean;
  visibility: DocumentVisibilityState;
  userAgent: string;
};

export function createConnectionDiagnostics(
  input: ConnectionDiagnosticsInput,
  now = Date.now(),
): string {
  const detailCode = input.detail && isMachineDetailCode(input.detail)
    ? boundedString(input.detail, 128)
    : null;
  return `${JSON.stringify({
    format: "malink-connection-diagnostics",
    version: 1,
    generatedAt: new Date(now).toISOString(),
    pwaBuild: boundedString(input.buildVersion, 128),
    connection: {
      status: input.status,
      detailCode,
      hasUnstructuredDetail: Boolean(input.detail && !detailCode),
    },
    device: {
      keyId: input.deviceKeyId
        ? boundedString(input.deviceKeyId, 256)
        : null,
      nativeRuntime: input.nativeRuntime
        ? {
            runtimeVersion: boundedString(
              input.nativeRuntime.runtimeVersion,
              128,
            ),
            runtimeBuild: boundedString(input.nativeRuntime.runtimeBuild, 128),
          }
        : null,
    },
    gateways: (input.gateways ?? []).slice(0, 256).map(gateway => ({
      nodeId: boundedString(gateway.gatewayNodeId, 512),
      name: boundedString(gateway.gatewayName, 128),
      computerName: gateway.computerName
        ? boundedString(gateway.computerName, 128)
        : null,
      buildId: gateway.buildId
        ? boundedString(gateway.buildId, 256)
        : null,
    })),
    browser: {
      online: input.online,
      visibility: input.visibility,
      userAgent: boundedString(input.userAgent, 512),
    },
  }, null, 2)}\n`;
}

function isMachineDetailCode(value: string): boolean {
  return /^(?:matrix|native|network)_[a-z0-9_]+$/.test(value);
}

function boundedString(value: string, maxLength: number): string {
  return value.slice(0, maxLength);
}
