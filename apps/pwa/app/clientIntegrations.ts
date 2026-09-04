import {
  MALINK_CLIENT_INTEGRATION_PROTOCOL,
  clientIntegrationHostRequestSchema,
  integrationEntryPresentationSchema,
  type ClientIntegrationHostRequest,
  type ClientIntegrationLaunchMessage,
  type IntegrationEntryPresentation,
  type SessionExtensionDescriptor,
} from "@malink/protocol";

export type ClientIntegrationTarget = {
  integrationId: string;
  integrationName: string;
  origin: string;
  url: string;
  routeId: string;
  resourceRef: string;
  resourceVersion?: string;
  title: string;
  capabilities: readonly string[];
};

export type ClientIntegrationResolution =
  | { status: "ready"; target: ClientIntegrationTarget }
  | { status: "unavailable"; reason: string };

export function parseIntegrationEntryPresentation(
  raw: unknown,
): IntegrationEntryPresentation | undefined {
  const record = asRecord(raw);
  const candidate = record?.type === "assistant.message" ? record.ui : raw;
  const parsed = integrationEntryPresentationSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

export function resolveClientIntegration(
  entry: IntegrationEntryPresentation,
  extensions: readonly SessionExtensionDescriptor[],
  hostOrigin: string,
): ClientIntegrationResolution {
  const extension = extensions.find(candidate => candidate.id === entry.integrationId);
  if (!extension?.clientIntegration) {
    return {
      status: "unavailable",
      reason: `${entry.integrationId} is not installed with a client integration.`,
    };
  }
  const route = extension.clientIntegration.routes.find(
    candidate => candidate.id === entry.routeId,
  );
  if (!route) {
    return {
      status: "unavailable",
      reason: `${extension.name} does not provide the requested view.`,
    };
  }

  const declaredOrigin = new URL(extension.clientIntegration.origin).origin;
  if (declaredOrigin === hostOrigin) {
    return {
      status: "unavailable",
      reason: `${extension.name} must use a different origin from Malink.`,
    };
  }
  const url = new URL(route.path, `${declaredOrigin}/`);
  if (url.origin !== declaredOrigin) {
    return {
      status: "unavailable",
      reason: `${extension.name} declared an unsafe client route.`,
    };
  }
  return {
    status: "ready",
    target: {
      integrationId: extension.id,
      integrationName: extension.name,
      origin: declaredOrigin,
      url: url.toString(),
      routeId: entry.routeId,
      resourceRef: entry.resourceRef,
      ...(entry.resourceVersion ? { resourceVersion: entry.resourceVersion } : {}),
      title: entry.title,
      capabilities: extension.clientIntegration.capabilities,
    },
  };
}

export function clientIntegrationLaunchMessage(
  target: ClientIntegrationTarget,
  input: {
    locale: string;
    colorScheme: "light" | "dark";
  },
): ClientIntegrationLaunchMessage {
  const environment: ClientIntegrationLaunchMessage["environment"] = {};
  if (target.capabilities.includes("host.read-locale")) {
    environment.locale = input.locale;
  }
  if (target.capabilities.includes("host.read-theme")) {
    environment.colorScheme = input.colorScheme;
  }
  return {
    protocol: MALINK_CLIENT_INTEGRATION_PROTOCOL,
    version: 1,
    type: "launch",
    integrationId: target.integrationId,
    routeId: target.routeId,
    resourceRef: target.resourceRef,
    ...(target.resourceVersion ? { resourceVersion: target.resourceVersion } : {}),
    environment,
  };
}

export function parseClientIntegrationHostRequest(
  value: unknown,
): ClientIntegrationHostRequest | undefined {
  const parsed = clientIntegrationHostRequestSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
