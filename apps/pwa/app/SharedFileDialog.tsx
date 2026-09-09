"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDialogFocus } from "./dialogFocus";

export type ShareSession = { key: string; title: string; projectId: string; projectName: string; computer: string; updatedAt: number };

export function filterShareSessions(sessions: ShareSession[], query: string): ShareSession[] {
  const words = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
  return sessions.filter(s => words.every(word => `${s.title} ${s.projectName} ${s.computer}`.toLocaleLowerCase().includes(word)))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
}

export function SharedFileDialog({ files, sessions, onAttach, onClose }: {
  files: File[];
  sessions: ShareSession[];
  onAttach(key: string): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const matches = filterShareSessions(sessions, query);
  const groups = new Map<string, ShareSession[]>();
  for (const session of matches) {
    const key = JSON.stringify([session.computer, session.projectId]);
    groups.set(key, [...groups.get(key) ?? [], session]);
  }
  const ref = useRef<HTMLElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useDialogFocus({ open: true, containerRef: ref, initialFocusRef: cancel, onEscape: onClose });
  const dialog = <div className="new-session-backdrop" role="presentation">
    <section ref={ref} className="new-session-dialog shared-file-dialog" role="dialog" aria-modal="true"
      aria-labelledby="shared-file-title" tabIndex={-1}>
      <h2 id="shared-file-title">Add shared files to a conversation</h2>
      {files.map((file, index) => <p key={index}>{file.name} · {Math.ceil(file.size / 1024)} KB</p>)}
      <p>This only adds an attachment draft. Enter a message and press Send to ask the Agent to inspect it.</p>
      <label>Search conversations<input type="search" value={query} autoComplete="off"
        placeholder="Conversation, project, or computer" onChange={event => setQuery(event.target.value)} /></label>
      <small role="status">{matches.length} conversations · Select one to continue with your attachment draft</small>
      <div className="share-session-results" aria-label="Choose a conversation">
        {[...groups].map(([key, group]) => <section key={key} className="share-session-group">
          <button type="button" className="share-group-toggle" aria-expanded={Boolean(query.trim()) || !collapsed.has(key)}
            onClick={() => setCollapsed(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })}>
            <span><strong>{group[0].projectName || "Temporary"}</strong><small>{group[0].computer}</small></span>
            <span>{group.length} {collapsed.has(key) && !query.trim() ? "▸" : "▾"}</span>
          </button>
          {(query.trim() || !collapsed.has(key)) && group.map(session => <button type="button" key={session.key}
            className="share-session-choice" onClick={() => onAttach(session.key)}
            aria-label={`Share to ${session.title} — ${session.projectName} — ${session.computer}`}>
            <span className="session-avatar">{session.title.trim().slice(0, 2) || "NS"}</span>
            <span className="share-session-title"><strong>{session.title || "New session"}</strong>
              <small>{new Date(session.updatedAt).toLocaleString()}</small></span><span aria-hidden="true">›</span>
          </button>)}
        </section>)}
        {sessions.length > 0 && !matches.length && <p>No matching conversations. Try another title, project, or computer.</p>}
      </div>
      {!sessions.length && <p>No active conversations are available. Connect to your Workspace, then reopen Malink to resume this share.</p>}
      <footer>
        <button ref={cancel} className="secondary-button" type="button" onClick={onClose}>Cancel share</button>
      </footer>
    </section>
  </div>;
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
