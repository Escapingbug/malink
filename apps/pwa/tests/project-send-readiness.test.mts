import assert from "node:assert/strict";
import test from "node:test";
import { waitForProjectTransport } from "../app/projectSendReadiness.ts";

test("an already usable project sends without recovery traffic", async () => {
  const target = {};
  assert.equal(await waitForProjectTransport({ lookup: () => target, isAuthorized: () => true,
    recover: () => assert.fail("unnecessary recovery"), signal: new AbortController().signal }), target);
});

test("a restored conversation waits for its exact secondary project", async () => {
  const target = {};
  let ready = false;
  let requests = 0;
  const result = await waitForProjectTransport({ lookup: () => ready ? target : null,
    isAuthorized: () => true, recover: () => { requests++; setTimeout(() => { ready = true; }, 5); },
    signal: new AbortController().signal, intervalMs: 1 });
  assert.equal(result, target);
  assert.equal(requests, 1);
});

test("removed authorization rejects even a cached usable transport", async () => {
  await assert.rejects(waitForProjectTransport({ lookup: () => ({}), isAuthorized: () => false,
    recover: () => assert.fail(), signal: new AbortController().signal }), /no longer in/);
});

test("stopping a connection cancels waiting without sending", async () => {
  const controller = new AbortController();
  const pending = waitForProjectTransport({ lookup: () => null, isAuthorized: () => true,
    recover: () => setTimeout(() => controller.abort(), 1), signal: controller.signal });
  await assert.rejects(pending, /connection changed/);
});

test("unavailable project has a bounded wait and a single recovery request", async () => {
  let requests = 0;
  await assert.rejects(waitForProjectTransport({ lookup: () => null, isAuthorized: () => true,
    recover: () => { requests++; }, signal: new AbortController().signal,
    timeoutMs: 5, intervalMs: 1 }), /still recovering/);
  assert.equal(requests, 1);
});
