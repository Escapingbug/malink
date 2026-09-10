import type * as MatrixSdk from "matrix-js-sdk";

/** SDK 41 stops Rust crypto before its async sync loop exits, and exposes no
 * join operation. Adapt its protected syncApi slot to retain that loop promise.
 * This also covers startup/cache replay, which need not emit STOPPED on abort.
 */
export function createManagedMatrixClient(
  sdk: typeof MatrixSdk,
  options: ConstructorParameters<typeof MatrixSdk.MatrixClient>[0],
) {
  return new (class extends sdk.MatrixClient {
    private syncTask: Promise<void> = Promise.resolve();
    private rejectSyncFailure!: (error: unknown) => void;
    readonly syncFailure = new Promise<never>((_resolve, reject) => { this.rejectSyncFailure = reject; });
    private stopping = false;

    constructor() {
      // Match createClient's scheduler default; legacy crypto is unused here.
      super({ ...options, scheduler: options.scheduler ?? new sdk.MatrixScheduler() });
      void this.syncFailure.catch(() => {});
      let transport = this.syncApi;
      Object.defineProperty(this, "syncApi", {
        configurable: true,
        get: () => transport,
        set: (next: typeof transport) => {
          transport = next;
          if (!next) return;
          const sync = next.sync.bind(next);
          next.sync = () => {
            const task = sync();
            this.syncTask = task;
            void task.catch(error => {
              if (!this.stopping) this.rejectSyncFailure(error);
            });
            return task;
          };
        },
      });
    }

    async stopAfterSync(): Promise<void> {
      this.stopping = true;
      this.syncApi?.stop();
      // The SDK already reports loop failures. A rejected loop has also exited.
      await Promise.allSettled([this.syncTask]);
      super.stopClient();
    }
  })();
}

type SyncSource = {
  getSyncState(): string | null;
  on(event: never, listener: never): unknown;
  off(event: never, listener: never): unknown;
};

/** Network retries belong to the SDK, not to a second client-restart loop. */
export function waitForRecoverableMatrixSync(
  client: SyncSource,
  syncEvent: string,
  signal: AbortSignal,
  onWaiting: (detail: string) => void,
  slowAfterMs = 30_000,
  isReady: () => boolean = () => true,
): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException("Connection stopped", "AbortError"));
  if (["PREPARED", "SYNCING"].includes(client.getSyncState() ?? "") && isReady()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      client.off(syncEvent as never, listener as never);
      signal.removeEventListener("abort", cancel);
    };
    const cancel = () => {
      cleanup();
      reject(new DOMException("Connection stopped", "AbortError"));
    };
    const listener = (state: string, _previous?: string, data?: { fromCache?: boolean; error?: { errcode?: string } }) => {
      if (state === "PREPARED" || state === "SYNCING") {
        if (isReady()) {
          cleanup();
          resolve();
        } else if (!data?.fromCache) {
          cleanup();
          reject(new Error("The bound Matrix project room is unavailable after syncing."));
        }
      } else if (state === "STOPPED") {
        cancel();
      } else if (state === "ERROR" || state === "RECONNECTING") {
        if (["M_UNKNOWN_TOKEN", "M_MISSING_TOKEN", "M_FORBIDDEN"].includes(data?.error?.errcode ?? "")) {
          cleanup();
          reject(new Error("Matrix authorization failed. Sign in again."));
        } else {
          onWaiting("Connection interrupted. Waiting for Matrix to resume syncing…");
        }
      }
    };
    const timer = setTimeout(() => {
      onWaiting("Syncing Workspace updates is taking longer than usual. Keeping the connection open…");
    }, slowAfterMs);
    client.on(syncEvent as never, listener as never);
    signal.addEventListener("abort", cancel, { once: true });
  });
}
