export function deviceSetupPresentation(restoring: boolean, error: string | null): "restoring" | "attention" | "setup" {
  return restoring ? "restoring" : error ? "attention" : "setup";
}

export function nativeHistoryRecoveryPages(detail?: string | null): number | null {
  const match = /^matrix_session_history_recovering_(\d+)$/.exec(detail ?? "");
  return match ? Number(match[1]) : null;
}

export function historyRecoveryPresentation({ loading, incomplete, messages, pages }: {
  loading: boolean;
  incomplete: boolean;
  messages: number;
  pages: number | null;
}): { tone: "progress" | "attention"; label: string; detail: string } | undefined {
  if (incomplete) return { tone: "attention", label: "Check history", detail: "Some saved task states could not be verified. Reconnect from connection settings; if this persists, export diagnostics. This does not establish whether the Agent is running or stopped." };
  if (!loading && pages === null) return undefined;
  return {
    tone: "progress", label: "Syncing",
    detail: `Connected; restoring history and checking saved task status. ${pages === null ? `${messages} messages loaded in this conversation.` : `${pages} history pages checked across conversations.`} The remaining total is not yet known. You can keep using Malink.`,
  };
}
