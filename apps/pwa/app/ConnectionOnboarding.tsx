import { MalinkMark } from "./MalinkMark";

type Props = {
  notice?: "signed-out" | null;
  onDismissNotice?(): void;
  onConnect(): void;
};

export function ConnectionOnboarding({ notice, onDismissNotice, onConnect }: Props) {
  return (
    <section
      className="connection-onboarding"
      aria-labelledby="connection-onboarding-title"
    >
      <div className="connection-onboarding-card">
        {notice === "signed-out" && (
          <div className="onboarding-notice" role="status">
            <span aria-hidden="true">✓</span>
            <span>
              <strong>Signed out on this device</strong>
              <small>
                Your Workspace, computers, and server history remain available
                on your other authorized devices.
              </small>
            </span>
            {onDismissNotice && (
              <button type="button" aria-label="Dismiss" onClick={onDismissNotice}>×</button>
            )}
          </div>
        )}
        <span className="connection-onboarding-mark" aria-hidden="true">
          <MalinkMark />
        </span>
        <span className="eyebrow">Secure setup</span>
        <h2 id="connection-onboarding-title">Add this device to Malink</h2>
        <p>
          Use a one-time invitation from an authorized device or Workspace
          computer. Malink will identify the invitation and guide the rest.
        </p>
        <button
          type="button"
          className="connection-onboarding-action"
          onClick={onConnect}
        >
          Use an invitation
          <span aria-hidden="true">→</span>
        </button>

        <ol className="connection-onboarding-steps">
          <li>
            <span>1</span>
            <strong>Get an invitation</strong>
            <small>Open Devices on an authorized device, or Malink on a Workspace computer.</small>
          </li>
          <li>
            <span>2</span>
            <strong>Scan or paste</strong>
            <small>Use the QR code, pairing link, or authorization file.</small>
          </li>
          <li>
            <span>3</span>
            <strong>Add this device</strong>
            <small>Confirm the Workspace and matching code, then wait for synchronization.</small>
          </li>
        </ol>

        <p className="connection-onboarding-security">
          <span aria-hidden="true">✓</span>
          Only approved devices can read or send workspace messages.
        </p>
      </div>
    </section>
  );
}
