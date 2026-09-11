import type { GatewayUpdateActiveAction, GatewayUpdateNodeRuntime } from "./GatewayUpdateDialog";

/** Computer-level progress remains visible when its detailed controls are closed. */
export function computerUpdateSummary(runtime?: GatewayUpdateNodeRuntime, action?: GatewayUpdateActiveAction): string | null {
  if (action === "select_version") return "Switching version";
  const status = runtime?.status;
  const tracks = status?.executionTracks;
  if (tracks?.phase === "releasing" || tracks?.phase === "activating") return "Switching version";
  if (tracks?.phase === "attention") return "Version needs attention · review retained version";
  switch (status?.phase) {
    case "agent_required": return "Starting update session";
    case "agent_running": return "Update session is preparing the new version";
    case "agent_validating": return "Validating the prepared version";
    case "staging": return "Preparing update";
    case "staged": return "New version prepared · waiting for your switch";
    case "waiting_for_idle": return "Waiting for running tasks to finish";
    case "scheduled":
    case "activating": return "Switching version";
    case "probation": return "Verifying the new version";
    case "failed":
    case "repair_required": return "Update needs attention";
    case "rolled_back": return "Previous version restored · update needs attention";
  }
  if (runtime?.state === "starting") return "Update request saved · waiting for confirmation";
  if (tracks?.phase === "steady") return `Using ${tracks.activeRelease} · ${tracks.standbyRelease ? "retained version available" : "no retained version reported"}`;
  return null;
}
