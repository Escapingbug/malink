import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MessageCopyButton } from "../../app/MessageCopyButton";
import { SessionRenameDialog } from "../../app/SessionRenameDialog";
import type { GatewaySessionSummary } from "../../app/gatewayState";
import "../../app/globals.css";

function Fixture() {
  const [title, setTitle] = useState("排查多设备同步");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const session = {
    id: "session-1",
    projectId: "project-1",
    title,
    status: "idle",
    scope: "project",
  } as GatewaySessionSummary;
  return (
    <main style={{ height: "100dvh", maxWidth: 900, margin: "auto", display: "flex", flexDirection: "column", position: "relative" }}>
      <header className="conversation-header">
        <span className="conversation-avatar violet">排</span>
        <div className="conversation-heading"><h2>{title}</h2><span className="conversation-status">Connected</span></div>
        <div className="conversation-actions">
          <button className={`header-button ${detailsOpen ? "pressed" : ""}`} aria-label="Conversation details" onClick={() => setDetailsOpen(value => !value)}>⋯</button>
        </div>
      </header>
      {detailsOpen && (
        <div className="details-popover" role="dialog" aria-label="Conversation details">
          <span className="mini-label">Project</span><strong>Malink</strong><code>/work/malink</code>
          <span className="verified-line"><b>✓</b> This device is approved</span>
          <div className="session-menu-actions">
            <button type="button" className="session-menu-primary" onClick={() => { setRenameOpen(true); setDetailsOpen(false); }}>
              <span aria-hidden="true">✎</span><span><strong>Rename conversation</strong><small>Sync the new name to your approved devices</small></span>
            </button>
          </div>
        </div>
      )}
      <div className="chat-feed" style={{ flex: 1 }}>
        <div className="message-row agent-row">
          <div className="agent-mark">C</div>
          <div className="bubble agent-bubble">
            <span className="agent-label">CODEX</span>
            <p>已核对同步状态，这条消息可以快速复制。</p>
            <div className="message-bubble-meta"><MessageCopyButton text="已核对同步状态，这条消息可以快速复制。" /><time>17:20</time></div>
          </div>
        </div>
        <div className="message-row user-row">
          <div className="bubble user-bubble">
            <p>请继续检查 Android 小屏体验。</p>
            <div className="message-bubble-meta"><MessageCopyButton text="请继续检查 Android 小屏体验。" /><time>17:21</time></div>
          </div>
        </div>
      </div>
      {renameOpen && <SessionRenameDialog
        session={session}
        busy={busy}
        error={null}
        onClose={() => setRenameOpen(false)}
        onConfirm={(nextTitle) => {
          setBusy(true);
          window.setTimeout(() => { setTitle(nextTitle); setBusy(false); setRenameOpen(false); }, 120);
        }}
      />}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
