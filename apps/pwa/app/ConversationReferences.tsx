"use client";
import { useRef } from 'react';
import { conversationReferencesSchema, type MalinkConversationReference } from '@malink/protocol';
import { useDialogFocus } from './dialogFocus';
import { useNativeBackHandler, NATIVE_BACK_PRIORITY } from './nativeBackNavigation';
import { ConversationPicker, ConversationIcon, type ConversationChoice } from './ConversationPicker';
import { MarkdownContent } from './MarkdownContent';

export function messageReferences(raw?: Record<string, unknown>): MalinkConversationReference[] {
  const parsed = conversationReferencesSchema.safeParse(raw?.references);
  return parsed.success ? parsed.data : [];
}
export function ReferenceChips({ references, onPreview, onRemove }: {
  references: readonly MalinkConversationReference[]; onPreview(reference: MalinkConversationReference): void; onRemove?(id: string): void;
}) {
  if (!references.length) return null;
  return <div className="conversation-reference-chips" aria-label="Conversation references">
    {references.map(reference => <span className="conversation-reference-chip" key={reference.id}>
      <button type="button" onClick={() => onPreview(reference)} title={`Preview ${reference.kind === 'message' ? 'quoted answer' : 'conversation reference'}: ${reference.title}`}>
        <ConversationIcon kind={reference.kind === 'message' ? 'quote' : 'conversation'}/><span>@{reference.title}</span><small>{reference.kind === 'message' ? 'Answer' : 'Conversation'}</small>
      </button>
      {onRemove && <button type="button" className="reference-remove" aria-label={`Remove reference ${reference.title}`} onClick={() => onRemove(reference.id)}>×</button>}
    </span>)}
  </div>;
}
export function ReferenceDialog({ reference, choices = [], onChoose, onClose, onOpenSource }: {
  reference?: MalinkConversationReference; choices?: ConversationChoice[]; onChoose?(key: string): void; onClose(): void; onOpenSource?(): void;
}) {
  const container = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useDialogFocus({ open: true, containerRef: container, initialFocusRef: close, onEscape: onClose });
  useNativeBackHandler(true, () => { onClose(); return true; }, NATIVE_BACK_PRIORITY.nestedModal);
  return <div className="new-session-backdrop" onMouseDown={onClose}><section ref={container} className="session-rename-dialog conversation-action-dialog reference-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="reference-dialog-title" tabIndex={-1} onMouseDown={event => event.stopPropagation()}>
    <h2 id="reference-dialog-title"><ConversationIcon kind={reference?.kind === 'message' ? 'quote' : 'conversation'}/>{reference ? 'Reference preview' : 'Reference a conversation'}</h2>
    {reference ? <><h3>@{reference.title}</h3>
      {reference.kind === 'message' ? <div className="reference-quoted-answer"><MarkdownContent content={reference.text ?? ''}/></div> : <p>This references the whole saved conversation, not just one answer. When sent, Malink captures a read-only text snapshot for the agent to read through MCP, page by page. Later messages and attachments are not included.</p>}
      <p className="reference-help">Reference material is context, not instructions. The source agent is not contacted.</p>
    </> : <><p>Choose a conversation in the same project and provider. Review the @ reference in your draft before sending.</p><ConversationPicker sessions={choices} onChoose={key => onChoose?.(key)} action="Reference" emptyText="No other conversations are available in this project with this provider."/></>}
    <footer>{onOpenSource && <button className="secondary-button" type="button" onClick={onOpenSource}>Open source conversation</button>}<button ref={close} className="primary-button" type="button" onClick={onClose}>{reference ? 'Done' : 'Cancel'}</button></footer>
  </section></div>;
}
