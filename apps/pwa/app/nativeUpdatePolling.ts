import type { NativeUpdateStatus } from "@malink/native-bridge";

export const NATIVE_UPDATE_POLL_INTERVAL_MS = 750;
export const NATIVE_UPDATE_DISCOVERY_GRACE_MS = 15_000;

export function shouldPollNativeUpdateStatus(
  state: NativeUpdateStatus | null,
  elapsedMs: number,
): boolean {
  if (!state || state.phase === "current") {
    return elapsedMs < NATIVE_UPDATE_DISCOVERY_GRACE_MS;
  }
  return state.phase === "checking" ||
    state.phase === "available" ||
    state.phase === "downloading" ||
    state.phase === "installing";
}

export function nativeUpdateDownloadProgress(
  state: NativeUpdateStatus | null,
): {
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
  label: string;
} | null {
  if (
    state?.phase !== "downloading" ||
    !state.totalBytes ||
    state.totalBytes <= 0
  ) return null;
  const downloadedBytes = Math.min(
    Math.max(0, state.downloadedBytes ?? 0),
    state.totalBytes,
  );
  const percent = Math.min(100, Math.floor((downloadedBytes / state.totalBytes) * 100));
  return {
    downloadedBytes,
    totalBytes: state.totalBytes,
    percent,
    label: `APK: downloading ${percent}% (${formatMegabytes(downloadedBytes)} / ${formatMegabytes(state.totalBytes)})`,
  };
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
