import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationActionDialog } from '../../app/ConversationActionDialog';
import { selectedReference } from '../../app/conversationReference';
import { ReferenceChips, ReferenceDialog } from '../../app/ConversationReferences';
import { SharedFileDialog } from '../../app/SharedFileDialog';
import type { MalinkConversationReference } from '@malink/protocol';
import type { GatewaySessionSummary } from '../../app/gatewayState';
import '../../app/globals.css';
const source: GatewaySessionSummary = { id: 'source', title: 'Protocol design', projectId: 'project', projectName: 'Malink', provider: 'codex', cwd: '/repo', status: 'idle', updatedAt: Date.now(), extensions: [], availableCommands: [] };
const reference = { session: source, messageId: 'answer-1', text: 'Use a **durable command journal**.\nValidate signatures before executing commands.\n'.repeat(8) };
const sessions = Array.from({ length: 35 }, (_, i) => ({ ...source, id: `target-${i}`, title: `Implementation ${String(i).padStart(2, '0')}` }));
function Fixture() {
 const [mode, setMode] = useState<'fork' | 'quote' | 'session' | 'share' | null>(null);
 const [draft, setDraft] = useState('My existing question'); const [result, setResult] = useState('');
 const [references, setReferences] = useState<MalinkConversationReference[]>([]);
 const [preview, setPreview] = useState<MalinkConversationReference | null>(null);
 const available = location.search.includes('empty') ? [] : sessions;
 return <main style={{ padding: 16 }}><h1>Conversation</h1><button onClick={() => setMode('fork')}>Create branch</button><button onClick={() => setMode('quote')}>Quote…</button><button onClick={() => setMode('session')}>Reference conversation</button><button onClick={() => setMode('share')}>Share file</button>
 <output>{result}</output><ReferenceChips references={references} onPreview={setPreview} onRemove={id => setReferences(current => current.filter(reference => reference.id !== id))}/><label>Draft<textarea value={draft} onChange={event => setDraft(event.target.value)} /></label>
 {preview && <ReferenceDialog reference={preview} onClose={() => setPreview(null)} onOpenSource={() => { setPreview(null); setResult('Source opened'); }}/>}
 {mode === 'share' && <SharedFileDialog files={[new File(['x'], 'design.md')]} sessions={available.map(session => ({ key: session.id, title: session.title, projectId: session.projectId, projectName: session.projectName, computer: 'MacBook', updatedAt: session.updatedAt }))} onClose={() => setMode(null)} onAttach={key => { setResult(`Shared draft ${key}`); setMode(null); }}/>}
 {mode && mode !== 'share' && <ConversationActionDialog source={source} reference={mode === 'quote' ? reference : mode === 'session' ? { session: source } : undefined}
 sessions={available} onClose={() => setMode(null)} onFork={title => { setResult(`Created: ${title}`); setMode(null); }}
 onReference={target => { setReferences(current => [...current, selectedReference(mode === 'session' ? { session: source } : reference)]); setResult(`Draft in ${target.title}`); setMode(null); }} />}</main>;
}
const container = document.getElementById('root')! as HTMLElement & { fixtureRoot?: ReturnType<typeof createRoot> };
(container.fixtureRoot ??= createRoot(container)).render(<Fixture />);
