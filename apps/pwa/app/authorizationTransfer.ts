import {
  AUTHORIZATION_TRANSFER_MIME_TYPE,
  MAX_AUTHORIZATION_TRANSFER_BYTES,
  parseAuthorizationTransfer,
  serializeAuthorizationTransfer,
  type GeneratedDeviceInvitation,
} from "@malink/protocol";

export {
  AUTHORIZATION_TRANSFER_MIME_TYPE,
  MAX_AUTHORIZATION_TRANSFER_BYTES,
  parseAuthorizationTransfer,
  serializeAuthorizationTransfer,
};

const MAX_AUTHORIZATION_TRANSFER_FRAGMENT_CHARACTERS =
  Math.ceil(MAX_AUTHORIZATION_TRANSFER_BYTES / 3) * 4;

export function parseAuthorizationTransferFragment(
  payload: string,
  now = Date.now(),
): GeneratedDeviceInvitation {
  if (
    !payload ||
    payload.length > MAX_AUTHORIZATION_TRANSFER_FRAGMENT_CHARACTERS ||
    !/^[A-Za-z0-9_-]+$/u.test(payload)
  ) {
    throw new Error("The authorization file transfer is empty or too large.");
  }
  let bytes: Uint8Array;
  try {
    const padded =
      payload.replaceAll("-", "+").replaceAll("_", "/") +
      "=".repeat((4 - (payload.length % 4)) % 4);
    const binary = atob(padded);
    bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch (error) {
    throw new Error("The authorization file transfer is invalid.", { cause: error });
  }
  if (bytes.byteLength > MAX_AUTHORIZATION_TRANSFER_BYTES) {
    throw new Error("The authorization file is too large.");
  }
  let contents: string;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error("The authorization file is not valid UTF-8.", { cause: error });
  }
  return parseAuthorizationTransfer(contents, now);
}

export function downloadAuthorizationTransfer(
  invitation: GeneratedDeviceInvitation,
  now = Date.now(),
): void {
  const file = createAuthorizationTransferFile(invitation, now);
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function createAuthorizationTransferFile(
  invitation: GeneratedDeviceInvitation,
  now = Date.now(),
): File {
  const contents = serializeAuthorizationTransfer(invitation, now);
  const timestamp = new Date(now)
    .toISOString()
    .replaceAll(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "Z");
  return new File(
    [contents],
    `malink-authorization-${timestamp}.malink-auth`,
    { type: AUTHORIZATION_TRANSFER_MIME_TYPE },
  );
}

export function canShareAuthorizationTransferFile(): boolean {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.share !== "function" ||
    typeof navigator.canShare !== "function" ||
    typeof File !== "function"
  ) return false;
  try {
    return navigator.canShare({
      files: [new File(["{}"], "invitation.malink-auth", {
        type: AUTHORIZATION_TRANSFER_MIME_TYPE,
      })],
    });
  } catch {
    return false;
  }
}
