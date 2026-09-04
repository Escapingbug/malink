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
              <ControlDiagnostic control={presentedControl} loading compact={compact} />
            ) : presentedControl.status === "error" ? (
              <ControlDiagnostic control={presentedControl} compact={compact} />
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
                      <SearchableSelect
                        control={control}
                        options={options}
                        value={value}
                        disabled={disabled}
                        compact={compact}
                        allowProviderDefault={allowProviderDefault}
                        onSelect={value => update(control, value)}
                      />
                    )}
                    {control.description && <small>{control.description}</small>}
                  </label>
                )}
                {control.status === "stale" && (
                  <ControlDiagnostic control={control} compact={compact} />
                )}
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
  return {
    ...control,
    status: "error",
    error: {
      code: "catalog_timeout",
      message: "The provider is taking longer than expected. The Gateway will keep retrying.",
      retryable: true,
    },
  };
}

function ControlDiagnostic({
  control,
  loading = false,
  compact = false,
}: {
  control: ProviderControl;
  loading?: boolean;
  compact?: boolean;
}) {
  const stale = control.status === "stale";
  const retry = control.retryAt
    ? ` Automatic retry ${new Date(control.retryAt).toLocaleTimeString()}.`
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
        {!compact && (
          <small>
            {loading
              ? "Waiting for the Gateway…"
              : stale
                ? `${control.error?.message ?? "Using the last available choices."}${retry}`
                : `${control.error?.message ?? "The provider could not load this control."}${retry}`}
          </small>
        )}
        {!compact && !loading && control.error?.detail && (
          <details>
            <summary>Technical details</summary>
            <pre>{control.error.detail}</pre>
          </details>
        )}
      </span>
    </div>
  );
}

const SEARCHABLE_OPTION_THRESHOLD = 20;
const OPTION_PAGE_SIZE = 40;

function SearchableSelect({
  control,
  options,
  value,
  disabled,
  compact,
  allowProviderDefault,
  onSelect,
}: {
  control: ProviderControl;
  options: NonNullable<ProviderControl["options"]>;
  value: ProviderControlValue | undefined;
  disabled: boolean;
  compact: boolean;
  allowProviderDefault: boolean;
  onSelect(value: ProviderControlValue | undefined): void;
}) {
  const [query, setQuery] = useState("");
  const [pagination, setPagination] = useState({ key: "", limit: OPTION_PAGE_SIZE });
  const searchable = options.length > SEARCHABLE_OPTION_THRESHOLD;
  const paginationKey = `${control.id}\u0000${query}`;
  const limit = pagination.key === paginationKey ? pagination.limit : OPTION_PAGE_SIZE;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = normalizedQuery
    ? options.filter(option =>
        option.label.toLocaleLowerCase().includes(normalizedQuery)
        || String(option.value).toLocaleLowerCase().includes(normalizedQuery))
    : options;
  const visible = searchable ? filtered.slice(0, limit) : filtered;
  const selected = options.find(option => option.value === value);
  const presented = selected && !visible.some(option => option.value === selected.value)
    ? [selected, ...visible]
    : visible;

  return (
    <span className={`provider-control-select${searchable ? " is-searchable" : ""}`}>
      {searchable && (
        <input
          type="search"
          value={query}
          disabled={disabled}
          aria-label={`Search ${control.label.toLowerCase()}`}
          placeholder={compact ? "Search…" : `Search ${options.length} choices…`}
          onChange={event => setQuery(event.target.value)}
        />
      )}
      <select
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        onChange={event => onSelect(
          options.find(option => String(option.value) === event.target.value)?.value,
        )}
      >
        {(allowProviderDefault || value === undefined) && (
          <option value="">Provider default</option>
        )}
        {presented.map(option => (
          <option key={String(option.value)} value={String(option.value)}>
            {option.label}
          </option>
        ))}
      </select>
      {searchable && (
        <small className="provider-control-page-status">
          {filtered.length === 0
            ? "No matches"
            : `${Math.min(limit, filtered.length)} of ${filtered.length}`}
          {visible.length < filtered.length && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => setPagination({
                key: paginationKey,
                limit: limit + OPTION_PAGE_SIZE,
              })}
            >
              Show more
            </button>
          )}
        </small>
      )}
    </span>
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
