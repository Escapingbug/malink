export function deviceSetupPresentation(restoring: boolean, error: string | null): "restoring" | "attention" | "setup" {
  return restoring ? "restoring" : error ? "attention" : "setup";
}

export function nativeHistoryRecoveryPages(detail?: string | null): number | null {
  const match = /^matrix_session_history_recovering_(\d+)$/.exec(detail ?? "");
  return match ? Number(match[1]) : null;
}

export function RecoveryStatus({ connected, messages, pages }: {
  connected: boolean;
  messages: number;
  pages: number | null;
}) {
  return <details className="history-recovery-status">
    <summary aria-label="History sync in progress. Show or hide details">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M5.5 8a7 7 0 0 1 11.8-2L20 9M4 15l2.7 3A7 7 0 0 0 18.5 16" />
      </svg>
      <span>Syncing</span>
    </summary>
    <div className="history-recovery-details">
      <strong>{connected ? "Connected · Restoring history" : "Restoring history"}</strong>
      <p>{pages === null ? `${messages} messages loaded in this conversation.` : `${pages} history pages checked across conversations.`} The remaining total is not yet known.</p>
      <p>You can keep using Malink while saved task status is checked.</p>
    </div>
  </details>;
}
