import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SessionOptionsButton,
  sessionModelLabel,
} from "../app/SessionOptionsButton.tsx";

const controls = [{
  id: "model",
  label: "Model",
  renderer: "select",
  surfaces: ["session-active"],
  status: "ready",
  options: [
    { value: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
    { value: "gpt-5.6-terra", label: "GPT-5.6-Terra" },
  ],
}] as const;

test("shows the active model on the session options button", () => {
  const html = renderToStaticMarkup(createElement(SessionOptionsButton, {
    controls,
    values: { model: "gpt-5.6-sol" },
    expanded: false,
    onClick() {},
  }));

  assert.match(html, />Model</);
  assert.match(html, />GPT-5\.6-Sol</);
  assert.match(html, /aria-label="Session options, current model GPT-5\.6-Sol"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, />▾</);
});

test("uses live control values and exposes the expanded state", () => {
  const liveControls = [{
    ...controls[0],
    value: "gpt-5.6-terra",
  }];
  const html = renderToStaticMarkup(createElement(SessionOptionsButton, {
    controls: liveControls,
    values: {},
    expanded: true,
    onClick() {},
  }));

  assert.equal(sessionModelLabel(liveControls, {}), "GPT-5.6-Terra");
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, />▴</);
});

test("keeps non-model session options discoverable", () => {
  const html = renderToStaticMarkup(createElement(SessionOptionsButton, {
    controls: [{
      id: "permissionMode",
      label: "Permission mode",
      renderer: "select",
      surfaces: ["session-active"],
      status: "ready",
      options: [{ value: "default", label: "Default" }],
    }],
    values: {},
    expanded: false,
    onClick() {},
  }));

  assert.match(html, /aria-label="Session options"/);
  assert.match(html, />Options</);
  assert.doesNotMatch(html, />Model</);
});
