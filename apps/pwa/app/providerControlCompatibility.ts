import type {
  ProviderControl,
  ProviderControlSurface,
  ProviderControlValues,
} from "@malink/protocol";
import type {
  GatewayCapabilityOption,
  GatewayModelCapability,
} from "./gatewayState";

export function legacyProviderControls(
  models: readonly GatewayModelCapability[],
  permissionModes: readonly GatewayCapabilityOption[] = [],
): ProviderControl[] {
  if (models.length === 0 && permissionModes.length <= 1) return [];
  const controls: ProviderControl[] = [];
  if (models.length > 0) {
    controls.push({
      id: "model",
      label: "Model",
      renderer: "select",
      surfaces: ["project-default", "session-create", "session-active"],
      updateEffect: "next-turn",
      status: "ready",
      options: models.map(model => ({
        value: model.id,
        label: model.name,
        ...(model.defaultReasoningLevel
          ? { defaults: { reasoningEffort: model.defaultReasoningLevel } }
          : {}),
      })),
    });
    const reasoning = new Map<string, string[]>();
    for (const model of models) {
      for (const level of model.supportedReasoningLevels) {
        reasoning.set(level.effort, [...(reasoning.get(level.effort) ?? []), model.id]);
      }
    }
    if (reasoning.size > 0) {
      controls.push({
        id: "reasoningEffort",
        label: "Reasoning effort",
        renderer: "select",
        surfaces: ["project-default", "session-create", "session-active"],
        updateEffect: "next-turn",
        status: "ready",
        options: [...reasoning].map(([value, modelIds]) => ({
          value,
          label: value,
          when: { controlId: "model", values: modelIds },
        })),
      });
    }
  }
  if (permissionModes.length > 1) {
    controls.push({
      id: "permissionMode",
      label: "Permission mode",
      renderer: "select",
      surfaces: ["project-default", "session-create", "session-active"],
      updateEffect: "next-turn",
      status: "ready",
      options: permissionModes.map(mode => ({ value: mode.id, label: mode.name })),
      defaultValue: permissionModes.find(mode => mode.id === "default")?.id,
    });
  }
  return controls;
}

export function submittableProviderControlValues(
  controls: readonly ProviderControl[],
  surface: ProviderControlSurface,
  values: ProviderControlValues,
): ProviderControlValues {
  const submitted: ProviderControlValues = {};
  for (const control of controls) {
    if (
      !control.surfaces.includes(surface)
      || (control.status !== "ready" && control.status !== "stale")
    ) continue;
    const value = values[control.id];
    if (value === undefined) continue;
    if (control.renderer === "toggle") {
      if (typeof value === "boolean") submitted[control.id] = value;
      continue;
    }
    if (control.renderer === "text") {
      if (typeof value === "string") submitted[control.id] = value;
      continue;
    }
    const options = (control.options ?? []).filter(option =>
      !option.when || option.when.values.includes(values[option.when.controlId]!),
    );
    if (options.some(option => option.value === value)) {
      submitted[control.id] = value;
    }
  }
  return submitted;
}
