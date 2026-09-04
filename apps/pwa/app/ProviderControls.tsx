"use client";

import { useEffect, useState } from "react";
import type {
  ProviderControl,
  ProviderControlSurface,
  ProviderControlValue,
  ProviderControlValues,
} from "@malink/protocol";

type Props = {
  controls: readonly ProviderControl[];
  surface: ProviderControlSurface;
  values: ProviderControlValues;
  disabled?: boolean;
  compact?: boolean;
  allowProviderDefault?: boolean;
  onChange(values: ProviderControlValues): void;
};

export function ProviderControls({
  controls,
  surface,
  values,
  disabled = false,
  compact = false,
  allowProviderDefault = surface !== "session-active",
  onChange,
}: Props) {
  const available = controls.filter(control => control.surfaces.includes(surface));
  const effectiveValues = effectiveControlValues(available, values);
  const now = useControlDeadlineClock(available);

  const update = (control: ProviderControl, value: ProviderControlValue | undefined) => {
    const next = { ...values };
    if (value === undefined) delete next[control.id];
    else next[control.id] = value;
    const option = control.options?.find(candidate => candidate.value === value);
    Object.assign(next, option?.defaults ?? {});
    pruneConditionalValues(available, next);
    onChange(next);
  };

  return (
    <div className={`provider-controls${compact ? " is-compact" : ""}`}>
      {available.map(control => {
        const options = visibleOptions(control, effectiveValues);
        if (
          control.status === "ready"
          && (control.renderer === "select" || control.renderer === "segmented")
          && options.length === 0
        ) return null;
        const value = effectiveValues[control.id];
        const loadingExpired = control.status === "loading"
          && control.deadlineAt !== undefined
          && control.deadlineAt <= now;
        const presentedControl = loadingExpired ? expiredLoadingControl(control) : control;
        return (
          <div
            className={`provider-control provider-control-${presentedControl.status}`}
            key={control.id}
            data-control-id={control.id}
          >
            {presentedControl.status === "loading" ? (
              <ControlDiagnostic control={presentedControl} loading />
            ) : presentedControl.status === "error" ? (
              <ControlDiagnostic control={presentedControl} />
            ) : (
              <>
                {control.renderer === "toggle" ? (
                  <label className="provider-control-toggle">
                    <input
                      type="checkbox"
                      checked={Boolean(value)}
                      disabled={disabled}
                      onChange={event => update(control, event.target.checked)}
                    />
                    <span>
                      <strong>{control.label}</strong>
                      {control.description && <small>{control.description}</small>}
                    </span>
                  </label>
                ) : control.renderer === "segmented" ? (
                  <fieldset className="provider-control-segmented">
                    <legend>{control.label}</legend>
                    <div>
                      {options.map(option => (
                        <label key={String(option.value)} title={option.description}>
                          <input
                            type="radio"
                            name={`provider-control-${control.id}`}
                            value={String(option.value)}
                            checked={value === option.value}
                            disabled={disabled}
                            onChange={() => update(control, option.value)}
                          />
                          <span>{option.label}</span>
                        </label>
                      ))}
                    </div>
                    {control.description && <small>{control.description}</small>}
                  </fieldset>
                ) : (
                  <label>
                    <span>{control.label}</span>
                    {control.renderer === "text" ? (
                      <input
                        value={typeof value === "string" ? value : ""}
                        disabled={disabled}
                        maxLength={4_096}
                        onChange={event => update(control, event.target.value)}
                      />
                    ) : (
                      <select
                        value={typeof value === "string" ? value : ""}
                        disabled={disabled}
                        onChange={event => update(
                          control,
                          options.find(option => String(option.value) === event.target.value)?.value,
                        )}
                      >
                        {(allowProviderDefault || value === undefined) && (
                          <option value="">Provider default</option>
                        )}
                        {options.map(option => (
                          <option key={String(option.value)} value={String(option.value)}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    )}
                    {control.description && <small>{control.description}</small>}
                  </label>
                )}
                {control.status === "stale" && <ControlDiagnostic control={control} />}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function useControlDeadlineClock(controls: readonly ProviderControl[]): number {
  const [now, setNow] = useState(() => Date.now());
  const nextDeadline = controls.reduce<number | undefined>((nearest, control) => {
    if (control.status !== "loading" || control.deadlineAt === undefined) return nearest;
    if (control.deadlineAt <= now) return nearest;
    if (nearest === undefined || control.deadlineAt < nearest) return control.deadlineAt;
    return nearest;
  }, undefined);

  useEffect(() => {
    if (nextDeadline === undefined || nextDeadline <= now) return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(0, nextDeadline - Date.now()) + 25,
    );
    return () => window.clearTimeout(timer);
  }, [nextDeadline, now]);

  return now;
}

function expiredLoadingControl(control: ProviderControl): ProviderControl {
  const deadline = control.deadlineAt === undefined
    ? "unknown"
    : new Date(control.deadlineAt).toISOString();
  return {
    ...control,
    status: "error",
    error: {
      code: "catalog_timeout",
      message: "The provider did not report its choices before the loading deadline. The Gateway may still be retrying or its latest update may not have arrived.",
      detail: `The last received loading state expired at ${deadline}.`,
      retryable: true,
    },
  };
}

function ControlDiagnostic({
  control,
  loading = false,
}: {
  control: ProviderControl;
  loading?: boolean;
}) {
  const stale = control.status === "stale";
  const retry = control.retryAt
    ? ` Automatic retry ${new Date(control.retryAt).toLocaleTimeString()}.`
    : "";
  const expectedSeconds = loading && control.deadlineAt && control.checkedAt
    ? Math.max(1, Math.ceil((control.deadlineAt - control.checkedAt) / 1_000))
    : null;
  const deadline = loading && control.deadlineAt
    ? expectedSeconds
      ? ` Expected within ${expectedSeconds} seconds (by ${new Date(control.deadlineAt).toLocaleTimeString()}).`
      : ` Expected by ${new Date(control.deadlineAt).toLocaleTimeString()}.`
    : "";
  return (
    <div
      className="provider-control-diagnostic"
      role={loading || stale ? "status" : "alert"}
    >
      {loading && <span className="button-spinner" aria-hidden="true" />}
      <span>
        <strong>
          {loading
            ? `Loading ${control.label.toLowerCase()}…`
            : stale
              ? `${control.label} choices may be out of date`
              : `${control.label} unavailable`}
        </strong>
        <small>
          {loading
            ? `${control.description ?? "Waiting for the provider to report its choices."}${deadline}`
            : stale
              ? `${control.error?.message ?? "Using the last choices reported by the provider."}${retry}`
              : `${control.error?.message ?? "The provider could not load this control."}${retry}`}
        </small>
        {!loading && control.error && (
          <>
            <code>{control.error.code}</code>
            {control.error.detail && (
              <details>
                <summary>Technical details</summary>
                <pre>{control.error.detail}</pre>
              </details>
            )}
          </>
        )}
      </span>
    </div>
  );
}

function effectiveControlValues(
  controls: readonly ProviderControl[],
  values: ProviderControlValues,
): ProviderControlValues {
  return Object.fromEntries(controls.flatMap(control => {
    const value = values[control.id] ?? control.value ?? control.defaultValue;
    return value === undefined ? [] : [[control.id, value]];
  }));
}

function visibleOptions(control: ProviderControl, values: ProviderControlValues) {
  return (control.options ?? []).filter(option => (
    !option.when || (
      values[option.when.controlId] !== undefined
      && option.when.values.includes(values[option.when.controlId]!)
    )
  ));
}

function pruneConditionalValues(
  controls: readonly ProviderControl[],
  values: ProviderControlValues,
): void {
  for (const control of controls) {
    if (control.renderer === "toggle" || control.renderer === "text") continue;
    const value = values[control.id];
    if (value === undefined) continue;
    const options = visibleOptions(control, values);
    if (options.some(option => option.value === value)) continue;
    const fallback = control.defaultValue ?? options[0]?.value;
    if (fallback === undefined) delete values[control.id];
    else values[control.id] = fallback;
  }
}
