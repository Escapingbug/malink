/** Owns asynchronous startup work until it settles, including timed-out work. */
export class MatrixStartupLifetime {
  readonly controller = new AbortController();
  readonly pending = new Set<Promise<unknown>>();

  assertActive(): void {
    if (this.controller.signal.aborted) {
      throw new DOMException("The Matrix connection was stopped.", "AbortError");
    }
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.assertActive();
    const pending = Promise.resolve().then(() => {
      this.assertActive();
      return operation();
    });
    this.pending.add(pending);
    try {
      const result = await pending;
      this.assertActive();
      return result;
    } finally {
      this.pending.delete(pending);
    }
  }

  async stop(): Promise<void> {
    this.controller.abort();
    await Promise.allSettled([...this.pending]);
  }
}
