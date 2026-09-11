import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { deriveComposerState } from "../../app/composerState";
import "../../app/globals.css";

function Fixture() {
  const [recovering, setRecovering] = useState(true);
  const [slow, setSlow] = useState(false);
  const [draft, setDraft] = useState("请继续检查这个会话");
  const [sent, setSent] = useState(false);
  const state = deriveComposerState({ connectionStatus: "connected", gatewayAvailable: true,
    hasGatewayState: true, hasSelectedSession: true, selectedArchived: false,
    attachmentBusy: false, promptSubmitting: false, isStreaming: false,
    isStopping: false, hasContent: !!draft, conversationRecovering: recovering,
    conversationRecoveryFailed: slow });
  return <main style={{ maxWidth: 720, margin: "32px auto", padding: 12 }}>
    <h2>Conversation · Computer connected</h2>
    <p>已有的消息仍然可以阅读。</p>
    <form onSubmit={event => { event.preventDefault(); if (state.canSend) setSent(true); }}>
      <textarea aria-label="Message" value={draft} disabled={!state.canType}
        style={{ width: "100%", boxSizing: "border-box" }}
        onChange={event => setDraft(event.target.value)} />
      <button type="submit" className="send-button" disabled={!state.canSend}
        aria-label="Send message" aria-describedby="composer-status" title={state.reason}>↑</button>
    </form>
    <p id="composer-status" className={`composer-hint composer-hint-${state.mode}${recovering ? " composer-hint-recovering" : ""}`} role="status">{state.reason}</p>
    <p>{sent ? "Message sent" : "Nothing sent"}</p>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 30 }}>
      <button onClick={() => setSlow(true)}>Simulate slow recovery</button>
      <button onClick={() => setRecovering(false)}>Complete recovery</button>
    </div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
