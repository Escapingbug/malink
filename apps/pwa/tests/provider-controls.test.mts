import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderControls } from "../app/ProviderControls.tsx";
import { submittableProviderControlValues } from "../app/providerControlCompatibility.ts";

test("omits controls the provider does not advertise", () => {
  const html = renderToStaticMarkup(createElement(ProviderControls, {
    controls: [],
    surface: "session-create",
    values: {},
    onChange() {},
  }));
  assert.doesNotMatch(html, /unsupported|not exposed|Model|Reasoning/i);
});

test("renders loading as progress and failures as actionable diagnostics", () => {
  const loading = renderToStaticMarkup(createElement(ProviderControls, {
    controls: [{
      id: "model",
      label: "Model",
      renderer: "select",
      surfaces: ["session-create"],
      status: "loading",
      checkedAt: Date.UTC(2030, 0, 1) - 10_000,
      deadlineAt: Date.UTC(2030, 0, 1),
    }],
    surface: "session-create",
    values: {},
    onChange() {},
  }));
  assert.match(loading, /button-spinner/);
  assert.match(loading, /Loading model/);
  assert.match(loading, /Expected within 10 seconds/);

  const failed = renderToStaticMarkup(createElement(ProviderControls, {
    controls: [{
      id: "model",
      label: "Model",
      renderer: "select",
      surfaces: ["session-create"],
      status: "error",
      error: {
        code: "executable_not_found",
        message: "The provider executable could not be found by the Gateway.",
        detail: "spawn agent ENOENT",
        retryable: true,
      },
    }],
    surface: "session-create",
    values: {},
    onChange() {},
  }));
  assert.match(failed, /Model unavailable/);
  assert.match(failed, /executable_not_found/);
  assert.match(failed, /Technical details/);
  assert.match(failed, /spawn agent ENOENT/);
});

test("shows dependent reasoning choices only for the selected model", () => {
  const html = renderToStaticMarkup(createElement(ProviderControls, {
    controls: [{
      id: "reasoningEffort",
      label: "Reasoning effort",
      renderer: "select",
      surfaces: ["session-create"],
      status: "ready",
      options: [{
        value: "high",
        label: "High",
        when: { controlId: "model", values: ["reasoning-model"] },
      }],
    }],
    surface: "session-create",
    values: { model: "plain-model" },
    onChange() {},
  }));
  assert.doesNotMatch(html, /Reasoning effort/);
});

test("keeps stale choices usable while explaining that they may be outdated", () => {
  const html = renderToStaticMarkup(createElement(ProviderControls, {
    controls: [{
      id: "model",
      label: "Model",
      renderer: "select",
      surfaces: ["session-create"],
      status: "stale",
      options: [{ value: "cached-model", label: "Cached model" }],
      error: {
        code: "catalog_timeout",
        message: "The provider did not return fresh choices in time.",
        retryable: true,
      },
    }],
    surface: "session-create",
    values: { model: "cached-model" },
    onChange() {},
  }));
  assert.match(html, /Cached model/);
  assert.match(html, /choices may be out of date/);
  assert.doesNotMatch(html, /Model unavailable/);
});

test("submits only values offered by ready controls on the current surface", () => {
  assert.deepEqual(submittableProviderControlValues([
    {
      id: "model",
      label: "Model",
      renderer: "select",
      surfaces: ["session-create"],
      status: "ready",
      options: [{ value: "current", label: "Current" }],
    },
    {
      id: "hidden",
      label: "Hidden",
      renderer: "text",
      surfaces: ["session-active"],
      status: "ready",
    },
  ], "session-create", {
    model: "removed-model",
    hidden: "do-not-submit",
  }), {});
});
