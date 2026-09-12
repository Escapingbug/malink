import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectedReference, referenceTargets } from '../app/conversationReference';
import { messageReferences } from '../app/ConversationReferences';
import { filterConversations } from '../app/ConversationPicker';
import type { GatewaySessionSummary } from '../app/gatewayState';
const source: GatewaySessionSummary = { id: 'source', title: 'Plan', provider: 'codex', projectId: 'p', projectName: 'P', cwd: '/repo', status: 'idle', updatedAt: 1, extensions: [], availableCommands: [] };
test('keeps selected answer and full conversation references structured, without injection text', () => {
  const reference = selectedReference({ session: source, messageId: 'answer-1', text: 'Result\n```ts\nconst a = 1\n```' });
  assert.equal(reference.text, 'Result\n```ts\nconst a = 1\n```');
  assert.equal(reference.kind, 'message');
  assert.equal(reference.sessionId, 'source');
  const conversation = selectedReference({ session: source });
  assert.equal(conversation.kind, 'session');
  assert.equal(conversation.text, undefined);
  assert.deepEqual(messageReferences({ references: [reference, conversation] }), [reference, conversation]);
  assert.deepEqual(messageReferences({ references: [{ ...conversation, text: 'unvalidated' }] }), []);
});
test('filters reference access and searches common picker by project and computer', () => {
  assert.deepEqual(referenceTargets(source, [source, { ...source, id: 'target' }, { ...source, id: 'other-provider', provider: 'agent' }, { ...source, id: 'other-project', projectId: 'q' }, { ...source, id: 'archive', status: 'archived' }]).map(session => session.id), ['target']);
  const choices = [1, 2].map(i => ({ key: String(i), title: 'Plan', projectId: 'p', projectName: 'Malink', computer: `Mac ${i}`, updatedAt: i }));
  assert.deepEqual(filterConversations(choices, 'malink mac 2').map(item => item.key), ['2']);
});
