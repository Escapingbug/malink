import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, commandPayloadSchema } from "@malink/protocol";
import {
  createArtifactMaterializeCommandPayload,
  createCancelCommandPayload,
  createPromptCommandPayload,
} from "../app/commandPayloads";

test("creates a stat-bound artifact materialization command", () => {
  const payload = commandPayloadSchema.parse(
    createArtifactMaterializeCommandPayload(
      "session-1",
      "reference-1",
      "revision-1",
    ),
  );

  assert.deepEqual(payload, {
    operation: "artifact.materialize",
    sessionId: "session-1",
    referenceId: "reference-1",
    expectedStatRevision: "revision-1",
  });
  assert.doesNotThrow(() => canonicalJson(payload));
});

test("omits undefined attachments from plain-text prompt commands", () => {
  const payload = commandPayloadSchema.parse(
    createPromptCommandPayload({
      sessionId: "session-1",
      text: "hello",
      attachments: undefined,
    }),
  );

  assert.equal(Object.hasOwn(payload, "attachments"), false);
  assert.doesNotThrow(() => canonicalJson(payload));
});

test("preserves defined attachments in prompt commands", () => {
  const payload = commandPayloadSchema.parse(
    createPromptCommandPayload({
      sessionId: "session-1",
      text: "hello",
      attachments: [],
    }),
  );

  if (payload.operation !== "prompt") {
    assert.fail("Expected a prompt command payload.");
  }
  assert.deepEqual(payload.attachments, []);
  assert.doesNotThrow(() => canonicalJson(payload));
});

test("preserves composer line breaks in prompt commands", () => {
  const payload = commandPayloadSchema.parse(
    createPromptCommandPayload({
      sessionId: "session-1",
      text: "first line\nsecond line\n\nfinal paragraph",
    }),
  );

  if (payload.operation !== "prompt") {
    assert.fail("Expected a prompt command payload.");
  }
  assert.equal(payload.text, "first line\nsecond line\n\nfinal paragraph");
});

test("creates canonical session lifecycle commands", () => {
  for (const operation of [
    "session.archive",
    "session.restore",
    "session.delete",
  ] as const) {
    const payload = commandPayloadSchema.parse({
      operation,
      sessionId: "session-1",
    });
    assert.deepEqual(payload, { operation, sessionId: "session-1" });
    assert.doesNotThrow(() => canonicalJson(payload));
  }
});

test("preserves the scratch scope on session creation", () => {
  const payload = commandPayloadSchema.parse({
    operation: "session.create",
    scope: "scratch",
  });
  assert.equal(payload.operation, "session.create");
  assert.equal(payload.scope, "scratch");
});

test("creates project defaults and provider-history commands", () => {
  assert.deepEqual(commandPayloadSchema.parse({
    operation: "project.settings",
    name: "Renamed",
    model: "gpt-5",
    reasoningEffort: "high",
    defaultExtensions: [{ id: "review" }],
  }), {
    operation: "project.settings",
    name: "Renamed",
    model: "gpt-5",
    reasoningEffort: "high",
    defaultExtensions: [{ id: "review" }],
  });
  assert.deepEqual(commandPayloadSchema.parse({
    operation: "project.delete",
  }), { operation: "project.delete" });
  assert.deepEqual(commandPayloadSchema.parse({
    operation: "provider.sessions.list",
    provider: "codex",
  }), {
    operation: "provider.sessions.list",
    provider: "codex",
  });
  assert.deepEqual(commandPayloadSchema.parse({
    operation: "provider.session.inspect",
    provider: "codex",
    providerSessionId: "provider-session-1",
  }), {
    operation: "provider.session.inspect",
    provider: "codex",
    providerSessionId: "provider-session-1",
  });
});

test("creates Gateway enrollment commands under the existing device-invite authority", () => {
  assert.deepEqual(commandPayloadSchema.parse({
    operation: "gateway.enrollment.invite",
    lifetimeMs: 300_000,
  }), {
    operation: "gateway.enrollment.invite",
    lifetimeMs: 300_000,
  });
  assert.deepEqual(commandPayloadSchema.parse({
    operation: "gateway.enrollment.approve",
    enrollmentId: "enrollment-1",
  }), {
    operation: "gateway.enrollment.approve",
    enrollmentId: "enrollment-1",
  });
});

test("creates a targeted Gateway profile update", () => {
  assert.deepEqual(commandPayloadSchema.parse({
    operation: "gateway.profile.update",
    gatewayNodeId: "gateway-node-1",
    gatewayName: "Office Mac",
  }), {
    operation: "gateway.profile.update",
    gatewayNodeId: "gateway-node-1",
    gatewayName: "Office Mac",
  });
  assert.throws(() => commandPayloadSchema.parse({
    operation: "gateway.profile.update",
    gatewayNodeId: "gateway-node-1",
    gatewayName: "   ",
  }));
});

test("provider is fixed after session creation", () => {
  assert.throws(() => commandPayloadSchema.parse({
    operation: "session.settings",
    sessionId: "session-1",
    provider: "other",
  }));
});

test("targets the active MLP/3 turn when stopping a session", () => {
  const payload = commandPayloadSchema.parse(
    createCancelCommandPayload("session-1", "turn-1"),
  );

  assert.deepEqual(payload, {
    operation: "cancel",
    sessionId: "session-1",
    targetCommandId: "turn-1",
  });
});
