import {
  Component,
  useEffect,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import type { NativeUpdateStatus } from "@malink/native-bridge";
import {
  advanceNativeAppUpdate,
  exportNativeDiagnosticsIfAvailable,
} from "./client/createMalinkClient";

export type PwaStartupPhase =
  | "booting"
  | "preparing-state"
  | "rendering-workspace"
  | "ready"
  | "failed";

type StartupRecoveryBoundaryProps = {
  children: ReactNode;
};

type StartupRecoveryBoundaryState = {
  failed: boolean;
  error: unknown;
};

/**
 * React removes the existing root when an uncaught render error escapes. Keep
 * an independent recovery surface mounted so a production startup failure can
 * never degrade into an unactionable white WebView.
 */
export class StartupRecoveryBoundary extends Component<
  StartupRecoveryBoundaryProps,
  StartupRecoveryBoundaryState
> {
  state: StartupRecoveryBoundaryState = { failed: false, error: null };

  static getDerivedStateFromError(error: unknown): StartupRecoveryBoundaryState {
    return { failed: true, error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    reportPwaStartupFailure(error, info.componentStack ?? "");
  }

  render(): ReactNode {
    if (this.state.failed) {
      return <StartupFailureRecovery error={this.state.error} />;
    }
    return this.props.children;
  }
}

export function markPwaStartupPhase(
  phase: PwaStartupPhase,
  failureCode?: string,
): void {
  if (typeof document === "undefined") return;
  try {
    document.documentElement.dataset.malinkStartupPhase = phase;
    if (failureCode) {
      document.documentElement.dataset.malinkStartupFailure = failureCode;
    } else {
      delete document.documentElement.dataset.malinkStartupFailure;
    }
  } catch {
    // The recovery component remains renderable even in a hardened browser
    // that prevents document metadata changes.
  }
}

export function pwaStartupFailureCode(error: unknown): string {
  const normalized = error instanceof Error
    ? `${error.name}\0${error.message}`
    : `${typeof error}\0${String(error)}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `ui-start-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function reportPwaStartupFailure(
  error: unknown,
  componentStack = "",
): string {
  const code = pwaStartupFailureCode(error);
  markPwaStartupPhase("failed", code);
  // Android records the bounded code without copying exception text or
  // workspace data into diagnostics. The original error remains available in
  // an attached development console.
  console.error(`[malink/startup:${code}]`, error, componentStack);
  return code;
}

export function StartupRuntimeCommit({ children }: { children: ReactNode }) {
  useEffect(() => {
    markPwaStartupPhase("ready");
  }, []);
  return children;
}

export function StartupFailureRecovery({ error }: { error: unknown }) {
  const failureCode = pwaStartupFailureCode(error);
  const [updateState, setUpdateState] = useState<NativeUpdateStatus | null>(null);
  const updateStateRef = useRef<NativeUpdateStatus | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let timer: number | null = null;
    const refresh = async () => {
      try {
        const status = await advanceNativeAppUpdate({ installReady: false });
        if (mountedRef.current) {
          updateStateRef.current = status;
          setUpdateState(status);
        }
      } catch {
        // The GitHub release link below stays available if the native bridge
        // cannot answer this optional status read.
      }
    };
    void refresh();
    timer = window.setInterval(() => {
      if (nativeUpdateIsActive(updateStateRef.current)) void refresh();
    }, 1_000);
    return () => {
      mountedRef.current = false;
      if (timer !== null) window.clearInterval(timer);
    };
  }, []);

  const advanceUpdate = async () => {
    if (updateBusy) return;
    setUpdateBusy(true);
    setActionError(null);
    try {
      const installReady = updateState?.phase === "ready" ||
        updateState?.phase === "permission_required";
      const status = await advanceNativeAppUpdate(
        installReady ? {} : { checkNow: true, installReady: false },
      );
      if (mountedRef.current) {
        updateStateRef.current = status;
        setUpdateState(status);
      }
    } catch {
      if (mountedRef.current) {
        setActionError(
          "Android did not answer the update request. Open the official APK releases below.",
        );
      }
    } finally {
      if (mountedRef.current) setUpdateBusy(false);
    }
  };

  const exportDiagnostics = async () => {
    if (diagnosticsBusy) return;
    setDiagnosticsBusy(true);
    setActionError(null);
    try {
      const opened = await exportNativeDiagnosticsIfAvailable();
      if (!opened && mountedRef.current) {
        setActionError("Android could not open the diagnostics share sheet.");
      }
    } catch {
      if (mountedRef.current) {
        setActionError("Android did not answer the diagnostics request.");
      }
    } finally {
      if (mountedRef.current) setDiagnosticsBusy(false);
    }
  };

  return (
    <main className="upgrade-gate">
      <section className="upgrade-gate-card" role="alert">
        <div className="upgrade-gate-copy">
          <p className="eyebrow">Interface recovery</p>
          <h1>Malink could not finish opening</h1>
          <p>
            The hosted interface failed while opening the workspace. Your Android
            account, Matrix connection, queued actions, and native history remain intact.
          </p>
          <p>
            Failure code: <code>{failureCode}</code>
          </p>
          {updateState ? <p>{nativeUpdateSummary(updateState)}</p> : null}
          {actionError ? (
            <p className="upgrade-gate-error" role="alert">{actionError}</p>
          ) : null}
          <div className="upgrade-gate-actions">
            <button type="button" onClick={() => window.location.reload()}>
              Retry interface
            </button>
            <button
              type="button"
              disabled={updateBusy || nativeUpdateIsActive(updateState)}
              aria-busy={updateBusy || nativeUpdateIsActive(updateState)}
              onClick={() => void advanceUpdate()}
            >
              {nativeUpdateActionLabel(updateState, updateBusy)}
            </button>
            <button
              type="button"
              disabled={diagnosticsBusy}
              aria-busy={diagnosticsBusy}
              onClick={() => void exportDiagnostics()}
            >
              {diagnosticsBusy ? "Opening diagnostics…" : "Export diagnostics"}
            </button>
            <a
              className="button-link"
              href="https://github.com/Escapingbug/malink/releases"
              target="_blank"
              rel="noreferrer"
            >
              Open APK releases
            </a>
          </div>
        </div>
      </section>
    </main>
  );
}

function nativeUpdateIsActive(state: NativeUpdateStatus | null): boolean {
  return state?.phase === "checking" ||
    state?.phase === "available" ||
    state?.phase === "downloading" ||
    state?.phase === "installing";
}

function nativeUpdateActionLabel(
  state: NativeUpdateStatus | null,
  busy: boolean,
): string {
  if (busy) return "Checking Android app…";
  if (state?.phase === "ready" || state?.phase === "permission_required") {
    return "Install APK update";
  }
  if (state?.phase === "checking") return "Checking APK update…";
  if (state?.phase === "available" || state?.phase === "downloading") {
    return "Downloading APK update…";
  }
  if (state?.phase === "installing") return "Opening APK installer…";
  return state?.phase === "failed" ? "Retry APK check" : "Check APK update";
}

function nativeUpdateSummary(state: NativeUpdateStatus): string {
  switch (state.phase) {
    case "current":
      return "The installed Android app is up to date.";
    case "checking":
      return "Checking the official static release channel for an Android update.";
    case "available":
    case "downloading":
      return "A verified Android update is downloading in the native service.";
    case "ready":
      return "A verified Android update is ready to install.";
    case "permission_required":
      return "Allow Malink to install this verified Android update, then return here.";
    case "installing":
      return "Android is preparing the package installer.";
    case "failed":
      return `The last Android update attempt failed (${state.detailCode}).`;
  }
}
