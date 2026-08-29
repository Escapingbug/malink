import { MalinkMark } from "./MalinkMark";

type Props = {
  onConnect(): void;
};

export function ConnectionOnboarding({ onConnect }: Props) {
  return (
    <section
      className="connection-onboarding"
      aria-labelledby="connection-onboarding-title"
    >
      <div className="connection-onboarding-card">
        <span className="connection-onboarding-mark" aria-hidden="true">
          <MalinkMark />
        </span>
        <span className="eyebrow">Secure setup</span>
        <h2 id="connection-onboarding-title">Connect your computer</h2>
        <p>
          Use a one-time invitation from your Malink computer or an already
          approved device. Your messages stay protected end to end.
        </p>
        <button
          type="button"
          className="connection-onboarding-action"
          onClick={onConnect}
        >
          Connect a computer
          <span aria-hidden="true">→</span>
        </button>

        <ol className="connection-onboarding-steps">
          <li>
            <span>1</span>
            <strong>Get an invitation</strong>
            <small>Open Malink on your computer or another approved device.</small>
          </li>
          <li>
            <span>2</span>
            <strong>Scan or paste</strong>
            <small>Use the QR code, pairing link, or authorization file.</small>
          </li>
          <li>
            <span>3</span>
            <strong>Verify once</strong>
            <small>Confirm the matching code before this device is trusted.</small>
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
