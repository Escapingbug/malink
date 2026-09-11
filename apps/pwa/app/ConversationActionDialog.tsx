"use client";
import { useRef, useState } from 'react';
import { useDialogFocus } from './dialogFocus';
import { useNativeBackHandler, NATIVE_BACK_PRIORITY } from './nativeBackNavigation';
import type { GatewaySessionSummary } from './gatewayState';
import { MAX_REFERENCE_CHARS, referenceTargets, type ConversationReference } from './conversationReference';

type Props = {
  source: GatewaySessionSummary;
  reference?: ConversationReference;
  sessions: readonly GatewaySessionSummary[];
  onClose(): void;
  onFork(title: string): void;
  onReference(target: GatewaySessionSummary): void;
};

export function ConversationActionDialog({ source, reference, sessions, onClose, onFork, onReference }: Props) {
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(`Branch · ${source.title}`.slice(0, 512));
  const [query, setQuery] = useState('');
  const [targetId, setTargetId] = useState('');
  const targets = referenceTargets(source, sessions);
  const target = targets.find(session => session.id === targetId);
  const tooLong = Boolean(reference && reference.text.length > MAX_REFERENCE_CHARS);
  useDialogFocus({ open: true, containerRef: dialogRef, initialFocusRef: inputRef, onEscape: onClose });
  useNativeBackHandler(true, () => { onClose(); return true; }, NATIVE_BACK_PRIORITY.nestedModal);
  return <div className="new-session-backdrop" onMouseDown={onClose}>
    <section ref={dialogRef} className="session-rename-dialog conversation-action-dialog" role="dialog"
      aria-modal="true" aria-labelledby="conversation-action-title" tabIndex={-1}
      onMouseDown={event => event.stopPropagation()}>
      <h2 id="conversation-action-title">{reference ? 'Quote in another conversation' : 'Create conversation branch'}</h2>
      <p className="conversation-action-source">From: {source.title}</p>
      {reference ? <>
        <p>Copy this answer’s text into a draft in the same project and provider. Review or remove it before sending. The source stays unchanged; attachments are not copied.</p>
        <details><summary>Preview quoted answer</summary><pre>{reference.text}</pre></details>
        {tooLong ? <p role="alert">This answer is too long to quote in one message. Copy a shorter excerpt instead (up to {MAX_REFERENCE_CHARS.toLocaleString()} characters).</p> : <>
          <label>Find a conversation<input ref={inputRef} value={query} onChange={event => setQuery(event.target.value)} placeholder="Search conversations" /></label>
          <div className="conversation-reference-targets" role="radiogroup" aria-label="Target conversation">
            {targets.filter(session => session.title.toLowerCase().includes(query.toLowerCase())).map(session =>
              <label key={session.id}><input type="radio" name="reference-target" checked={targetId === session.id} onChange={() => setTargetId(session.id)} />
                <span>{session.title}<small>{session.status === 'running' ? 'Running · draft only' : 'Open as draft'}</small></span></label>)}
          </div>
          {!targets.length && <p>No other open conversations use {source.provider} in this project. Create one first, then return to quote this answer.</p>}
          {targets.length > 0 && !targets.some(session => session.title.toLowerCase().includes(query.toLowerCase())) && <p>No matching conversations.</p>}
        </>}
      </> : <>
        <p>Create an independent {source.provider} conversation with its current saved history. Both conversations use the same project files; this does not create a Git branch or undo file changes.</p>
        <label>Branch name<input ref={inputRef} maxLength={512} value={title} onChange={event => setTitle(event.target.value)} /></label>
        <p>The new conversation opens when ready. You can archive or delete it from its conversation menu.</p>
      </>}
      <footer><button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
        <button type="button" className="primary-button" disabled={reference ? !target || tooLong : !title.trim()}
          onClick={() => reference ? target && onReference(target) : onFork(title.trim())}>
          {reference ? 'Add to draft' : 'Create branch'}
        </button>
      </footer>
    </section>
  </div>;
}
