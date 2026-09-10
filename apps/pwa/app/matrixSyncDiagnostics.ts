/** Bounded timings only: never retain URLs, access tokens, room IDs or events. */
type SyncTiming = {
  phase: "store" | "crypto" | "sync-ready" | "sync-request";
  elapsedMs: number;
  waitMs?: number | null;
  downloadMs?: number | null;
  usedSavedSync?: boolean;
  roomCount?: number;
};
const timings: SyncTiming[] = [];
function record(value: SyncTiming): void {
  timings.push(value);
  if (timings.length > 20) timings.shift();
}
export function readMatrixSyncTimings(): readonly SyncTiming[] {
  return timings.map(value => ({ ...value }));
}
export function startMatrixSyncDiagnostics(homeserver: string) {
  let previous = performance.now();
  const startedAt = previous;
  const origin = new URL(homeserver).origin;
  const observer = typeof PerformanceObserver !== "undefined" &&
    PerformanceObserver.supportedEntryTypes.includes("resource")
    ? new PerformanceObserver(list => {
        for (const entry of list.getEntries() as PerformanceResourceTiming[]) {
          const url = new URL(entry.name);
          if (entry.startTime < startedAt || url.origin !== origin || !/^\/_matrix\/client\/[^/]+\/sync$/.test(url.pathname)) continue;
          const detailed = entry.responseStart > 0 && entry.requestStart > 0;
          record({
            phase: "sync-request",
            elapsedMs: Math.round(entry.duration),
            // Cross-origin timing restrictions yield unknown, not zero latency.
            waitMs: detailed ? Math.round(entry.responseStart - entry.requestStart) : null,
            downloadMs: detailed ? Math.round(entry.responseEnd - entry.responseStart) : null,
          });
        }
      }) : null;
  observer?.observe({ type: "resource" });
  return {
    mark(phase: "store" | "crypto" | "sync-ready", details: Pick<SyncTiming, "usedSavedSync" | "roomCount"> = {}) {
      const now = performance.now();
      record({ phase, elapsedMs: Math.round(now - previous), ...details });
      previous = now;
    },
    stop() { observer?.disconnect(); },
  };
}
