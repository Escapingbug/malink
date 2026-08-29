export type AutoHistoryLoadState = {
  scrollTop: number;
  hasMore: boolean;
  loading: boolean;
  checkingRemote: boolean;
  hasError: boolean;
};

export class HistoryOperationTimeoutError extends Error {
  constructor(readonly operation: string) {
    super(`${operation} did not finish in time.`);
    this.name = "HistoryOperationTimeoutError";
  }
}

/**
 * Browser persistence is an optimization boundary, not permission to keep the
 * conversation foreground busy forever. Keep the original promise observed so
 * a late rejection is consumed, while allowing the UI to move to an explicit
 * retry state after the bounded deadline.
 */
export function waitForHistoryOperation<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      reject(new HistoryOperationTimeoutError(label));
    }, timeoutMs);
    operation.then(
      (result) => {
        globalThis.clearTimeout(timeout);
        resolve(result);
      },
      (error) => {
        globalThis.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

/**
 * Top-of-feed pagination is a convenience only. A failed or already-running
 * remote archive check must require an explicit retry instead of turning
 * layout-driven scroll events into an unbounded request loop.
 */
export function shouldAutoLoadEarlierMessages(
  state: AutoHistoryLoadState,
): boolean {
  return state.scrollTop <= 80
    && state.hasMore
    && !state.loading
    && !state.checkingRemote
    && !state.hasError;
}
