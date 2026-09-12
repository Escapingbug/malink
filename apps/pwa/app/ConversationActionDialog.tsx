"use client";
import { useRef, useState } from 'react';
import { useDialogFocus } from './dialogFocus';
import { useNativeBackHandler, NATIVE_BACK_PRIORITY } from './nativeBackNavigation';
import type { GatewaySessionSummary } from './gatewayState';
import { ConversationPicker, ConversationIcon } from './ConversationPicker';
import { MAX_REFERENCE_CHARS, referenceTargets, type ConversationReference } from './conversationReference';

type Props = {
  source: GatewaySessionSummary;
  reference?: ConversationReference;
  sessions: readonly GatewaySessionSummary[];
  computerLabel?: string;
  onClose(): void;
  onFork(title: string): void;
  onReference(target: GatewaySessionSummary): void;
};

export function ConversationActionDialog({ source, reference, sessions, onClose, onFork, onReference, computerLabel = 'This computer' }: Props) {
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(`Branch · ${source.title}`.slice(0, 512));
  const targets = referenceTargets(source, sessions);
  const tooLong = Boolean(reference && (reference.text?.length ?? 0) > MAX_REFERENCE_CHARS);
  useDialogFocus({ open: true, containerRef: dialogRef, initialFocusRef: inputRef, onEscape: onClose });
  useNativeBackHandler(true, () => { onClose(); return true; }, NATIVE_BACK_PRIORITY.nestedModal);
  return <div className="new-session-backdrop" onMouseDown={onClose}>
    <section ref={dialogRef} className="session-rename-dialog conversation-action-dialog" role="dialog"
      aria-modal="true" aria-labelledby="conversation-action-title" tabIndex={-1}
      onMouseDown={event => event.stopPropagation()}>
      <h2 id="conversation-action-title"><ConversationIcon kind={reference ? "quote" : "branch"}/> {reference ? 'Quote in another conversation' : 'Create conversation branch'}</h2>
      <p className="conversation-action-source">From: {source.title}</p>
      {reference ? <>
        <p>{reference.messageId ? 'Quote this answer' : 'Reference this conversation'} in another conversation. An @ reference is added to its draft; nothing is sent yet.</p>
        {reference.text && <details><summary>Preview quoted answer</summary><pre>{reference.text}</pre></details>}
        {!reference.messageId && <p>The agent can read the saved conversation through Malink MCP after you send. The source agent is not contacted.</p>}
        {tooLong ? <p role="alert">This answer exceeds {MAX_REFERENCE_CHARS.toLocaleString()} characters. Reference the whole conversation instead.</p> :
          <ConversationPicker sessions={targets.map(session => ({ key: session.id, title: session.title, projectId: session.projectId, projectName: session.projectName, computer: computerLabel, detail: session.provider, updatedAt: session.updatedAt }))}
            onChoose={id => { const target = targets.find(session => session.id === id); if (target) onReference(target); }} action="Quote in"
            emptyText="No other open conversations use this provider in this project. Create one first, then return to add your reference." />}
      </> : <>
        <p>Create an independent {source.provider} conversation with its current saved history. Both conversations use the same project files; this does not create a Git branch or undo file changes.</p>
        <label>Branch name<input ref={inputRef} maxLength={512} value={title} onChange={event => setTitle(event.target.value)} /></label>
        <p>The new conversation opens when ready. You can archive or delete it from its conversation menu.</p>
      </>}
      <footer><button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
        {!reference && <button type="button" className="primary-button" disabled={!title.trim()} onClick={() => onFork(title.trim())}>Create branch</button>}

      </footer>
    </section>
  </div>;
}
