import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/MalinkApp.tsx", import.meta.url), "utf8");

test("background history restoration shares the animated loading state", () => {
  assert.match(source, /historyLoading \|\| historyCheckingRemote \? "is-loading"/);
  assert.match(source, /aria-busy=\{historyLoading \|\| historyCheckingRemote\}/);
  assert.match(source, /\(historyLoading \|\| historyCheckingRemote\) && messages.length === 0 && !historyError/);
});

test("verified archive ends busy state before slow local cleanup, without repeating callbacks on retry", async () => {
  const start = source.indexOf("  async function settleSessionLifecycle(");
  const end = source.indexOf("  async function archiveSession(", start);
  assert.ok(start >= 0 && end > start);
  const code = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let busy = new Map([["project/session", "archive"]]);
  const recoveries = new Map();
  const notices: string[] = [];
  let retry: any;
  const deps = {
    waitForCommandCompletion: (value: unknown) => value,
    sessionLifecycleRecoveriesRef: { current: recoveries },
    sessionArchiveSucceeded: () => true,
    recoverUiNotice: () => {},
    updateSessionLifecycleBusy: (update: (state: Map<string, string>) => Map<string, string>) => { busy = update(busy); },
    sessionLifecycleRouteKey: () => "project/session",
    isMissingSessionCreateRecoveryCommand: () => false,
    rememberSessionLifecycleRecovery: (...args: unknown[]) => { retry = args; return args; },
    scheduleSessionLifecycleRecovery: () => {},
    showUiNotice: (...args: string[]) => { notices.push(args[0]); },
    completedCommandResultsRef: { current: new Map() },
    forgetRecoveredNativeCommand: () => {},
  };
  const settle = new Function(...Object.keys(deps), `${code}; return settleSessionLifecycle;`)(...Object.values(deps));
  let rejectCleanup!: (error: Error) => void;
  const cleanup = new Promise<void>((_, reject) => { rejectCleanup = reject; });
  let callbacks = 0;
  const pending = settle({ releaseCommand: () => cleanup },
    { commandId: "archive", completion: Promise.resolve({}) },
    "archive", "session", "project", () => { callbacks++; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(callbacks, 1);
  assert.equal(busy.size, 0, "local cleanup must not keep Archiving visible");
  rejectCleanup(new Error("local persistence unavailable"));
  await pending;
  assert.deepEqual(retry, ["archive", "archive", "session", "project"]);
  assert.ok(notices.includes("session:archive:release"));
});
