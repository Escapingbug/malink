import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationActionDialog } from '../../app/ConversationActionDialog';
import { referenceDraft } from '../../app/conversationReference';
import type { GatewaySessionSummary } from '../../app/gatewayState';
import '../../app/globals.css';
const source: GatewaySessionSummary = { id: 'source', title: 'Protocol design', projectId: 'project', projectName: 'Malink', provider: 'codex', cwd: '/repo', status: 'idle', updatedAt: 1, extensions: [], availableCommands: [] };
const reference = { session: source, messageId: 'answer-1', text: 'Use a durable command journal.\nValidate signatures before executing commands.\n'.repeat(8) };
const sessions = Array.from({ length: 35 }, (_, i) => ({ ...source, id: `target-${i}`, title: `Implementation ${String(i).padStart(2, '0')}` }));
function Fixture() {
 const [mode, setMode] = useState<'fork' | 'quote' | null>(null);
 const [draft, setDraft] = useState(''); const [result, setResult] = useState('');
 return <><button onClick={() => setMode('fork')}>Create branch</button><button onClick={() => setMode('quote')}>Quote…</button>
 <output>{result}</output><label>Draft<textarea value={draft} onChange={event => setDraft(event.target.value)} /></label>
 {mode && <ConversationActionDialog source={source} reference={mode === 'quote' ? reference : undefined}
 sessions={location.search.includes('empty') ? [] : sessions} onClose={() => setMode(null)}
 onFork={title => { setResult(`Created: ${title}`); setMode(null); }}
 onReference={target => { setDraft(referenceDraft(reference)); setResult(`Draft in ${target.title}`); setMode(null); }} />}</>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
