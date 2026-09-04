import { NATIVE_IMAGE_SAVE_MAX_BYTES } from "@malink/native-bridge";

const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

// Self-contained invitations can produce QR symbols with more than 100
// modules per side. Keep the exported raster comfortably above the decoder's
// minimum pixels-per-module even though CSS displays it at a smaller size.
export const INVITATION_QR_IMAGE_WIDTH = 1_024;

export type InvitationQrPng = {
  filename: string;
  dataUrl: string;
  dataBase64: string;
};

export function invitationQrPng(
  dataUrl: string,
  now = Date.now(),
): InvitationQrPng {
  if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX)) {
    throw new Error("The invitation QR code is not a PNG image.");
  }
  const dataBase64 = dataUrl.slice(PNG_DATA_URL_PREFIX.length);
  if (!BASE64_PATTERN.test(dataBase64) || !dataBase64.startsWith("iVBORw0KGgo")) {
    throw new Error("The invitation QR code image is invalid.");
  }
  const padding = dataBase64.endsWith("==")
    ? 2
    : dataBase64.endsWith("=")
      ? 1
      : 0;
  const decodedBytes = (dataBase64.length / 4) * 3 - padding;
  if (decodedBytes > NATIVE_IMAGE_SAVE_MAX_BYTES) {
    throw new Error("The invitation QR code image is too large to save safely.");
  }
  const timestamp = new Date(now)
    .toISOString()
    .replaceAll(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "Z");
  return {
    filename: `malink-invitation-qr-${timestamp}.png`,
    dataUrl,
    dataBase64,
  };
}

export function downloadInvitationQrPng(
  image: InvitationQrPng,
  documentRef: Pick<Document, "createElement" | "body"> = document,
): void {
  const anchor = documentRef.createElement("a");
  anchor.href = image.dataUrl;
  anchor.download = image.filename;
  anchor.hidden = true;
  documentRef.body.append(anchor);
  anchor.click();
  anchor.remove();
}
