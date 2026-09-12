import type { GatewayDeploymentStatus } from "@malink/protocol";
import type { GatewayNodeLiveness } from "./gatewayNodeLiveness";
import { GATEWAY_ONLINE_PROOF_WINDOW_MS } from "./gatewayNodeLiveness";
import type { GatewayUpdateActiveAction, GatewayUpdateNodeRuntime } from "./GatewayUpdateDialog";

/** Presentation only: no probes, timers, command retries or execution authority. */
export function computerUserState(input: {
  connected: boolean;
  now: number;
  liveness?: GatewayNodeLiveness;
  runtime?: GatewayUpdateNodeRuntime;
  action?: GatewayUpdateActiveAction;
  currentBuild?: string;
  targetBuild?: string;
  deployment?: GatewayDeploymentStatus;
}) {
  const { runtime, liveness, now, action, deployment } = input;
  const status = runtime?.status;
  const tracks = status?.executionTracks;
  const fresh = (time?: number) => time !== undefined && time <= now && now - time <= GATEWAY_ONLINE_PROOF_WINDOW_MS;
  const installed = Boolean(input.targetBuild && (status?.currentBuildId ?? input.currentBuild) === input.targetBuild);
  const complete = installed && (!tracks || tracks.phase === "steady") && status?.phase !== "repair_required" && action !== "select_version";
  const previousUpdate = status?.targetBuildId && input.targetBuild && status.targetBuildId !== input.targetBuild &&
    ["staged", "committed", "rolled_back", "failed"].includes(status.phase);
  const phase = complete ? "committed" : previousUpdate ? "idle" : status?.phase;
  const switching = action === "select_version" ||
    (fresh(status?.updatedAt) && (tracks?.phase === "activating" || ["scheduled", "activating", "probation"].includes(phase ?? ""))) ||
    (fresh(deployment?.updatedAt) && deployment?.phase === "committing");
  const failed = !complete && (tracks?.phase === "attention" || ["failed", "repair_required", "rolled_back"].includes(phase ?? "") || runtime?.state === "error" && Boolean(runtime.commandFailureCode));
  // A check in flight or a missed probe does not erase recent authenticated activity.
  const online = fresh(liveness?.lastVerifiedAt) || fresh(runtime?.lastVerifiedAt) ||
    (runtime?.state === "online" && fresh(runtime.checkedAt)) ||
    (!runtime?.versionCheckError && fresh(runtime?.versionCheckedAt));
  const repairRequired = !complete && (phase === "repair_required" || tracks?.phase === "attention");
  const statusFresh = fresh(status?.updatedAt) || (!runtime?.versionCheckError && fresh(runtime?.versionCheckedAt));
  const historicalFailure = failed && !statusFresh;
  const availability = !input.connected ? "Client disconnected" : switching ? "Temporarily unavailable" : historicalFailure ? "Current state not confirmed" : repairRequired ? "Needs repair" : online ? "Available" : "Connection not confirmed";
  const waiting = phase === "waiting_for_idle" || tracks?.phase === "releasing" || deployment?.phase === "draining";
  const ready = phase === "staged" || deployment?.phase === "trial";
  const preparing = !complete && (["agent_required", "agent_running", "agent_validating", "staging"].includes(phase ?? "") || runtime?.state === "starting" || deployment?.phase === "preparing");
  const progress = switching ? "Updating" : waiting ? "Update waiting" : ready ? "Update ready" : preparing ? "Preparing update" : null;
  const notice = historicalFailure ? null : failed ? "Update unfinished" : progress ?? (!complete && input.targetBuild ? "Update available" : null);
  const needsConnectionHelp = input.connected && !online && !switching;
  const needsConfirmation = input.connected && !switching && (historicalFailure || needsConnectionHelp);
  const checking = action === "check_versions";
  const checkFailed = needsConfirmation && Boolean(runtime?.versionCheckError);
  const description = !input.connected ? "Reconnect this app to manage this computer."
    : checking && needsConfirmation ? "Checking this computer's current state. This does not restart or change it."
    : switching ? "The computer is restarting for the update. Malink will confirm when it returns; no action is needed."
    : checkFailed ? "This computer did not answer the check. Its current condition is still unknown; repeating the check will not repair it."
    : historicalFailure ? "The last update reported a problem. Confirm the current state before choosing a repair."
    : needsConnectionHelp ? complete ? "The latest version was installed. Confirm whether this computer is reachable now." : "There is no recent reply from this computer. Confirm its current state before taking action."
    : repairRequired ? tracks?.phase === "attention" ? online
      ? "This computer is responding, but its version switch did not finish. Retry the prepared update or choose an available recovery option."
      : "The version switch did not complete. Confirm the computer's current state before retrying."
      : "The update could not confirm a working Gateway. Normal work may be unavailable."
    : failed ? phase === "rolled_back" ? "The update failed and the previous version was restored." : "The latest update did not finish. The computer is still responding."
    : waiting ? "Keep working normally. The update will install after running tasks finish."
    : ready ? "The update is prepared. Choose Install when idle to finish it without interrupting running tasks."
    : preparing ? "Keep working normally. Malink is preparing the update; no action is needed now."
    : notice ? "You can keep working while the new version is prepared."
    : "No action needed.";
  const tone = needsConfirmation ? "unknown" : switching || preparing || waiting ? "progress" : repairRequired || failed ? "attention" : online && input.connected ? "online" : "unknown";
  return { availability, notice, description, complete, failed, ready, waiting, preparing, switching, needsConnectionHelp, tone, needsConfirmation, checkFailed, historicalFailure, repairRequired,
    title: checkFailed ? "No reply from this computer" : needsConfirmation && checking ? "Checking current state…" : needsConfirmation ? availability : repairRequired ? "Update needs repair" : notice ? `${availability} · ${notice}` : availability,
    attention: failed || needsConnectionHelp,
    showUpdate: Boolean(notice) && !needsConfirmation && input.connected };
}
