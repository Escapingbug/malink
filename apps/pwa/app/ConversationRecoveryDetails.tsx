import React from "react";
import { readProjectRecoveryDiagnostics } from "./projectRecoveryDiagnostics";

export function ConversationRecoveryDetails({ error, sessionId, projectId, exportBusy, onExport }: {
  error: string;
  sessionId: string | null;
  projectId: string | null;
  exportBusy: boolean;
  onExport(): void;
}) {
  // This snapshot already allowlists diagnostic fields; never show raw responses or secrets.
  const projects = readProjectRecoveryDiagnostics()
    .filter(connection => connection.stoppedAt === null)
    .flatMap(connection => connection.projects)
    .filter(project => project.projectId === projectId);
  return <div className="conversation-recovery-details">
    <p role="status">This conversation is not ready to send, even if Connect shows online.
      Malink will continue recovery automatically. If it stays blocked, export diagnostics.</p>
    <details>
      <summary>Recovery error details</summary>
      <p>{error}</p>
      <pre>{JSON.stringify({ sessionId, projectId, projects }, null, 2)}</pre>
    </details>
    <button type="button" disabled={exportBusy} aria-busy={exportBusy} onClick={onExport}>
      {exportBusy ? "Exporting diagnostics…" : "Export diagnostics"}
    </button>
  </div>;
}
