"use client";

import { useRef } from "react";
import { createPortal } from "react-dom";
import { useNativeBackHandler, NATIVE_BACK_PRIORITY } from './nativeBackNavigation';
import { useDialogFocus } from "./dialogFocus";

import { ConversationPicker, filterConversations, type ConversationChoice } from './ConversationPicker';
export type ShareSession = ConversationChoice;
export const filterShareSessions = filterConversations;

export function SharedFileDialog({ files, sessions, onAttach, onClose }: {
  files: File[];
  sessions: ShareSession[];
  onAttach(key: string): void;
  onClose(): void;
}) {
  useNativeBackHandler(true, () => { onClose(); return true; }, NATIVE_BACK_PRIORITY.nestedModal);
  const ref = useRef<HTMLElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useDialogFocus({ open: true, containerRef: ref, initialFocusRef: cancel, onEscape: onClose });
  const dialog = <div className="new-session-backdrop" role="presentation">
    <section ref={ref} className="new-session-dialog shared-file-dialog" role="dialog" aria-modal="true"
      aria-labelledby="shared-file-title" tabIndex={-1}>
      <h2 id="shared-file-title">Add shared files to a conversation</h2>
      {files.map((file, index) => <p key={index}>{file.name} · {Math.ceil(file.size / 1024)} KB</p>)}
      <p>This only adds an attachment draft. Enter a message and press Send to ask the Agent to inspect it.</p>
      <ConversationPicker sessions={sessions} onChoose={onAttach} action="Share to" emptyText="No active conversations are available. Connect to your Workspace, then reopen Malink to resume this share." />
      <footer>
        <button ref={cancel} className="secondary-button" type="button" onClick={onClose}>Cancel share</button>
      </footer>
    </section>
  </div>;
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
