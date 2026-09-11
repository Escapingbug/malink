/** Observe slow initialization as well as project recovery, without starting
 * duplicate work when an underlying readiness promise is still pending. */
export function observeConversationRecovery(options: {
  ensureReady(): Promise<void>;
  onReady(): void;
  onFailure(error: unknown): void;
  slowMs?: number;
  retryMs?: number;
}): () => void {
  let cancelled = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let slow: ReturnType<typeof setTimeout> | undefined;
  let failureReported = false;
  const check = async () => {
    slow = setTimeout(() => {
      if (!cancelled && !failureReported) {
        failureReported = true;
        options.onFailure(new Error(
          "Conversation readiness has not responded within 20 seconds. Initialization or project recovery is still pending.",
        ));
      }
    }, options.slowMs ?? 20_000);
    try {
      await options.ensureReady();
      if (!cancelled) options.onReady();
    } catch (error) {
      if (!cancelled) {
        failureReported = true;
        options.onFailure(error);
        retry = setTimeout(check, options.retryMs ?? 2_000);
      }
    } finally {
      clearTimeout(slow);
    }
  };
  void check();
  return () => {
    cancelled = true;
    clearTimeout(retry);
    clearTimeout(slow);
  };
}
