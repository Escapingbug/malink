import type { GatewaySessionSummary } from './gatewayState';
import type { MalinkConversationReference } from '@malink/protocol';
export type ConversationReference = { session: GatewaySessionSummary; messageId?: string; text?: string };
export const MAX_REFERENCE_CHARS = 12_000;
export function referenceTargets(source: GatewaySessionSummary, sessions: readonly GatewaySessionSummary[]) {
  return sessions.filter(session => session.id !== source.id && session.projectId === source.projectId
    && session.provider === source.provider && session.status !== 'archived');
}
export function selectedReference(reference: ConversationReference): MalinkConversationReference {
  return { id: crypto.randomUUID(), sessionId: reference.session.id, title: reference.session.title,
    kind: reference.messageId ? 'message' : 'session',
    ...(reference.messageId ? { messageId: reference.messageId, text: reference.text } : {}) };
}
