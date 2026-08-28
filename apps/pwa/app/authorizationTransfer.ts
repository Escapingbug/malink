import type { GeneratedDeviceInvitation } from "./pairing";
import { decodeDeviceInvitationLink } from "./pairing";

const AUTHORIZATION_TRANSFER_KIND = "malink.authorization-transfer";
const AUTHORIZATION_TRANSFER_VERSION = 1;
export const MAX_AUTHORIZATION_TRANSFER_BYTES = 128 * 1024;
const MAX_AUTHORIZATION_TRANSFER_CHARACTERS = MAX_AUTHORIZATION_TRANSFER_BYTES;

type AuthorizationTransferDocument = {
  kind: typeof AUTHORIZATION_TRANSFER_KIND;
  version: typeof AUTHORIZATION_TRANSFER_VERSION;
  createdAt: number;
  expiresAt: number;
  invitation: string;
};

export function serializeAuthorizationTransfer(
  invitation: GeneratedDeviceInvitation,
  now = Date.now(),
): string {
  const verified = verifiedInvitation(invitation.link);
  if (verified.expiresAt !== invitation.expiresAt) {
    throw new Error("The authorization invitation expiry does not match its signed payload.");
  }
  if (verified.expiresAt <= now) {
    throw new Error("This authorization invitation has expired. Create a new one.");
  }
  const document: AuthorizationTransferDocument = {
    kind: AUTHORIZATION_TRANSFER_KIND,
    version: AUTHORIZATION_TRANSFER_VERSION,
    createdAt: now,
    expiresAt: verified.expiresAt,
    invitation: invitation.link,
  };
  const serialized = JSON.stringify(document, null, 2);
  if (serialized.length > MAX_AUTHORIZATION_TRANSFER_CHARACTERS) {
    throw new Error("The authorization file is too large.");
  }
  return `${serialized}\n`;
}

export function parseAuthorizationTransfer(
  input: string,
  now = Date.now(),
): GeneratedDeviceInvitation {
  if (!input || input.length > MAX_AUTHORIZATION_TRANSFER_CHARACTERS) {
    throw new Error("The authorization file is empty or too large.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    throw new Error("The authorization file is not valid JSON.", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The authorization file must contain one object.");
  }
  const value = parsed as Record<string, unknown>;
  const expectedKeys = ["createdAt", "expiresAt", "invitation", "kind", "version"];
  if (
    Object.keys(value).sort().join("\0") !== expectedKeys.sort().join("\0") ||
    value.kind !== AUTHORIZATION_TRANSFER_KIND ||
    value.version !== AUTHORIZATION_TRANSFER_VERSION ||
    typeof value.invitation !== "string" ||
    !Number.isSafeInteger(value.createdAt) ||
    !Number.isSafeInteger(value.expiresAt)
  ) {
    throw new Error("The authorization file has an unsupported or invalid format.");
  }
  const verified = verifiedInvitation(value.invitation);
  const createdAt = value.createdAt as number;
  if (createdAt < 0 || createdAt > verified.expiresAt) {
    throw new Error("The authorization file creation time is invalid.");
  }
  if (verified.expiresAt !== value.expiresAt) {
    throw new Error("The authorization file expiry does not match its signed invitation.");
  }
  if (verified.expiresAt <= now) {
    throw new Error("This authorization file has expired. Export a new one.");
  }
  return verified;
}

export function downloadAuthorizationTransfer(
  invitation: GeneratedDeviceInvitation,
  now = Date.now(),
): void {
  const contents = serializeAuthorizationTransfer(invitation, now);
  const blob = new Blob([contents], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const timestamp = new Date(now).toISOString().replaceAll(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  anchor.href = url;
  anchor.download = `malink-authorization-${timestamp}.malink-auth`;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function verifiedInvitation(link: string): GeneratedDeviceInvitation {
  const invitation = decodeDeviceInvitationLink(link);
  return {
    link,
    expiresAt: Math.min(
      invitation.offer.offer.expiresAt,
      invitation.matrixLogin?.expiresAt ?? Number.POSITIVE_INFINITY,
    ),
    includesMatrixLogin: invitation.matrixLogin !== undefined,
  };
}
