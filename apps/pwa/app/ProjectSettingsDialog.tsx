"use client";

import { FormEvent, useMemo, useRef, useState } from "react";
import type { ProviderControlValues } from "@malink/protocol";
import type { GatewayModelCapability, GatewayWorkspaceState } from "./gatewayState";
import { useDialogFocus } from "./dialogFocus";
import { BusyActionLabel } from "./OperationProgress";
import { ProviderControls } from "./ProviderControls";
import {
  legacyProviderControls,
  submittableProviderControlValues,
} from "./providerControlCompatibility";

export type ProjectSettingsInput = {
  name: string;
  model?: string | null;
  reasoningEffort?: string | null;
  controls: ProviderControlValues;
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
  onReviewProviderIssue?(): void;
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
  onReviewProviderIssue,
  onSave,
  onDelete,
}: Props) {
  const models = project.capabilities?.models ?? fallbackModels;
  const controls = project.capabilities?.providers.find(
    provider => provider.id === project.provider,
  )?.controls
    ?? project.capabilities?.controls
    ?? legacyProviderControls(models, project.capabilities?.permissionModes ?? []);
  const [name, setName] = useState(project.projectName);
  const initialControlValues: ProviderControlValues = {
    ...(project.controlValues ?? {}),
    ...(project.model ? { model: project.model } : {}),
    ...(project.reasoningEffort ? { reasoningEffort: project.reasoningEffort } : {}),
    ...(project.permissionMode ? { permissionMode: project.permissionMode } : {}),
  };
  const [controlValues, setControlValues] = useState(initialControlValues);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const changed = name.trim() !== project.projectName
    || JSON.stringify(controlValues) !== JSON.stringify(initialControlValues);

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
      const submittedControls = submittableProviderControlValues(
        controls,
        "project-default",
        controlValues,
      );
      const editableIds = new Set(controls
        .filter(control =>
          control.surfaces.includes("project-default")
          && (control.status === "ready" || control.status === "stale")
        )
        .map(control => control.id));
      onSave({
        name: name.trim(),
        ...(editableIds.has("model")
          ? { model: typeof submittedControls.model === "string" ? submittedControls.model : null }
          : {}),
        ...(editableIds.has("reasoningEffort")
          ? {
              reasoningEffort: typeof submittedControls.reasoningEffort === "string"
                ? submittedControls.reasoningEffort
                : null,
            }
          : {}),
        controls: submittedControls,
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
            <ProviderControls
              controls={controls}
              surface="project-default"
              values={controlValues}
              disabled={busy}
              onReviewIssue={onReviewProviderIssue}
              onChange={setControlValues}
            />
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
