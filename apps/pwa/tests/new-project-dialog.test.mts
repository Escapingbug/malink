import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NewProjectDialog } from "../app/NewProjectDialog.tsx";
import { NewSessionDialog } from "../app/NewSessionDialog.tsx";
import { ProjectSettingsDialog } from "../app/ProjectSettingsDialog.tsx";
import { gatewayProjectOwner } from "../app/projectCatalog.ts";

const gateways = [{
  gatewayNodeId: "gateway-a",
  gatewayName: "Office Gateway",
  computerName: "alice-macbook",
  targetProjectId: "bootstrap-a",
  providers: [{ id: "codex", name: "Codex" }],
  defaultProvider: "codex",
}, {
  gatewayNodeId: "gateway-b",
  gatewayName: "NAS Gateway",
  computerName: "home-nas",
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
  assert.match(html, /Office Gateway · alice-macbook/);
  assert.match(html, /This path is resolved on Office Gateway · alice-macbook/);
  assert.match(html, /Create the directory if it does not exist/);
  assert.match(html, /<button type="submit"[^>]*disabled=""[^>]*>Create project/);
});

test("shows the owning Gateway for every project session route", () => {
  const office = gatewayProjectOwner("gateway-a", "Office Gateway", "alice-macbook");
  const nas = gatewayProjectOwner("gateway-b", "NAS Gateway", "home-nas");
  const workspaces = [{
    projectId: "project-office",
    projectName: "Malink",
    cwd: "/work/malink",
    provider: "codex",
    permissionMode: "default",
  }, {
    projectId: "project-nas",
    projectName: "Archive",
    cwd: "/srv/archive",
    provider: "agent",
    permissionMode: "default",
  }];
  const html = renderToStaticMarkup(createElement(NewSessionDialog, {
    open: true,
    busy: false,
    fallbackGateway: office,
    projectGateways: new Map([
      ["project-office", office],
      ["project-nas", nas],
    ]),
    workspace: workspaces[1],
    workspaces,
    models: [],
    providers: [],
    extensions: [],
    onClose() {},
    onCreate() {},
  }));

  assert.match(html, /NAS Gateway · home-nas/);
  assert.match(html, /Malink — Office Gateway · alice-macbook/);
  assert.match(html, /Archive — NAS Gateway · home-nas/);
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

test("manages project metadata and defaults in one settings surface", () => {
  const html = renderToStaticMarkup(createElement(ProjectSettingsDialog, {
    open: true,
    busy: false,
    project: {
      projectId: "project-office",
      projectName: "Malink",
      cwd: "/work/malink",
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      permissionMode: "default",
      capabilities: {
        models: [{
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          supportedReasoningLevels: [{ effort: "high" }],
        }],
        providers: [],
        permissionModes: [],
        canCreateSession: true,
        canSelectSession: false,
        sessionExtensions: [],
      },
    },
    gatewayLabel: "Office Gateway · alice-macbook",
    fallbackModels: [],
    canDelete: true,
    onClose() {},
    onSave() {},
    onDelete() {},
  }));

  assert.match(html, /Manage project/);
  assert.match(html, /Office Gateway · alice-macbook/);
  assert.match(html, /Default model/);
  assert.match(html, /GPT-5.6 Sol/);
  assert.match(html, /One save sends one atomic project command/);
  assert.match(html, /Delete project/);
});
