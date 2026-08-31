const STORAGE_KEY = "malink.dismissed-command-recovery.v1";
const MAX_ENTRIES = 128;
const MAX_ENTRY_LENGTH = 1_024;

export function readDismissedCommandRecoveries(
  storage: Pick<Storage, "getItem"> | null,
): Set<string> {
  if (!storage) return new Set();
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter(
      (value): value is string =>
        typeof value === "string" && value.length > 0 && value.length <= MAX_ENTRY_LENGTH,
    ).slice(-MAX_ENTRIES));
  } catch {
    return new Set();
  }
}

export function writeDismissedCommandRecoveries(
  storage: Pick<Storage, "setItem"> | null,
  values: ReadonlySet<string>,
): void {
  if (!storage) return;
  try {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify([...values].slice(-MAX_ENTRIES)),
    );
  } catch {
    // Hiding a notice must keep working when storage is unavailable.
  }
}
