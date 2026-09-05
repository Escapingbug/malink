import type {
  ProviderControl,
  ProviderControlSurface,
  ProviderControlValues,
} from "@malink/protocol";
import type {
  GatewayCapabilityOption,
  GatewayCapabilities,
  GatewayModelCapability,
} from "./gatewayState";
import type { V3ProjectedProviderModelCatalog } from "./matrixMlp3Projection";

export function applyProviderModelCatalogs(
  capabilities: GatewayCapabilities,
  catalogs: readonly V3ProjectedProviderModelCatalog[],
  currentProvider?: string,
): GatewayCapabilities {
  const byProvider = new Map(catalogs.map(catalog => [catalog.providerId, catalog]));
  const expectedProviderIds = new Set(expectedProviderCatalogIds(capabilities));
  const recoveryObservedAt = Math.max(0, ...catalogs.map(catalog => catalog.occurredAt))
    || Date.now();
  const providers = capabilities.providers.map(provider => {
    const catalog = byProvider.get(provider.id);
    if (!catalog) {
      if (!expectedProviderIds.has(provider.id)) return provider;
      return {
        ...provider,
        controls: [
          catalogDiagnosticControl("loading", undefined, recoveryObservedAt),
          ...(provider.controls ?? [])
            .filter(control => control.id !== "model" && control.id !== "reasoningEffort")
            .map(control => structuredClone(control)),
        ],
      };
    }
    const models = catalog.models.map(model => ({
      id: model.id,
      name: model.name,
      ...(model.default_reasoning_level
        ? { defaultReasoningLevel: model.default_reasoning_level }
        : {}),
      supportedReasoningLevels: (model.supported_reasoning_levels ?? []).map(level => ({
        effort: level.effort,
        ...(level.description ? { description: level.description } : {}),
      })),
    }));
    return {
      ...provider,
      models,
      controls: controlsForProviderCatalog(provider.controls ?? [], catalog, models),
    };
  });
  const current = currentProvider
    ? providers.find(provider => provider.id === currentProvider)
    : undefined;
  return {
    ...capabilities,
    providers,
    ...(current
      ? { models: current.models, controls: current.controls }
      : {}),
  };
}

/**
 * Paginated-capability snapshots intentionally omit every provider's embedded
 * models. That shape is the compatibility signal that a signed Provider
 * Catalog must arrive before model selection is authoritative. Older Gateway
 * snapshots retain at least one embedded provider catalog and stay on the
 * legacy path.
 */
export function expectedProviderCatalogIds(
  capabilities: GatewayCapabilities,
): string[] {
  if (
    capabilities.providers.length === 0
    || capabilities.models.length > 0
    || capabilities.providers.some(provider => provider.models.length > 0)
  ) return [];
  return capabilities.providers.map(provider => provider.id);
}

export function providerCatalogsCoverProviders(
  catalogs: readonly V3ProjectedProviderModelCatalog[],
  expectedProviderIds: readonly string[],
): boolean {
  if (expectedProviderIds.length === 0) return true;
  const byProvider = new Map(catalogs.map(catalog => [catalog.providerId, catalog]));
  return [...new Set(expectedProviderIds)].every(providerId =>
    byProvider.get(providerId)?.complete === true,
  );
}

function controlsForProviderCatalog(
  controls: readonly ProviderControl[],
  catalog: V3ProjectedProviderModelCatalog,
  models: readonly GatewayModelCapability[],
): ProviderControl[] {
  const retained = controls
    .filter(control => control.id !== "model" && control.id !== "reasoningEffort")
    .map(control => structuredClone(control));
  if (!catalog.complete) {
    return [catalogDiagnosticControl("loading", undefined, catalog.occurredAt), ...retained];
  }
  if (catalog.status === "loading" || catalog.status === "error") {
    return [
      catalogDiagnosticControl(catalog.status, catalog.error, catalog.occurredAt),
      ...retained,
    ];
  }
  const catalogControls = legacyProviderControls(models, []).map(control => ({
    ...control,
    status: catalog.status,
    ...(catalog.error ? { error: structuredClone(catalog.error) } : {}),
  }));
  return [...catalogControls, ...retained];
}

function catalogDiagnosticControl(
  status: "loading" | "error",
  error?: import("@malink/protocol").ProviderControlError,
  occurredAt = Date.now(),
): ProviderControl {
  return {
    id: "model",
    label: "Model",
    renderer: "select",
    surfaces: ["project-default", "session-create", "session-active"],
    updateEffect: "next-turn",
    status,
    ...(status === "loading"
      ? { checkedAt: occurredAt, deadlineAt: occurredAt + 30_000 }
      : {
          error: structuredClone(error ?? {
            code: "catalog_failed",
            message: "The provider model catalog is unavailable.",
            retryable: true,
          }),
        }),
  };
}

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

/**
 * Session projections contain the controls that were known when the last
 * session event was published. Workspace capabilities are refreshed
 * independently, so a catalog-backed session control can otherwise remain
 * stuck on an older loading/error state forever.
 *
 * ACP session controls do not carry checkedAt and remain authoritative for an
 * active session (they contain the provider's actual current value/options).
 * For catalog-backed controls, prefer whichever snapshot was checked later.
 */
export function activeProviderControls(
  sessionControls: readonly ProviderControl[] = [],
  capabilityControls: readonly ProviderControl[] = [],
): ProviderControl[] {
  const merged = new Map<string, ProviderControl>();
  for (const control of capabilityControls) {
    merged.set(control.id, structuredClone(control));
  }
  for (const sessionControl of sessionControls) {
    const capabilityControl = merged.get(sessionControl.id);
    if (!capabilityControl || preferSessionControl(sessionControl, capabilityControl)) {
      merged.set(sessionControl.id, structuredClone(sessionControl));
      continue;
    }
    merged.set(sessionControl.id, {
      ...structuredClone(capabilityControl),
      ...(sessionControl.value === undefined ? {} : { value: sessionControl.value }),
    });
  }
  return [...merged.values()];
}

function preferSessionControl(
  sessionControl: ProviderControl,
  capabilityControl: ProviderControl,
): boolean {
  if (sessionControl.checkedAt === undefined) return true;
  if (capabilityControl.checkedAt === undefined) return false;
  return sessionControl.checkedAt >= capabilityControl.checkedAt;
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
