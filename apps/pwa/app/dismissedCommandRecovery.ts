const STORAGE_KEY = "malink.dismissed-command-recovery.v1";
const BACKGROUND_STORAGE_KEY = "malink.background-command-recovery.v1";
const MAX_ENTRIES = 128;
const MAX_ENTRY_LENGTH = 1_024;

export function readDismissedCommandRecoveries(
  storage: Pick<Storage, "getItem"> | null,
): Set<string> {
  return readRecoveryVersions(storage, STORAGE_KEY);
}

export function writeDismissedCommandRecoveries(
  storage: Pick<Storage, "setItem"> | null,
  values: ReadonlySet<string>,
): void {
  writeRecoveryVersions(storage, STORAGE_KEY, values);
}

export function readBackgroundCommandRecoveries(
  storage: Pick<Storage, "getItem"> | null,
): Set<string> {
  return readRecoveryVersions(storage, BACKGROUND_STORAGE_KEY);
}

export function writeBackgroundCommandRecoveries(
  storage: Pick<Storage, "setItem"> | null,
  values: ReadonlySet<string>,
): void {
  writeRecoveryVersions(storage, BACKGROUND_STORAGE_KEY, values);
}

/**
 * Background recovery follows the durable command identity, not its mutable
 * journal state. The prefix check migrates entries written by older clients,
 * which included state and updatedAt in the storage key.
 */
export function hasBackgroundCommandRecovery(
  values: ReadonlySet<string>,
  commandId: string,
): boolean {
  if (values.has(commandId)) return true;
  const legacyPrefix = `${commandId}\0`;
  return [...values].some(value => value.startsWith(legacyPrefix));
}

export function removeBackgroundCommandRecoveries(
  values: ReadonlySet<string>,
  commandIds: readonly string[],
): Set<string> {
  return new Set([...values].filter(value =>
    !commandIds.some(commandId =>
      value === commandId || value.startsWith(`${commandId}\0`),
    )
  ));
}

function readRecoveryVersions(
  storage: Pick<Storage, "getItem"> | null,
  key: string,
): Set<string> {
  if (!storage) return new Set();
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? "[]");
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter(
      (value): value is string =>
        typeof value === "string" && value.length > 0 && value.length <= MAX_ENTRY_LENGTH,
    ).slice(-MAX_ENTRIES));
  } catch {
    return new Set();
  }
}

function writeRecoveryVersions(
  storage: Pick<Storage, "setItem"> | null,
  key: string,
  values: ReadonlySet<string>,
): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify([...values].slice(-MAX_ENTRIES)));
  } catch {
    // Presentation persistence must not interfere with durable recovery.
  }
}
