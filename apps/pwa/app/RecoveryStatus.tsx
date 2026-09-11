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
  return <div className="session-notices-conversation" role="status" aria-live="polite">
    <strong>{connected ? "Connected · Restoring history and task status" : "Restoring history and task status"}</strong>
    <p>{pages === null ? `${messages} messages loaded in this conversation.` : `${pages} history pages checked across conversations.`} The remaining total is not yet known. You can keep using Malink; cached task status is being verified.</p>
  </div>;
}
