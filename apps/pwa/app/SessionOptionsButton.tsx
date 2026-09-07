"use client";

import type {
  ProviderControl,
  ProviderControlValues,
} from "@malink/protocol";

type Props = {
  controls: readonly ProviderControl[];
  values: ProviderControlValues;
  expanded: boolean;
  onClick(): void;
};

export function SessionOptionsButton({
  controls,
  values,
  expanded,
  onClick,
}: Props) {
  const model = sessionModelLabel(controls, values);
  const visibleLabel = model ?? "Options";

  return (
    <button
      type="button"
      className="composer-options-button session-options-button"
      aria-label={model
        ? `Session options, current model ${model}`
        : "Session options"}
      aria-expanded={expanded}
      aria-controls="composer-agent-options"
      onClick={onClick}
    >
      <span className="session-options-button-copy">
        {model && <small>Model</small>}
        <strong>{visibleLabel}</strong>
      </span>
      <span className="session-options-button-caret" aria-hidden="true">
        {expanded ? "▴" : "▾"}
      </span>
    </button>
  );
}

export function sessionModelLabel(
  controls: readonly ProviderControl[],
  values: ProviderControlValues,
): string | undefined {
  const control = controls.find(candidate =>
    candidate.id === "model"
    && candidate.surfaces.includes("session-active")
  );
  if (!control) return undefined;

  const value = values.model ?? control.value ?? control.defaultValue;
  if (typeof value !== "string" || value.length === 0) return undefined;
  const option = control.options?.find(candidate => candidate.value === value);
  return option?.label ?? value;
}
