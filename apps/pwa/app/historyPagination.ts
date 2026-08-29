export type AutoHistoryLoadState = {
  scrollTop: number;
  hasMore: boolean;
  loading: boolean;
  checkingRemote: boolean;
  hasError: boolean;
};

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
