"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDialogFocus } from "./dialogFocus";

export function SharedFileDialog({ files, sessions, onAttach, onClose }: {
  files: File[];
  sessions: Array<{ key: string; label: string }>;
  onAttach(key: string): void;
  onClose(): void;
}) {
  const [selected, setSelected] = useState("");
  const ref = useRef<HTMLElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useDialogFocus({ open: true, containerRef: ref, initialFocusRef: cancel, onEscape: onClose });
  const dialog = <div className="new-session-backdrop" role="presentation">
    <section ref={ref} className="new-session-dialog shared-file-dialog" role="dialog" aria-modal="true"
      aria-labelledby="shared-file-title" tabIndex={-1}>
      <h2 id="shared-file-title">Add shared files to a conversation</h2>
      {files.map((file, index) => <p key={index}>{file.name} · {Math.ceil(file.size / 1024)} KB</p>)}
      <p>This only adds an attachment draft. Enter a message and press Send to ask the Agent to inspect it.</p>
      <label>Conversation<select value={selected} onChange={event => setSelected(event.target.value)}>
        <option value="">Choose a conversation…</option>
        {sessions.map(session => <option key={session.key} value={session.key}>{session.label}</option>)}
      </select></label>
      {!sessions.length && <p>No active conversations are available. Connect to your Workspace, then reopen Malink to resume this share.</p>}
      <footer>
        <button ref={cancel} className="secondary-button" type="button" onClick={onClose}>Cancel share</button>
        <button type="button" className="primary-button" disabled={!sessions.some(s => s.key === selected)}
          onClick={() => onAttach(selected)}>Add attachments</button>
      </footer>
    </section>
  </div>;
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
