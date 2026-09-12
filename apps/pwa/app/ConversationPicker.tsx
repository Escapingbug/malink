"use client";
import { useState } from 'react';

export type ConversationChoice = { key: string; title: string; projectId: string; projectName: string; computer: string; updatedAt: number; detail?: string };
export function filterConversations(sessions: readonly ConversationChoice[], query: string) {
  const words = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
  return sessions.filter(session => words.every(word => `${session.title} ${session.projectName} ${session.computer} ${session.detail ?? ''}`.toLocaleLowerCase().includes(word)))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
}
export function ConversationIcon({ kind = 'conversation' }: { kind?: 'conversation' | 'quote' | 'branch' }) {
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'quote' ? <><path d="M10 6H4v7h5c0 3-2 5-5 5M20 6h-6v7h5c0 3-2 5-5 5" /></> : kind === 'branch' ? <><circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10m0-5c8 0 12-1 12-5"/></> : <path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Z"/>}
  </svg>;
}
/** Shared by attachment sharing, answer quotation and whole-conversation references. */
export function ConversationPicker({ sessions, onChoose, action = 'Choose', emptyText = 'No conversations available.', selectedKey }: {
  sessions: readonly ConversationChoice[]; onChoose(key: string): void; action?: string; emptyText?: string; selectedKey?: string;
}) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const matches = filterConversations(sessions, query);
  const groups = new Map<string, ConversationChoice[]>();
  for (const session of matches) {
    const key = JSON.stringify([session.computer, session.projectId]);
    groups.set(key, [...groups.get(key) ?? [], session]);
  }
  return <div className="conversation-picker">
    <label className="conversation-picker-search"><ConversationIcon/><input type="search" aria-label="Search conversations" autoComplete="off" placeholder="Conversation, project, or computer" value={query} onChange={event => setQuery(event.target.value)}/></label>
    <small role="status">{matches.length} {matches.length === 1 ? 'conversation' : 'conversations'}</small>
    <div className="share-session-results" aria-label="Choose a conversation">
      {[...groups].map(([key, group]) => <section key={key} className="share-session-group">
        <button type="button" className="share-group-toggle" aria-expanded={Boolean(query.trim()) || !collapsed.has(key)} onClick={() => setCollapsed(current => { const next = new Set(current); next.has(key) ? next.delete(key) : next.add(key); return next; })}>
          <span><strong>{group[0].projectName || 'Temporary'}</strong><small>{group[0].computer}</small></span><span>{group.length} {collapsed.has(key) && !query.trim() ? '▸' : '▾'}</span>
        </button>
        {(query.trim() || !collapsed.has(key)) && group.map(session => <button type="button" key={session.key} className={`share-session-choice${selectedKey === session.key ? ' is-selected' : ''}`} onClick={() => onChoose(session.key)} aria-label={`${action} ${session.title} — ${session.projectName} — ${session.computer}`}>
          <span className="conversation-picker-icon"><ConversationIcon/></span><span className="share-session-title"><strong>{session.title || 'New session'}</strong><small>{session.detail || new Date(session.updatedAt).toLocaleString()}</small></span><span aria-hidden="true">{selectedKey === session.key ? '✓' : '›'}</span>
        </button>)}
      </section>)}
      {!sessions.length && <div className="conversation-picker-empty"><ConversationIcon/><p>{emptyText}</p></div>}
      {sessions.length > 0 && !matches.length && <div className="conversation-picker-empty"><p>No matching conversations. Try another title, project, or computer.</p><button type="button" onClick={() => setQuery('')}>Clear search</button></div>}
    </div>
  </div>;
}
