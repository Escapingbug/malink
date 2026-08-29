const UI_CLIPBOARD_TIMEOUT_MS = 5_000;

export class ClipboardOperationTimeoutError extends Error {
  constructor() {
    super("Clipboard access did not finish in time.");
    this.name = "ClipboardOperationTimeoutError";
  }
}

export async function readClipboardTextWithTimeout(
  readText: (() => Promise<string>) | null = defaultClipboardRead(),
  timeoutMs = UI_CLIPBOARD_TIMEOUT_MS,
): Promise<string> {
  if (!readText) throw new Error("Clipboard access is unavailable.");
  return runClipboardOperation(readText, timeoutMs);
}

export async function writeClipboardTextWithTimeout(
  value: string,
  writeText: ((value: string) => Promise<void>) | null = defaultClipboardWrite(),
  timeoutMs = UI_CLIPBOARD_TIMEOUT_MS,
): Promise<void> {
  if (!writeText) throw new Error("Clipboard access is unavailable.");
  await runClipboardOperation(() => writeText(value), timeoutMs);
}

async function runClipboardOperation<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = globalThis.setTimeout(
          () => reject(new ClipboardOperationTimeoutError()),
          Math.max(0, timeoutMs),
        );
      }),
    ]);
  } finally {
    if (timer !== null) globalThis.clearTimeout(timer);
  }
}

function defaultClipboardRead(): (() => Promise<string>) | null {
  if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
    return null;
  }
  return navigator.clipboard.readText.bind(navigator.clipboard);
}

function defaultClipboardWrite(): ((value: string) => Promise<void>) | null {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    return null;
  }
  return navigator.clipboard.writeText.bind(navigator.clipboard);
}
