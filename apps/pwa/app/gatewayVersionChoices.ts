import type { GatewayUpdateStatus } from "@malink/protocol";

/** Match supervisor selection rules; never offer an incompatible old reader. */
export function gatewayVersionChoices(tracks: GatewayUpdateStatus["executionTracks"], activationMode?: GatewayUpdateStatus["activationMode"]) {
  if (!tracks || !["steady", "attention"].includes(tracks.phase)) return [];
  if (activationMode === "forward-only") {
    return tracks.phase === "attention" && tracks.targetRelease
      ? [{ id: tracks.targetRelease, label: "Retry prepared update" }] : [];
  }
  return [
    ...(tracks.standbyRelease ? [{ id: tracks.standbyRelease, label: "Use previous version" }] : []),
    ...(tracks.phase === "attention" ? [
      { id: tracks.activeRelease, label: "Keep current version" },
      ...(tracks.targetRelease ? [{ id: tracks.targetRelease, label: "Retry prepared update" }] : []),
    ] : []),
  ].filter((choice, index, choices) => choices.findIndex(other => other.id === choice.id) === index);
}
