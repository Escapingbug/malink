"use client";

import { FormEvent, useRef, useState } from "react";
import { useDialogFocus } from "./dialogFocus";

export type ProjectCreationGateway = {
  gatewayNodeId: string;
  gatewayName: string;
  targetProjectId: string;
  providers: Array<{ id: string; name: string }>;
  defaultProvider: string;
};

export type NewProjectInput = {
  gatewayNodeId: string;
  targetProjectId: string;
  name: string;
  cwd: string;
  provider?: string;
  createDirectory: boolean;
};

type Props = {
  open: boolean;
  busy: boolean;
  gateways: ProjectCreationGateway[];
  onClose(): void;
  onCreate(input: NewProjectInput): void;
};

export function NewProjectDialog(props: Props) {
  if (!props.open) return null;
  return <NewProjectDialogContent {...props} />;
}

function NewProjectDialogContent({ open, busy, gateways, onClose, onCreate }: Props) {
  const first = gateways[0];
  const [gatewayNodeId, setGatewayNodeId] = useState(first?.gatewayNodeId ?? "");
  const selected = gateways.find(gateway => gateway.gatewayNodeId === gatewayNodeId) ?? first;
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [provider, setProvider] = useState(first?.defaultProvider ?? "");
  const [createDirectory, setCreateDirectory] = useState(true);
  const dialogRef = useRef<HTMLElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const requestClose = () => {
    if (!busy) onClose();
  };
  useDialogFocus({
    open,
    containerRef: dialogRef,
    initialFocusRef: nameRef,
    escapeDisabled: busy,
    onEscape: requestClose,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || !selected || !name.trim() || !cwd.trim()) return;
    onCreate({
      gatewayNodeId: selected.gatewayNodeId,
      targetProjectId: selected.targetProjectId,
      name: name.trim(),
      cwd: cwd.trim(),
      ...(provider ? { provider } : {}),
      createDirectory,
    });
  };

  return (
    <div className="new-session-backdrop" role="presentation" onMouseDown={requestClose}>
      <section
        ref={dialogRef}
        className="new-session-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-title"
        aria-busy={busy}
        tabIndex={-1}
        onMouseDown={event => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="eyebrow">Workspace · Project</span>
            <h2 id="new-project-title">Create a project</h2>
            <p>The project will stay attached to the selected Gateway.</p>
          </div>
          <button type="button" onClick={requestClose} aria-label="Close new project" disabled={busy}>
            ×
          </button>
        </header>

        <form onSubmit={submit}>
          <div className="new-session-grid">
            <label>
              <span>Gateway</span>
              <select
                value={selected?.gatewayNodeId ?? ""}
                disabled={busy || gateways.length < 2}
                onChange={event => {
                  const next = gateways.find(gateway => gateway.gatewayNodeId === event.target.value);
                  if (!next) return;
                  setGatewayNodeId(next.gatewayNodeId);
                  setProvider(next.defaultProvider);
                }}
              >
                {gateways.map(gateway => (
                  <option key={gateway.gatewayNodeId} value={gateway.gatewayNodeId}>
                    {gateway.gatewayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Project name</span>
              <input
                ref={nameRef}
                value={name}
                maxLength={256}
                disabled={busy}
                autoComplete="off"
                placeholder="Malink"
                onChange={event => setName(event.target.value)}
              />
            </label>
            <label>
              <span>Working directory on this Gateway</span>
              <input
                value={cwd}
                maxLength={4096}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                placeholder="/absolute/path/to/project"
                onChange={event => setCwd(event.target.value)}
              />
            </label>
            <p className="project-identity-note">
              This path is resolved on {selected?.gatewayName ?? "the selected Gateway"}, even when you create the project remotely.
            </p>
            {selected && selected.providers.length > 0 && (
              <label>
                <span>Default provider</span>
                <select value={provider} disabled={busy} onChange={event => setProvider(event.target.value)}>
                  {selected.providers.map(entry => (
                    <option key={entry.id} value={entry.id}>{entry.name}</option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <label className="scratch-session-toggle">
            <input
              type="checkbox"
              checked={createDirectory}
              disabled={busy}
              onChange={event => setCreateDirectory(event.target.checked)}
            />
            <span>
              <strong>Create the directory if it does not exist</strong>
              <small>The Gateway still validates that the final path is a directory.</small>
            </span>
          </label>

          <footer>
            <button type="button" className="secondary-button" onClick={requestClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="submit"
              className="primary-button"
              disabled={busy || !selected || !name.trim() || !cwd.trim()}
            >
              {busy ? "Creating…" : "Create project"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
