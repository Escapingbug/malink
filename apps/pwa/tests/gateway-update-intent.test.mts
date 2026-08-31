import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  clearGatewayUpdateIntent,
  GATEWAY_UPDATE_INTENT_MAX_AGE_MS,
  readGatewayUpdateIntent,
  writeGatewayUpdateIntent,
} from "../app/gatewayUpdateIntent.ts";

test("persists a project-qualified update intent for reload-safe continuation", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  const intent = {
    version: 1 as const,
    workspaceId: "workspace-1",
    gatewayNodeId: "node-1",
    projectId: "project-1",
    releaseId: "release-2",
    buildId: "build-2",
    requestedAt: Date.now(),
  };

  assert.equal(writeGatewayUpdateIntent(storage, intent), true);
  assert.deepEqual(
    readGatewayUpdateIntent(storage, "workspace-1", "node-1"),
    intent,
  );
  assert.equal(clearGatewayUpdateIntent(storage, "workspace-1", "node-1"), true);
  assert.equal(readGatewayUpdateIntent(storage, "workspace-1", "node-1"), null);
});

test("does not adopt corrupt or cross-node update intent", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  writeGatewayUpdateIntent(storage, {
    version: 1,
    workspaceId: "workspace-1",
    gatewayNodeId: "node-1",
    projectId: "project-1",
    releaseId: "release-2",
    buildId: "build-2",
    requestedAt: Date.now(),
  });
  assert.equal(readGatewayUpdateIntent(storage, "workspace-1", "node-2"), null);
  assert.equal(readGatewayUpdateIntent({ getItem: () => "{" }, "workspace-1", "node-1"), null);
});

test("does not reuse an expired explicit update intent", () => {
  const requestedAt = 1_000;
  const encoded = JSON.stringify({
    version: 1,
    workspaceId: "workspace-1",
    gatewayNodeId: "node-1",
    projectId: "project-1",
    releaseId: "release-2",
    buildId: "build-2",
    requestedAt,
  });
  assert.equal(readGatewayUpdateIntent(
    { getItem: () => encoded },
    "workspace-1",
    "node-1",
    requestedAt + GATEWAY_UPDATE_INTENT_MAX_AGE_MS + 1,
  ), null);
});

test("keeps the explicit intent until the update command succeeds", () => {
  const source = readFileSync(
    new URL("../app/MalinkApp.tsx", import.meta.url),
    "utf8",
  );
  const flow = source.slice(
    source.indexOf("async function startGatewayUpdateNode"),
    source.indexOf("function openGatewayUpdateSession"),
  );
  const writeIndex = flow.indexOf("writeGatewayUpdateIntent(");
  const executeIndex = flow.indexOf("const status = stagedReleaseId");
  const clearIndex = flow.indexOf("clearGatewayUpdateIntent(");
  const catchFlow = flow.slice(flow.indexOf("} catch (error) {"));
  assert.ok(writeIndex >= 0, "the explicit update intent must be persisted");
  assert.ok(executeIndex > writeIndex, "the update must start after persistence");
  assert.ok(clearIndex > executeIndex, "success must clear the intent after execution");
  assert.equal(
    catchFlow.includes("clearGatewayUpdateIntent("),
    false,
    "an ambiguous command failure must retain the resumable update intent",
  );
});
