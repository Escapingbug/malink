import {
  signedGatewayAgentUpdateChannelSchema,
  signedGatewayAgentUpdatePromptSchema,
} from "@malink/protocol";
import { MALINK_BASE_PATH, type GatewayReleaseBuild } from "./buildInfo";

const STABLE_GATEWAY_AGENT_UPDATE_CHANNEL_PATH =
  "gateway-agent-updates/channels/stable.json";
const LATEST_GATEWAY_AGENT_UPDATE_PATH = "gateway-agent-updates/latest.json";
const MAX_PROMPT_BYTES = 128 * 1024;

export async function discoverLatestGatewayAgentUpdate(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
  basePath = MALINK_BASE_PATH,
): Promise<GatewayReleaseBuild | null> {
  const channel = await fetchDiscoveryMetadata(
    `${basePath}${STABLE_GATEWAY_AGENT_UPDATE_CHANNEL_PATH}`,
    fetcher,
    signal,
  );
  if (channel !== null) {
    const signed = signedGatewayAgentUpdateChannelSchema.parse(channel);
    return {
      releaseId: signed.channel.release.releaseId,
      buildId: signed.channel.release.buildId,
    };
  }
  const legacy = await fetchDiscoveryMetadata(
    `${basePath}${LATEST_GATEWAY_AGENT_UPDATE_PATH}`,
    fetcher,
    signal,
  );
  if (legacy === null) return null;
  const signed = signedGatewayAgentUpdatePromptSchema.parse(legacy);
  return {
    releaseId: signed.update.releaseId,
    buildId: signed.update.buildId,
  };
}

async function fetchDiscoveryMetadata(
  url: string,
  fetcher: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<unknown | null> {
  const response = await fetcher(url, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Gateway update discovery returned HTTP ${response.status}.`);
  }
  const advertisedLength = response.headers.get("content-length");
  if (advertisedLength !== null && Number(advertisedLength) > MAX_PROMPT_BYTES) {
    throw new Error("Gateway update discovery response is too large.");
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_PROMPT_BYTES) {
    throw new Error("Gateway update discovery response is too large.");
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error("Gateway update discovery returned invalid JSON.", { cause: error });
  }
}
