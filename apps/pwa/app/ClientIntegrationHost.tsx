import { useEffect, useRef, useState } from "react";
import {
  clientIntegrationLaunchMessage,
  parseClientIntegrationHostRequest,
  type ClientIntegrationTarget,
} from "./clientIntegrations";

export function ClientIntegrationHost(props: {
  target: ClientIntegrationTarget;
  onClose(): void;
}) {
  const { target, onClose } = props;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const channelRef = useRef<MessagePort | null>(null);
  const [frameState, setFrameState] = useState<"loading" | "ready" | "failed">(
    "loading",
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => () => channelRef.current?.close(), []);

  function connectFrame(): void {
    const integrationWindow = frameRef.current?.contentWindow;
    if (!integrationWindow) {
      setFrameState("failed");
      return;
    }
    channelRef.current?.close();
    const channel = new MessageChannel();
    channelRef.current = channel.port1;
    channel.port1.onmessage = event => {
      const request = parseClientIntegrationHostRequest(event.data);
      if (!request || !target.capabilities.includes(`host.${request.type}`)) {
        return;
      }
      onClose();
    };
    channel.port1.start();
    try {
      integrationWindow.postMessage(
        clientIntegrationLaunchMessage(target, {
          locale: navigator.language || "en",
          colorScheme: window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light",
        }),
        target.origin,
        [channel.port2],
      );
      setFrameState("ready");
    } catch {
      channel.port1.close();
      channelRef.current = null;
      setFrameState("failed");
    }
  }

  return (
    <section
      aria-label={`${target.integrationName} view`}
      aria-modal="true"
      className="client-integration-host"
      role="dialog"
    >
      <header>
        <div>
          <small>{target.integrationName}</small>
          <strong>{target.title}</strong>
        </div>
        <button type="button" aria-label="Close integration" onClick={onClose}>
          ×
        </button>
      </header>
      {frameState === "loading" && (
        <div className="client-integration-status" role="status">
          Loading protected view…
        </div>
      )}
      {frameState === "failed" && (
        <div className="client-integration-status error" role="alert">
          The integration could not be initialized. Close this view and try again.
        </div>
      )}
      <iframe
        allow="camera 'none'; geolocation 'none'; microphone 'none'; clipboard-read 'none'; clipboard-write 'none'"
        onError={() => setFrameState("failed")}
        onLoad={connectFrame}
        ref={frameRef}
        referrerPolicy="no-referrer"
        sandbox="allow-forms allow-same-origin allow-scripts"
        src={target.url}
        title={`${target.integrationName}: ${target.title}`}
      />
    </section>
  );
}
