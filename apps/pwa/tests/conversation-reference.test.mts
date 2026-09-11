import assert from 'node:assert/strict';
import { test } from 'node:test';
import { referenceDraft, referenceTargets } from '../app/conversationReference';
import type { GatewaySessionSummary } from '../app/gatewayState';
const source: GatewaySessionSummary = { id: 'source', title: 'Plan', provider: 'codex', projectId: 'p', projectName: 'P', cwd: '/repo', status: 'idle', updatedAt: 1, extensions: [], availableCommands: [] };
test('quotes exact text with provenance and only offers same-project same-provider active destinations', () => {
  assert.deepEqual(referenceTargets(source, [source, { ...source, id: 'target' }, { ...source, id: 'other-provider', provider: 'agent' }, { ...source, id: 'other-project', projectId: 'q' }, { ...source, id: 'archive', status: 'archived' }]).map(session => session.id), ['target']);
  const draft = referenceDraft({ session: source, messageId: 'answer-1', text: 'Result\n```ts\nconst a = 1\n```' });
  assert.match(draft, /Source session: source/);
  assert.match(draft, /Source message: answer-1/);
  assert.match(draft, /> Result\n> ```ts\n> const a = 1\n> ```/);
  assert.match(draft, /attachments are not included/);
});
