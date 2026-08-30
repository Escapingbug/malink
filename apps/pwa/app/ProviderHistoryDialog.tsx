"use client";

import { FormEvent, useRef, useState } from "react";
import type {
  ProviderHistoryMessage,
  ProviderSessionEntry,
} from "@malink/protocol";
import { MarkdownContent } from "./MarkdownContent";
import { useDialogFocus } from "./dialogFocus";
import {
  groupProviderHistorySessions,
  providerHistorySessionKind,
  providerHistorySessionTimestamp,
} from "./providerHistorySessions";
import type { ProviderHistorySource } from "./providerHistoryRouting";

type ProviderOption = {
  id: string;
  name: string;
  canListSessions: boolean;
  canInspectSessions: boolean;
};

type Props = {
  open: boolean;
  sourceKey: string;
  sources: ProviderHistorySource[];
  provider: string;
  providers: ProviderOption[];
  sessions: ProviderSessionEntry[];
  selected: ProviderSessionEntry | null;
  messages: ProviderHistoryMessage[];
  loading: "sessions" | "session" | null;
  error: string | null;
  recoveryLabel?: string | null;
  onClose(): void;
  onSourceChange(sourceKey: string): void;
  onProviderChange(provider: string): void;
  onInspect(session: ProviderSessionEntry): void;
  onRetry(): void;
  onOpenManaged(sessionId: string): void;
  onContinue(session: ProviderSessionEntry, text: string): void;
};

export function ProviderHistoryDialog(props: Props) {
  if (!props.open) return null;
  return <ProviderHistoryDialogContent {...props} />;
}

function ProviderHistoryDialogContent({
  open,
  sourceKey,
  sources,
  provider,
  providers,
  sessions,
  selected,
  messages,
  loading,
  error,
  recoveryLabel = "Retry",
  onClose,
  onSourceChange,
  onProviderChange,
  onInspect,
  onRetry,
  onOpenManaged,
  onContinue,
}: Props) {
  const draftKey = `${sourceKey}\u0000${provider}\u0000${selected?.sessionId ?? ""}`;
  const [draftState, setDraftState] = useState({ key: draftKey, text: "" });
  const [mobilePreviewOpen, setMobilePreviewOpen] = useState(Boolean(selected));
  const draft = draftState.key === draftKey ? draftState.text : "";
  const dialogRef = useRef<HTMLElement>(null);
  const sourceRef = useRef<HTMLSelectElement>(null);
  const providerRef = useRef<HTMLSelectElement>(null);
  const sessionGroups = groupProviderHistorySessions(sessions);
  const selectedSource = sources.find(source => source.key === sourceKey) ?? null;
  const sourceGroups = sources.reduce<Array<{
    gatewayNodeId: string;
    gatewayLabel: string;
    sources: ProviderHistorySource[];
  }>>((groups, source) => {
    const existing = groups.find(group => group.gatewayNodeId === source.gatewayNodeId);
    if (existing) existing.sources.push(source);
    else groups.push({
      gatewayNodeId: source.gatewayNodeId,
      gatewayLabel: source.gatewayLabel,
      sources: [source],
    });
    return groups;
  }, []);
  useDialogFocus({
    open,
    containerRef: dialogRef,
    initialFocusRef: sourceRef,
    onEscape: onClose,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!selected || !text || loading === "session") return;
    setDraftState({ key: draftKey, text: "" });
    onContinue(selected, text);
  };

  return (
    <div
      className="new-session-backdrop provider-history-backdrop"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        ref={dialogRef}
        className="provider-history-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-history-title"
        aria-busy={loading !== null}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="eyebrow">Provider-owned history</span>
            <h2 id="provider-history-title">Provider sessions</h2>
            <p>
              {selectedSource
                ? `${selectedSource.gatewayLabel} · ${selectedSource.projectName}`
                : "Choose a computer and project to browse provider-owned history."}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close provider history">×</button>
        </header>

        <div className="provider-history-toolbar">
          <div className="provider-history-toolbar-fields">
            <label>
              <span>Computer / Project</span>
              <select
                ref={sourceRef}
                value={sourceKey}
                onChange={(event) => {
                  setMobilePreviewOpen(false);
                  onSourceChange(event.target.value);
                }}
              >
                {sourceGroups.map(group => (
                  <optgroup key={group.gatewayNodeId} label={group.gatewayLabel}>
                    {group.sources.map(source => (
                      <option key={source.key} value={source.key}>
                        {source.projectName} — {source.cwd}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <label>
              <span>Provider</span>
              <select
                ref={providerRef}
                value={provider}
                onChange={(event) => {
                  setMobilePreviewOpen(false);
                  onProviderChange(event.target.value);
                }}
              >
                {providers.map(option => (
                  <option key={option.id} value={option.id}>{option.name}</option>
                ))}
              </select>
            </label>
          </div>
          <small>
            {loading === "sessions"
              ? sessions.length === 0
                ? "Loading provider sessions in the background…"
                : "Refreshing provider sessions in the background…"
              : "Archiving in Malink never removes these provider copies."}
          </small>
        </div>

        <div
          className={`provider-history-body ${mobilePreviewOpen ? "is-preview-open" : ""}`}
        >
          <aside aria-label="Provider session list">
            {sessionGroups.map(group => (
              <section className={`provider-history-session-group is-${group.id}`} key={group.id}>
                <header>
                  <h3>{group.label}</h3>
                  <span>{group.sessions.length}</span>
                </header>
                {group.sessions.map(session => {
                  const kind = providerHistorySessionKind(session);
                  const timestamp = providerHistorySessionTimestamp(session);
                  const status = kind === "archived"
                    ? "Archived"
                    : kind === "active"
                      ? "Current in Malink"
                      : "Provider-only";
                  return (
                    <button
                      type="button"
                      key={session.sessionId}
                      className={selected?.sessionId === session.sessionId ? "selected" : ""}
                      onClick={() => {
                        setMobilePreviewOpen(true);
                        onInspect(session);
                      }}
                      disabled={
                        loading === "session"
                        && selected?.sessionId === session.sessionId
                      }
                    >
                      <strong>{session.title}</strong>
                      <small>
                        <span className={`provider-history-session-badge is-${kind}`}>{status}</span>
                        {timestamp > 0 && <time>{new Date(timestamp).toLocaleString()}</time>}
                      </small>
                    </button>
                  );
                })}
              </section>
            ))}
            {loading === "sessions" && sessions.length === 0 && (
              <p className="provider-history-empty">Loading provider sessions…</p>
            )}
            {loading === null && sessions.length === 0 && (
              <p className="provider-history-empty">No sessions were reported for this project.</p>
            )}
          </aside>

          <section className="provider-history-preview">
            <button
              type="button"
              className="provider-history-mobile-back"
              onClick={() => setMobilePreviewOpen(false)}
            >
              <span aria-hidden="true">←</span>
              Provider sessions
            </button>
            {error && (
              <div className="provider-history-error" role="alert">
                <p>{error}</p>
                {recoveryLabel && (
                  <button type="button" onClick={onRetry} disabled={loading !== null}>
                    {recoveryLabel}
                  </button>
                )}
              </div>
            )}
            {loading === "session" && <p className="provider-history-empty">Loading session history…</p>}
            {loading !== "session" && selected && (
              <>
                <header>
                  <div>
                    <strong>{selected.title}</strong>
                    <small>
                      {providerHistorySessionKind(selected) === "archived"
                        ? "Archived from Malink"
                        : providerHistorySessionKind(selected) === "active"
                          ? "Current in Malink"
                          : "Provider-only"}
                      {` · ${selected.cwd || provider}`}
                    </small>
                  </div>
                  {selected.managedSessionId && (
                    <button type="button" onClick={() => onOpenManaged(selected.managedSessionId!)}>
                      Open current session
                    </button>
                  )}
                </header>
                <div className="provider-history-messages">
                  {messages.map(message => (
                    <article key={message.id} className={`provider-history-message ${message.role}`}>
                      <span>{message.role === "user" ? "You" : provider}</span>
                      <MarkdownContent content={message.text} />
                    </article>
                  ))}
                  {messages.length === 0 && (
                    <p className="provider-history-empty">This provider returned no readable message content.</p>
                  )}
                </div>
                {!selected.managedSessionId && (
                  <form className="provider-history-composer" onSubmit={submit}>
                    <textarea
                      value={draft}
                      onChange={(event) => setDraftState({ key: draftKey, text: event.target.value })}
                      placeholder="Continue this provider session in Malink"
                      rows={2}
                    />
                    <button type="submit" disabled={!draft.trim() || loading === "session"}>
                      {selected.latestArchivedSessionId
                        ? "Continue as new Malink session"
                        : "Continue in Malink"}
                    </button>
                  </form>
                )}
              </>
            )}
            {loading === null && !selected && !error && (
              <p className="provider-history-empty">Choose a provider session to inspect it.</p>
            )}
            {loading === "sessions" && !selected && (
              <p className="provider-history-empty">You can close this window while sessions load.</p>
            )}
          </section>
        </div>
      </section>
    </div>
  );
}
