"use client";

import { FormEvent, useMemo, useRef, useState } from "react";
import type { GatewayModelCapability, GatewayWorkspaceState } from "./gatewayState";
import { useDialogFocus } from "./dialogFocus";
import { BusyActionLabel } from "./OperationProgress";

export type ProjectSettingsInput = {
  name: string;
  model: string | null;
  reasoningEffort: string | null;
};

type Props = {
  open: boolean;
  busy: boolean;
  project: GatewayWorkspaceState;
  gatewayLabel: string;
  fallbackModels: GatewayModelCapability[];
  canDelete: boolean;
  hasSessions: boolean;
  onClose(): void;
  onSave(input: ProjectSettingsInput): void;
  onDelete(): void;
};

export function ProjectSettingsDialog(props: Props) {
  if (!props.open) return null;
  return <ProjectSettingsDialogContent {...props} />;
}

function ProjectSettingsDialogContent({
  open,
  busy,
  project,
  gatewayLabel,
  fallbackModels,
  canDelete,
  hasSessions,
  onClose,
  onSave,
  onDelete,
}: Props) {
  const models = project.capabilities?.models ?? fallbackModels;
  const [name, setName] = useState(project.projectName);
  const [model, setModel] = useState(project.model ?? "");
  const [reasoningEffort, setReasoningEffort] = useState(project.reasoningEffort ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const selectedModel = models.find(entry => entry.id === model);
  const reasoningLevels = selectedModel?.supportedReasoningLevels ?? [];
  const changed = name.trim() !== project.projectName
    || model !== (project.model ?? "")
    || reasoningEffort !== (project.reasoningEffort ?? "");

  useDialogFocus({
    open,
    containerRef: dialogRef,
    initialFocusRef: nameRef,
    escapeDisabled: busy,
    onEscape: () => {
      if (confirmDelete) setConfirmDelete(false);
      else onClose();
    },
  });

  const deletionDescription = useMemo(() => (
    canDelete
      ? "This removes the project and retires its Matrix room from every connected device."
      : hasSessions
        ? "Archive every Malink session in this project before deleting it."
        : "A Gateway must retain its bootstrap control project and at least one project route."
  ), [canDelete, hasSessions]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!busy && changed && name.trim()) {
      onSave({
        name: name.trim(),
        model: model || null,
        reasoningEffort: reasoningEffort || null,
      });
    }
  };

  return (
    <div
      className="new-session-backdrop"
      role="presentation"
      onMouseDown={() => {
        if (!busy) onClose();
      }}
    >
      {confirmDelete ? (
        <section
          ref={dialogRef}
          className="session-delete-dialog project-delete-dialog"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="project-delete-title"
          aria-describedby="project-delete-description project-delete-boundary"
          onMouseDown={event => event.stopPropagation()}
        >
          <div className="danger-symbol" aria-hidden="true">!</div>
          <span className="eyebrow">Permanent action</span>
          <h2 id="project-delete-title">Delete “{project.projectName}”?</h2>
          <p id="project-delete-description">{deletionDescription}</p>
          <div id="project-delete-boundary" className="delete-boundary-note">
            The working directory and provider-side conversation copies are not erased. The
            Matrix room is removed from its members, then the Gateway leaves and forgets it.
          </div>
          <footer>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => setConfirmDelete(false)}
            >
              Back
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={busy || !canDelete}
              aria-busy={busy}
              onClick={onDelete}
            >
              {busy ? <BusyActionLabel>Deleting…</BusyActionLabel> : "Delete project"}
            </button>
          </footer>
        </section>
      ) : (
        <section
          ref={dialogRef}
          className="new-session-dialog project-settings-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="project-settings-title"
          onMouseDown={event => event.stopPropagation()}
        >
          <header>
            <div>
              <span className="eyebrow">Project settings</span>
              <h2 id="project-settings-title">Manage project</h2>
              <p>{gatewayLabel} · {project.cwd}</p>
            </div>
            <button type="button" aria-label="Close project settings" disabled={busy} onClick={onClose}>
              ×
            </button>
          </header>
          <form onSubmit={submit}>
            <label>
              <span>Name</span>
              <input
                ref={nameRef}
                value={name}
                maxLength={256}
                disabled={busy}
                onChange={event => setName(event.target.value)}
              />
            </label>
            <div className="new-session-grid two-columns">
              <label>
                <span>Default model</span>
                <select
                  value={model}
                  disabled={busy || models.length === 0}
                  onChange={event => {
                    const next = event.target.value;
                    const capability = models.find(entry => entry.id === next);
                    setModel(next);
                    setReasoningEffort(capability?.defaultReasoningLevel ?? "");
                  }}
                >
                  <option value="">Provider default</option>
                  {models.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                </select>
              </label>
              <label>
                <span>Reasoning effort</span>
                <select
                  value={reasoningEffort}
                  disabled={busy || reasoningLevels.length === 0}
                  onChange={event => setReasoningEffort(event.target.value)}
                >
                  <option value="">Model default</option>
                  {reasoningLevels.map(level => (
                    <option key={level.effort} value={level.effort}>{level.effort}</option>
                  ))}
                </select>
              </label>
            </div>
            <small className="project-identity-note">
              One save sends one atomic project command; conversations already created keep their own model.
            </small>
            <div className="project-settings-danger">
              <div>
                <strong>Delete project</strong>
                <small>{deletionDescription}</small>
              </div>
              <button
                type="button"
                className="danger-outline-button"
                disabled={busy || !canDelete}
                onClick={() => setConfirmDelete(true)}
              >
                Delete…
              </button>
            </div>
            <footer>
              <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>
                Cancel
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={busy || !changed || !name.trim()}
              >
                {busy ? <BusyActionLabel>Saving…</BusyActionLabel> : "Save changes"}
              </button>
            </footer>
          </form>
        </section>
      )}
    </div>
  );
}
