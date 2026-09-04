import type { IntegrationEntryPresentation } from "@malink/protocol";
import type { ClientIntegrationResolution } from "./clientIntegrations";

export function IntegrationEntryCard(props: {
  entry: IntegrationEntryPresentation;
  resolution: ClientIntegrationResolution;
  time?: string;
  onOpen(): void;
}) {
  const ready = props.resolution.status === "ready";
  return (
    <div className={`integration-entry-card ${props.entry.appearance ?? "card"}`}>
      <div className="integration-entry-heading">
        <span aria-hidden="true">◇</span>
        <div>
          <strong>{props.entry.title}</strong>
          <small>{props.entry.integrationId} integration</small>
        </div>
      </div>
      {props.entry.description && <p>{props.entry.description}</p>}
      {!ready && (
        <div className="integration-entry-unavailable" role="status">
          {props.resolution.reason}
        </div>
      )}
      <div className="integration-entry-actions">
        <button type="button" disabled={!ready} onClick={props.onOpen}>
          {props.entry.actionLabel ?? "Open view"}
        </button>
      </div>
      {props.time && <time>{props.time}</time>}
    </div>
  );
}
