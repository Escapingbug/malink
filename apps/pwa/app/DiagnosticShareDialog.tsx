"use client";

import { useRef, useState } from "react";
import { useDialogFocus } from "./dialogFocus";

export function DiagnosticShareDialog({ file, sessions, onAttach, onExternal, onClose }: {
  file: File;
  sessions: Array<{ key: string; label: string }>;
  onAttach(key: string): void;
  onExternal(): void;
  onClose(): void;
}) {
  const [selected, setSelected] = useState("");
  const ref = useRef<HTMLElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useDialogFocus({ open: true, containerRef: ref, initialFocusRef: cancel, onEscape: onClose });
  return <div className="new-session-backdrop" role="presentation">
    <section ref={ref} className="new-session-dialog" role="dialog" aria-modal="true"
      aria-labelledby="diagnostic-share-title" tabIndex={-1}>
      <h2 id="diagnostic-share-title">Add diagnostics to a conversation</h2>
      <p>{file.name} · {Math.ceil(file.size / 1024)} KB</p>
      <p>This only adds an attachment draft. Enter a message and press Send to ask the Agent to inspect it.</p>
      <label>Conversation<select value={selected} onChange={event => setSelected(event.target.value)}>
        <option value="">Choose a conversation…</option>
        {sessions.map(session => <option key={session.key} value={session.key}>{session.label}</option>)}
      </select></label>
      {!sessions.length && <p>No active conversations are available. Connect to your Workspace first, or save the report externally.</p>}
      <div className="new-session-actions">
        <button ref={cancel} type="button" onClick={onClose}>Cancel</button>
        <button type="button" onClick={onExternal}>Share or save externally…</button>
        <button type="button" className="primary-button" disabled={!sessions.some(s => s.key === selected)}
          onClick={() => onAttach(selected)}>Add attachment</button>
      </div>
    </section>
  </div>;
}
