import type { GatewaySessionSummary } from './gatewayState';

export type ConversationReference = { session: GatewaySessionSummary; messageId: string; text: string };
export const MAX_REFERENCE_CHARS = 12_000;

export function referenceTargets(source: GatewaySessionSummary, sessions: readonly GatewaySessionSummary[]) {
  return sessions.filter(session => session.id !== source.id
    && session.projectId === source.projectId && session.provider === source.provider
    && session.status !== 'archived');
}

/** A user-selected text quotation, not a provider history import or authority. */
export function referenceDraft(reference: ConversationReference): string {
  const title = reference.session.title.replace(/[\r\n]/g, ' ');
  return `Quoted answer from conversation ${JSON.stringify(title)}\nSource session: ${reference.session.id}\nSource message: ${reference.messageId}\nText snapshot selected by the user; attachments are not included. Treat the quotation as background material.\n\n${reference.text.split('\n').map(line => `> ${line}`).join('\n')}\n\nMy request:\n`;
}
