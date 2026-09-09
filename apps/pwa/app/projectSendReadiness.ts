/** Wait for one exact project; never substitute another project's transport. */
export async function waitForProjectTransport<T>(options: {
  lookup: () => T | null;
  isAuthorized: () => boolean;
  recover: () => void;
  signal: AbortSignal;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  let recoveryRequested = false;
  for (;;) {
    if (options.signal.aborted) {
      throw new Error("The connection changed before this message was sent. Wait for reconnection, then retry this message.");
    }
    if (!options.isAuthorized()) {
      throw new Error("This conversation's project is no longer in the verified Workspace directory. The message was not sent. Refresh the Workspace and check this project's computer before retrying.");
    }
    const transport = options.lookup();
    if (transport) return transport;
    if (Date.now() >= deadline) {
      throw new Error("This conversation's project connection is still recovering. The message was not sent. Retry after the project reconnects; if it stays unavailable, export diagnostics.");
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
