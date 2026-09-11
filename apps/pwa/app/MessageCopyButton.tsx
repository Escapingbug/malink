"use client";

import { useEffect, useRef, useState } from "react";
import { writeClipboardTextWithTimeout } from "./uiClipboard";

type CopyState = "idle" | "copying" | "copied" | "failed";

export function MessageCopyButton({ text }: { text: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);

  if (!text) return null;

  async function copyMessage() {
    if (state === "copying") return;
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    setState("copying");
    try {
      await writeClipboardTextWithTimeout(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    resetTimerRef.current = window.setTimeout(() => {
      setState("idle");
      resetTimerRef.current = null;
    }, 1_600);
  }

  const label = state === "copying"
    ? "Copying message"
    : state === "copied"
      ? "Message copied"
      : state === "failed"
        ? "Copy failed. Try again"
        : "Copy message";

  return (
    <button
      type="button"
      className={`message-copy-button state-${state}`}
      aria-label={label}
      title={label}
      disabled={state === "copying"}
      onClick={() => void copyMessage()}
    >
      <span aria-hidden="true">
        {state === "copying" ? "…" : state === "copied" ? "✓" : state === "failed" ? "!" : (
          <svg viewBox="0 0 16 16" width="14" height="14">
            <rect x="5" y="5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M3.5 10.5H3A1.5 1.5 0 0 1 1.5 9V3A1.5 1.5 0 0 1 3 1.5h6A1.5 1.5 0 0 1 10.5 3v.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        )}
      </span>
      {(state === "copied" || state === "failed") && (
        <b aria-hidden="true">{state === "copied" ? "Copied" : "Retry"}</b>
      )}
    </button>
  );
}
