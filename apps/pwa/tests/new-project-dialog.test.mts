import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NewProjectDialog } from "../app/NewProjectDialog.tsx";

const gateways = [{
  gatewayNodeId: "gateway-a",
  gatewayName: "Office Gateway",
  targetProjectId: "bootstrap-a",
  providers: [{ id: "codex", name: "Codex" }],
  defaultProvider: "codex",
}, {
  gatewayNodeId: "gateway-b",
  gatewayName: "NAS Gateway",
  targetProjectId: "bootstrap-b",
  providers: [{ id: "agent", name: "Agent" }],
  defaultProvider: "agent",
}];

test("creates projects against an explicitly selected Gateway route", () => {
  const html = renderToStaticMarkup(createElement(NewProjectDialog, {
    open: true,
    busy: false,
    gateways,
    onClose() {},
    onCreate() {},
  }));

  assert.match(html, /Create a project/);
  assert.match(html, /Office Gateway/);
  assert.match(html, /NAS Gateway/);
  assert.match(html, /Working directory on this Gateway/);
  assert.match(html, /This path is resolved on Office Gateway/);
  assert.match(html, /Create the directory if it does not exist/);
  assert.match(html, /<button type="submit"[^>]*disabled=""[^>]*>Create project/);
});

test("blocks dismissal while a durable project command is pending", () => {
  const html = renderToStaticMarkup(createElement(NewProjectDialog, {
    open: true,
    busy: true,
    gateways,
    onClose() {},
    onCreate() {},
  }));

  const closeButton = html.match(
    /<button(?=[^>]*aria-label="Close new project")[^>]*>/,
  )?.[0];
  assert.ok(closeButton);
  assert.match(closeButton, /disabled/);
  assert.match(html, /Creating…/);
});
