type Snapshot = { received: number; applied: number; sessions: { sessionId: string; projectId?: string; targetEventId?: string; receiptEventId?: string; reason: string }[] };
let reader: (() => Snapshot) | undefined;
export function registerReadSyncDiagnostics(next: () => Snapshot): () => void { reader = next; return () => { if (reader === next) reader = undefined; }; }
export function readSyncDiagnostics(): Snapshot | null { return reader?.() ?? null; }
