import type { ProjectSendFailure } from "./projectRecoveryDiagnostics";
/** Wait for one exact project; never substitute another project's transport. */
export async function waitForProjectTransport<T>(options: {
  lookup: () => T | null;
  isAuthorized: () => boolean;
  recover: () => void;
  signal: AbortSignal;
  timeoutMs?: number;
  intervalMs?: number;
  onFailure?: (reason: ProjectSendFailure) => void;
  purpose?: "send" | "restore";
}): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  let recoveryRequested = false;
  for (;;) {
    if (options.signal.aborted) {
      options.onFailure?.("connection_changed");
      throw new Error(options.purpose === "restore"
        ? "The connection changed while restoring this conversation. Reconnecting…"
        : "The connection changed before this message was sent. Wait for reconnection, then retry this message.");
    }
    if (!options.isAuthorized()) {
      options.onFailure?.("unauthorized");
      throw new Error(options.purpose === "restore"
        ? "This conversation's project is not in the verified Workspace directory. Refresh the Workspace and check this project's computer."
        : "This conversation's project is no longer in the verified Workspace directory. The message was not sent. Refresh the Workspace and check this project's computer before retrying.");
    }
    const transport = options.lookup();
    if (transport) return transport;
    if (Date.now() >= deadline) {
      options.onFailure?.("transport_timeout");
      throw new Error(options.purpose === "restore"
        ? "This conversation is still restoring its verified project state. If recovery stays unavailable, export connection diagnostics."
        : "This conversation's project connection is still recovering. The message was not sent. Retry after the project reconnects; if it stays unavailable, export diagnostics.");
    }
    if (!recoveryRequested) {
      recoveryRequested = true;
      options.recover();
    }
    await new Promise<void>(resolve => {
      const finish = () => {
        clearTimeout(timer);
        options.signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, options.intervalMs ?? 100);
      options.signal.addEventListener("abort", finish, { once: true });
    });
  }
}
