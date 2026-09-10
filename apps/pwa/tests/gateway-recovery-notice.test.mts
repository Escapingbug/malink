import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GatewayRecoveryNotice, gatewayRecoveryNoticeReason } from "../app/GatewayRecoveryNotice.tsx";

test("recovery stays hidden for healthy, offline, unknown and transient states", () => {
  const base = { connected: true, hasRecovery: true, executionPhase: "steady" };
  assert.equal(gatewayRecoveryNoticeReason(base), null);
  assert.equal(gatewayRecoveryNoticeReason({ ...base, liveness: "unreachable", consecutiveNoReplies: 1 }), null);
  assert.equal(gatewayRecoveryNoticeReason({ ...base, connected: false, executionPhase: "attention" }), null);
  assert.equal(gatewayRecoveryNoticeReason({ ...base, hasRecovery: false, executionPhase: "attention" }), null);
  assert.equal(gatewayRecoveryNoticeReason({ ...base, executionPhase: "starting", liveness: "unreachable", consecutiveNoReplies: 4 }), null);
  assert.equal(gatewayRecoveryNoticeReason({ ...base, executionPhase: "attention" }), "failed");
  assert.equal(gatewayRecoveryNoticeReason({ ...base, deploymentPhase: "repair_required" }), "failed");
  assert.equal(gatewayRecoveryNoticeReason({ ...base, liveness: "unreachable", consecutiveNoReplies: 2 }), "unreachable");
});

test("recovery offers explicit buttons and does not automatically select a version", () => {
  let opened = false;
  const html = renderToStaticMarkup(React.createElement(GatewayRecoveryNotice, {
    reason: "failed", onOpen: () => { opened = true; },
  }));
  assert.match(html, /View recovery options/);
  assert.match(html, /Hide details/);
  assert.match(html, /aria-expanded="true"/);
  assert.equal(opened, false);
});
