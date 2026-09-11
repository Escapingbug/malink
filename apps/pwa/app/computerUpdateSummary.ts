import type { GatewayUpdateActiveAction, GatewayUpdateNodeRuntime } from "./GatewayUpdateDialog";

/** Computer-level progress remains visible when its detailed controls are closed. */
export function computerUpdateSummary(runtime?: GatewayUpdateNodeRuntime, action?: GatewayUpdateActiveAction): string | null {
  if (action === "select_version") return "Switching version";
  const status = runtime?.status;
  const tracks = status?.executionTracks;
  if (tracks?.phase === "releasing" || tracks?.phase === "activating") return "Switching version";
  if (tracks?.phase === "attention") return "Recovery needed";
  switch (status?.phase) {
    case "agent_required": return "Preparing update";
    case "agent_running": return "Preparing update";
    case "agent_validating": return "Checking update";
    case "staging": return "Preparing update";
    case "staged": return "Ready to install";
    case "waiting_for_idle": return "Waiting for running tasks to finish";
    case "scheduled":
    case "activating": return "Switching version";
    case "probation": return "Checking new version";
    case "failed":
    case "repair_required": return "Update needs attention";
    case "rolled_back": return "Previous version restored";
  }
  if (runtime?.state === "starting") return "Requesting update";
  return null;
}
