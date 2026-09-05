"use client";

import { FormEvent, useRef, useState } from "react";
import type {
  JsonValue,
  ProviderControl,
  ProviderControlValues,
  SessionExtensionBinding,
  SessionExtensionDescriptor,
} from "@malink/protocol";
import { useDialogFocus } from "./dialogFocus";
import { BusyActionLabel } from "./OperationProgress";
import {
  type GatewayModelCapability,
  type GatewayWorkspaceState,
} from "./gatewayState";
import type { GatewayProjectOwner } from "./projectCatalog";
import { ProviderControls } from "./ProviderControls";
import {
  legacyProviderControls,
  submittableProviderControlValues,
} from "./providerControlCompatibility";

export type NewSessionInput = {
  projectId?: string;
  scope?: "project" | "scratch";
  cwd: string;
  projectName: string;
  provider: string;
  providerSessionId?: string;
  title?: string;
  initialPrompt?: string;
  model?: string;
  reasoningEffort?: string;
  controls?: ProviderControlValues;
  extensions?: SessionExtensionBinding[];
  setAsProjectDefault?: boolean;
};

type Props = {
  open: boolean;
  busy: boolean;
  fallbackGateway: GatewayProjectOwner;
  projectGateways: ReadonlyMap<string, GatewayProjectOwner>;
  workspace: GatewayWorkspaceState;
  workspaces?: GatewayWorkspaceState[];
  models: GatewayModelCapability[];
  providers: Array<{
    id: string;
    name: string;
    models: GatewayModelCapability[];
    controls?: ProviderControl[];
  }>;
  extensions: SessionExtensionDescriptor[];
  defaultExtensions?: SessionExtensionBinding[];
  canUpdateProjectDefaults?: boolean;
  onClose(): void;
  onReviewProviderIssue?(): void;
  onCreate(input: NewSessionInput): void;
};

export function NewSessionDialog(props: Props) {
  if (!props.open) return null;
  return <NewSessionDialogContent {...props} />;
}

function NewSessionDialogContent({
  open,
  busy,
  fallbackGateway,
  projectGateways,
  workspace,
  workspaces = [workspace],
  models: fallbackModels,
  providers: fallbackProviders,
  extensions: fallbackExtensions,
  defaultExtensions = [],
  canUpdateProjectDefaults = false,
  onClose,
  onReviewProviderIssue,
  onCreate,
}: Props) {
  const availableWorkspaces = workspaces.length > 0 ? workspaces : [workspace];
  const [projectId, setProjectId] = useState(workspace.projectId);
  const selectedWorkspace = availableWorkspaces.find(
    candidate => candidate.projectId === projectId,
  ) ?? workspace;
  const selectedGateway = projectGateways.get(selectedWorkspace.projectId)
    ?? fallbackGateway;
  const gatewayChoices = availableWorkspaces.reduce<Array<{
    gateway: GatewayProjectOwner;
    workspace: GatewayWorkspaceState;
  }>>((choices, candidate) => {
    const gateway = projectGateways.get(candidate.projectId) ?? fallbackGateway;
    if (!choices.some(choice => choice.gateway.gatewayNodeId === gateway.gatewayNodeId)) {
      choices.push({ gateway, workspace: candidate });
    }
    return choices;
  }, []);
  const models = selectedWorkspace.capabilities?.models ?? fallbackModels;
  const providers = selectedWorkspace.capabilities?.providers ?? fallbackProviders;
  const extensions = selectedWorkspace.capabilities?.sessionExtensions ?? fallbackExtensions;
  const [provider, setProvider] = useState(selectedWorkspace.provider);
  const providerModels = providers.find(entry => entry.id === provider)?.models ?? models;
  const providerControls = providers.find(entry => entry.id === provider)?.controls
    ?? (provider === selectedWorkspace.provider
      ? selectedWorkspace.capabilities?.controls
      : undefined)
    ?? legacyProviderControls(
      providerModels,
      selectedWorkspace.capabilities?.permissionModes ?? [],
    );
  const [controlValues, setControlValues] = useState<ProviderControlValues>(() => ({
    ...(selectedWorkspace.controlValues ?? {}),
    ...(selectedWorkspace.model ? { model: selectedWorkspace.model } : {}),
    ...(selectedWorkspace.reasoningEffort
      ? { reasoningEffort: selectedWorkspace.reasoningEffort }
      : {}),
    ...(selectedWorkspace.permissionMode
      ? { permissionMode: selectedWorkspace.permissionMode }
      : {}),
  }));
  const initialDefaultExtensions = selectedWorkspace.defaultExtensions ?? defaultExtensions;
  const [enabledExtensions, setEnabledExtensions] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(initialDefaultExtensions.map(binding => [binding.id, true])),
  );
  const [setAsProjectDefault, setSetAsProjectDefault] = useState(false);
  const [scope, setScope] = useState<"project" | "scratch">("project");
  const [extensionConfig, setExtensionConfig] = useState<
    Record<string, Record<string, JsonValue>>
  >(() =>
    Object.fromEntries(
      extensions.map((extension) => {
        const inherited = initialDefaultExtensions.find(binding => binding.id === extension.id);
        return [
          extension.id,
          {
            ...Object.fromEntries(
              extension.settings.flatMap((setting) =>
                setting.defaultValue === undefined
                  ? []
                  : [[setting.id, setting.defaultValue]],
              ),
            ),
            ...(inherited?.config ?? {}),
          },
        ];
      }),
    ),
  );
  const dialogRef = useRef<HTMLElement>(null);
  const providerSelectRef = useRef<HTMLSelectElement>(null);

  const requestClose = () => {
    if (!busy) onClose();
  };
  useDialogFocus({
    open,
    containerRef: dialogRef,
    initialFocusRef: providerSelectRef,
    escapeDisabled: busy,
    onEscape: requestClose,
  });

  const extensionConfigValid = extensions.every((extension) => {
    if (!enabledExtensions[extension.id]) return true;
    return extension.settings.every((setting) => {
      const value = extensionConfig[extension.id]?.[setting.id];
      return setting.type !== "text" || !setting.required ||
        (typeof value === "string" && value.trim().length > 0);
    });
  });
  const creatingWithProviderDefault = providerControls.some(control =>
    control.id === "model"
    && control.surfaces.includes("session-create")
    && control.status !== "ready"
    && control.status !== "stale",
  );

  if (!open) return null;
  const chooseWorkspace = (next: GatewayWorkspaceState) => {
    const nextCapabilities = next.capabilities;
    const nextExtensions = nextCapabilities?.sessionExtensions ?? fallbackExtensions;
    setProjectId(next.projectId);
    setProvider(next.provider);
    setControlValues({
      ...(next.controlValues ?? {}),
      ...(next.model ? { model: next.model } : {}),
      ...(next.reasoningEffort ? { reasoningEffort: next.reasoningEffort } : {}),
      ...(next.permissionMode ? { permissionMode: next.permissionMode } : {}),
    });
    setSetAsProjectDefault(false);
    setEnabledExtensions(Object.fromEntries(
      (next.defaultExtensions ?? []).map(binding => [binding.id, true]),
    ));
    setExtensionConfig(Object.fromEntries(
      nextExtensions.map(extension => {
        const inherited = (next.defaultExtensions ?? []).find(
          binding => binding.id === extension.id,
        );
        return [
          extension.id,
          {
            ...Object.fromEntries(extension.settings.flatMap(setting =>
              setting.defaultValue === undefined
                ? []
                : [[setting.id, setting.defaultValue]],
            )),
            ...(inherited?.config ?? {}),
          },
        ];
      }),
    ));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const submittedControls = submittableProviderControlValues(
      providerControls,
      "session-create",
      controlValues,
    );
    onCreate({
      projectId: selectedWorkspace.projectId,
      scope,
      cwd: selectedWorkspace.cwd,
      projectName: selectedWorkspace.projectName,
      provider,
      controls: submittedControls,
      ...(typeof submittedControls.model === "string" ? { model: submittedControls.model } : {}),
      ...(typeof submittedControls.reasoningEffort === "string"
        ? { reasoningEffort: submittedControls.reasoningEffort }
        : {}),
      extensions: extensions
        .filter((extension) => enabledExtensions[extension.id])
        .map((extension) => ({
          id: extension.id,
          config: extensionConfig[extension.id] ?? {},
        })),
      ...(scope === "project" && setAsProjectDefault
        ? { setAsProjectDefault: true }
        : {}),
    });
  };

  return (
    <div
      className="new-session-backdrop"
      role="presentation"
      onMouseDown={requestClose}
    >
      <section
        ref={dialogRef}
        className="new-session-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-session-title"
        aria-busy={busy}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="eyebrow">
              {scope === "scratch" ? "Computer · Temporary" : "Computer · Project"}
            </span>
            <h2 id="new-session-title">Create a session</h2>
            <p>{selectedGateway.label}</p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            aria-label="Close new session"
            disabled={busy}
          >
            ×
          </button>
        </header>

        <form onSubmit={submit}>
          <label className="scratch-session-toggle">
            <input
              type="checkbox"
              checked={scope === "scratch"}
              disabled={busy}
              onChange={(event) => {
                setScope(event.target.checked ? "scratch" : "project");
                if (event.target.checked) setSetAsProjectDefault(false);
              }}
            />
            <span>
              <strong>Temporary conversation</strong>
              <small>Use an isolated folder and keep this session outside project groups.</small>
            </span>
          </label>

          {scope === "project" ? <>
          <div className="new-session-grid">
            <label>
              <span>Project</span>
              {availableWorkspaces.length > 1 ? (
                <select
                  value={selectedWorkspace.projectId}
                  disabled={busy}
                  onChange={(event) => {
                    const next = availableWorkspaces.find(
                      candidate => candidate.projectId === event.target.value,
                    );
                    if (!next) return;
                    chooseWorkspace(next);
                  }}
                >
                  {availableWorkspaces.map(candidate => (
                    <option key={candidate.projectId} value={candidate.projectId}>
                      {candidate.projectName} — {
                        (projectGateways.get(candidate.projectId) ?? fallbackGateway).label
                      }
                    </option>
                  ))}
                </select>
              ) : (
                <input value={selectedWorkspace.projectName} disabled readOnly />
              )}
            </label>
            <label>
              <span>Working directory</span>
              <input value={selectedWorkspace.cwd} disabled readOnly />
            </label>
          </div>
          <small className="project-identity-note">
            Each project keeps its own durable Matrix room; all listed projects
            remain connected and manageable at the same time.
          </small>
          </> : <>
            <div className="new-session-grid">
              <label>
                <span>Gateway</span>
                <select
                  value={selectedGateway.gatewayNodeId}
                  disabled={busy || gatewayChoices.length < 2}
                  onChange={(event) => {
                    const next = gatewayChoices.find(
                      choice => choice.gateway.gatewayNodeId === event.target.value,
                    );
                    if (next) chooseWorkspace(next.workspace);
                  }}
                >
                  {gatewayChoices.map(choice => (
                    <option
                      key={choice.gateway.gatewayNodeId}
                      value={choice.gateway.gatewayNodeId}
                    >
                      {choice.gateway.label} · {choice.gateway.shortId}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <small className="project-identity-note scratch-identity-note">
              The selected Gateway creates a private working folder for this conversation.
              Archiving removes it from Malink while provider history remains available.
            </small>
          </>}

          <div className="new-session-grid two-columns">
            <label>
              <span>Provider</span>
              <select
                ref={providerSelectRef}
                value={provider}
                onChange={(event) => {
                  const nextProvider = event.target.value;
                  setProvider(nextProvider);
                  setControlValues(
                    nextProvider === selectedWorkspace.provider
                      ? {
                          ...(selectedWorkspace.controlValues ?? {}),
                          ...(selectedWorkspace.model ? { model: selectedWorkspace.model } : {}),
                          ...(selectedWorkspace.reasoningEffort
                            ? { reasoningEffort: selectedWorkspace.reasoningEffort }
                            : {}),
                          ...(selectedWorkspace.permissionMode
                            ? { permissionMode: selectedWorkspace.permissionMode }
                            : {}),
                        }
                      : {},
                  );
                  if (nextProvider !== selectedWorkspace.provider) setSetAsProjectDefault(false);
                }}
                disabled={busy || providers.length === 0}
              >
                {(providers.length > 0
                  ? providers
                  : [{ id: selectedWorkspace.provider, name: selectedWorkspace.provider, models }]
                ).map(entry => (
                  <option key={entry.id} value={entry.id}>{entry.name}</option>
                ))}
              </select>
            </label>
          </div>

          <ProviderControls
            controls={providerControls}
            surface="session-create"
            values={controlValues}
            disabled={busy}
            onReviewIssue={onReviewProviderIssue}
            onChange={setControlValues}
          />

          {extensions.length > 0 && (
            <fieldset className="session-extensions">
              <legend>Session extensions</legend>
              <p className="session-extensions-note">
                Project defaults are preselected. This session receives its own
                snapshot, so later project changes do not alter it.
              </p>
              {extensions.map((extension) => {
                const enabled = Boolean(enabledExtensions[extension.id]);
                return (
                  <section className="session-extension-option" key={extension.id}>
                    <label className="session-extension-toggle">
                      <input
                        type="checkbox"
                        checked={enabled}
                        disabled={busy}
                        onChange={(event) =>
                          setEnabledExtensions((current) => ({
                            ...current,
                            [extension.id]: event.target.checked,
                          }))
                        }
                      />
                      <span>
                        <strong>{extension.name}</strong>
                        <small>{extension.description}</small>
                      </span>
                    </label>
                    {enabled && extension.settings.length > 0 && (
                      <div className="session-extension-settings">
                        {extension.settings.map((setting) =>
                          setting.type === "boolean" ? (
                            <label className="session-extension-boolean" key={setting.id}>
                              <input
                                type="checkbox"
                                checked={Boolean(
                                  extensionConfig[extension.id]?.[setting.id],
                                )}
                                disabled={busy}
                                onChange={(event) =>
                                  setExtensionConfig((current) => ({
                                    ...current,
                                    [extension.id]: {
                                      ...current[extension.id],
                                      [setting.id]: event.target.checked,
                                    },
                                  }))
                                }
                              />
                              <span>{setting.label}</span>
                            </label>
                          ) : (
                            <label key={setting.id}>
                              <span>{setting.label}</span>
                              <input
                                value={String(
                                  extensionConfig[extension.id]?.[setting.id] ?? "",
                                )}
                                placeholder={setting.placeholder}
                                disabled={busy}
                                required={setting.required}
                                autoComplete="off"
                                onChange={(event) =>
                                  setExtensionConfig((current) => ({
                                    ...current,
                                    [extension.id]: {
                                      ...current[extension.id],
                                      [setting.id]: event.target.value,
                                    },
                                  }))
                                }
                              />
                              {setting.description && <small>{setting.description}</small>}
                            </label>
                          ),
                        )}
                      </div>
                    )}
                  </section>
                );
              })}
            </fieldset>
          )}

          {canUpdateProjectDefaults && scope === "project" && provider === selectedWorkspace.provider && (
            <label className="session-extension-boolean project-default-toggle">
              <input
                type="checkbox"
                checked={setAsProjectDefault}
                disabled={busy}
                onChange={(event) => setSetAsProjectDefault(event.target.checked)}
              />
              <span>Use these provider controls and extensions as the project defaults</span>
            </label>
          )}

          <footer>
            <button
              type="button"
              className="secondary-button"
              onClick={requestClose}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="primary-button"
              disabled={
                busy ||
                !extensionConfigValid
              }
            >
              {busy
                ? <BusyActionLabel>Creating…</BusyActionLabel>
                : creatingWithProviderDefault
                  ? "Create with provider default"
                  : "Create session"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

export type { NewSessionInput };
