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
    (runtime?.state === "online" && fresh(runtime.checkedAt));
  const repairRequired = !complete && (phase === "repair_required" || tracks?.phase === "attention");
  const availability = !input.connected ? "Client disconnected" : switching ? "Temporarily unavailable" : repairRequired ? "Needs repair" : online ? "Available" : "Connection not confirmed";
  const waiting = phase === "waiting_for_idle" || tracks?.phase === "releasing" || deployment?.phase === "draining";
  const ready = phase === "staged" || deployment?.phase === "trial";
  const preparing = !complete && (["agent_required", "agent_running", "agent_validating", "staging"].includes(phase ?? "") || runtime?.state === "starting" || deployment?.phase === "preparing");
  const progress = switching ? "Updating" : waiting ? "Update waiting" : ready ? "Update ready" : preparing ? "Preparing update" : null;
  const notice = failed ? "Update unfinished" : progress ?? (!complete && input.targetBuild ? "Update available" : null);
  const needsConnectionHelp = input.connected && !online && !switching;
  const description = !input.connected ? "Reconnect this app to manage this computer."
    : switching ? "The computer is restarting for the update. Malink will confirm when it returns; no action is needed."
    : needsConnectionHelp ? `Open Malink Gateway Host on this computer and check its network connection.${complete ? " The latest version was installed; this connection check does not undo that result." : " The last update result has not changed."}`
    : repairRequired ? "This computer needs repair before normal work can be confirmed. Review recovery to choose the available repair method."
    : failed ? "The computer is responding, but the update did not finish. Review the failure before trying again."
    : waiting ? "Keep working normally. The update will install after running tasks finish."
    : ready ? "The update is prepared. Choose Install when idle to finish it without interrupting running tasks."
    : preparing ? "Keep working normally. Malink is preparing the update; no action is needed now."
    : notice ? "You can keep working while the new version is prepared."
    : "No action needed.";
  const tone = switching || preparing || waiting ? "progress" : repairRequired || failed ? "attention" : online && input.connected ? "online" : "unknown";
  return { availability, notice, description, complete, failed, ready, waiting, preparing, switching, needsConnectionHelp, tone,
    title: notice ? `${availability} · ${notice}` : availability,
    attention: failed || needsConnectionHelp,
    showUpdate: Boolean(notice) && !needsConnectionHelp && input.connected };
}
