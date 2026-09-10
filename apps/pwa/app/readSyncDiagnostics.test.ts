import { expect, it } from "vitest";
import { registerReadSyncDiagnostics, readSyncDiagnostics } from "./readSyncDiagnostics";
it("exports current read evidence and clears it on connection disposal", () => {
  const first = registerReadSyncDiagnostics(() => ({received: 1, applied: 0, sessions: []}));
  const next = registerReadSyncDiagnostics(() => ({received: 2, applied: 1, sessions: []}));
  first();
  expect(readSyncDiagnostics()?.received).toBe(2);
  next();
  expect(readSyncDiagnostics()).toBeNull();
});
