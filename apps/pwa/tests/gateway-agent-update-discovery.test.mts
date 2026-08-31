import assert from "node:assert/strict";
import test from "node:test";
import { discoverLatestGatewayAgentUpdate } from "../app/gatewayAgentUpdateDiscovery.ts";

const signedPrompt = {
  update: {
    kind: "malink.gateway.agent-update",
    version: 1,
    releaseId: "2026.08.26.4",
    versionName: "2026.08.26.4",
    buildId: "gateway-2026.08.26.4-arm64",
    publishedAt: 42,
    platform: "darwin",
    repository: {
      url: "https://github.com/Escapingbug/malink.git",
      commit: "0123456789abcdef0123456789abcdef01234567",
    },
    prompt: "Build and validate this exact commit.",
    stateCatalog: [{ id: "state", stateClass: "ephemeral-ui", schemaVersion: 1 }],
  },
  signer: {
    version: 1,
    algorithm: "ES256",
    keyId: "a".repeat(43),
    publicKey: {
      kty: "EC",
      crv: "P-256",
      x: "b".repeat(43),
      y: "c".repeat(43),
    },
  },
  signature: {
    algorithm: "ES256",
    keyId: "a".repeat(43),
    value: "Aw",
  },
};

const signedChannel = {
  channel: {
    kind: "malink.gateway.agent-update-channel",
    version: 1,
    channelId: "stable",
    generation: 42,
    publishedAt: 42,
    release: {
      releaseId: "2026.08.26.4",
      buildId: "gateway-2026.08.26.4-arm64",
      sha256: "d".repeat(64),
    },
    mirrors: ["https://escapingbug.github.io/malink/gateway-agent-updates/"],
  },
  signer: signedPrompt.signer,
  signature: signedPrompt.signature,
};

test("discovers the published Gateway release from the signed channel", async () => {
  let request: { input: string; init?: RequestInit } | undefined;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    request = { input: String(input), init };
    return new Response(JSON.stringify(signedChannel), { status: 200 });
  }) as typeof fetch;

  assert.deepEqual(await discoverLatestGatewayAgentUpdate(fetcher), {
    releaseId: "2026.08.26.4",
    buildId: "gateway-2026.08.26.4-arm64",
  });
  assert.equal(request?.input, "/gateway-agent-updates/channels/stable.json");
  assert.equal(request?.init?.cache, "no-store");
});

test("discovers the Gateway release below a static-service base path", async () => {
  let requestUrl: string | undefined;
  const fetcher = (async (input: string | URL | Request) => {
    requestUrl = String(input);
    return new Response(JSON.stringify(signedChannel), { status: 200 });
  }) as typeof fetch;

  assert.deepEqual(
    await discoverLatestGatewayAgentUpdate(fetcher, undefined, "/malink/"),
    {
      releaseId: "2026.08.26.4",
      buildId: "gateway-2026.08.26.4-arm64",
    },
  );
  assert.equal(requestUrl, "/malink/gateway-agent-updates/channels/stable.json");
});

test("treats an unconfigured update route as no published release", async () => {
  const fetcher = (async () => new Response("missing", { status: 404 })) as typeof fetch;
  assert.equal(await discoverLatestGatewayAgentUpdate(fetcher), null);
});

test("falls back to the legacy latest Prompt while a channel route is being deployed", async () => {
  const requestedUrls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    requestedUrls.push(String(input));
    if (String(input).endsWith("/channels/stable.json")) {
      return new Response("missing", { status: 404 });
    }
    return new Response(JSON.stringify(signedPrompt), { status: 200 });
  }) as typeof fetch;

  assert.deepEqual(await discoverLatestGatewayAgentUpdate(fetcher), {
    releaseId: "2026.08.26.4",
    buildId: "gateway-2026.08.26.4-arm64",
  });
  assert.deepEqual(requestedUrls, [
    "/gateway-agent-updates/channels/stable.json",
    "/gateway-agent-updates/latest.json",
  ]);
});

test("rejects malformed discovery metadata", async () => {
  const fetcher = (async () => new Response(JSON.stringify({
    ...signedChannel,
    channel: { ...signedChannel.channel, generation: -1 },
  }), { status: 200 })) as typeof fetch;
  await assert.rejects(discoverLatestGatewayAgentUpdate(fetcher));
});
