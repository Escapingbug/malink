/**
 * Runs one recovery for a burst of requests. Requests which arrive while the
 * task is running are collapsed into at most one trailing pass, so a newer
 * pointer cannot be lost behind an older in-flight snapshot fetch.
 */
export class CoalescingAsyncRunner {
  private requestedGeneration = 0;
  private completedGeneration = 0;
  private flight: Promise<void> | null = null;

  constructor(private readonly task: () => Promise<void>) {}

  run(): Promise<void> {
    const requestedGeneration = ++this.requestedGeneration;
    return this.waitFor(requestedGeneration);
  }

  private waitFor(requestedGeneration: number): Promise<void> {
    this.start();
    return this.flight!.then(() => {
      if (this.completedGeneration >= requestedGeneration) return;
      return this.waitFor(requestedGeneration);
    });
  }

  private start(): void {
    if (this.flight) return;
    // Defer the first pass by one microtask so workspace and project pointers
    // delivered in the same Matrix state batch become one recovery.
    const operation = Promise.resolve().then(() => this.drain());
    const settled = operation.finally(() => {
      if (this.flight === settled) this.flight = null;
    });
    this.flight = settled;
  }

  private async drain(): Promise<void> {
    while (this.completedGeneration < this.requestedGeneration) {
      const generation = this.requestedGeneration;
      try {
        await this.task();
      } catch (error) {
        // Every request which joined this failed pass observes the same
        // failure. A later Matrix update starts a fresh attempt.
        this.completedGeneration = this.requestedGeneration;
        throw error;
      }
      this.completedGeneration = generation;
    }
  }
}

/**
 * A durable Matrix cursor gap is possible only when a protocol first joins a
 * live browser connection. Once that gap has been checked successfully, the
 * ordered inbound chain owns every later event and a pointer refresh must not
 * rescan the complete thread directory.
 */
export class MatrixMlp3ThreadDirectoryRecovery {
  private readonly completed = new WeakSet<object>();
  private readonly flights = new WeakMap<object, Promise<void>>();

  ensure(target: object, recovery: () => Promise<void>): Promise<void> {
    if (this.completed.has(target)) return Promise.resolve();
    const existing = this.flights.get(target);
    if (existing) return existing;

    const operation = Promise.resolve()
      .then(recovery)
      .then(() => {
        this.completed.add(target);
      })
      .finally(() => {
        if (this.flights.get(target) === operation) this.flights.delete(target);
      });
    this.flights.set(target, operation);
    return operation;
  }
}
