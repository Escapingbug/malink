import assert from "node:assert/strict";
import test from "node:test";
import QRCode from "qrcode";
import {
  encodePairingLink,
  type PairingOffer,
} from "@malink/protocol";
import {
  exportPairingPublicKey,
  generateDeviceKeyPair,
  signPairingOffer,
} from "@malink/security";
import {
  completePairing,
  createDeviceInvitationLink,
  decodeDeviceInvitationLink,
  nativeMatrixRoomBindingFromPairingPreview,
  pairingLinkFromDeviceInvitation,
} from "../app/pairing.ts";
import { DeviceInvitationLifecycle } from "../app/deviceInvitationLifecycle.ts";
import {
  downloadInvitationQrPng,
  invitationQrPng,
} from "../app/invitationQrExport.ts";

test("combines one signed Gateway offer and one-time Matrix login into a fragment link", async () => {
  const offer = await signedOffer();
  const pairingLink = encodePairingLink(offer);
  const generated = createDeviceInvitationLink({
    pairingLink,
    appUrl: "https://pwa.malink.example/settings?source=secret#old=value",
    matrixLogin: {
      homeserver: "https://matrix.example",
      userId: "@alice:example",
      loginToken: "x".repeat(256),
      expiresAt: 1_800_000_240_000,
    },
  });

  const url = new URL(generated.link);
  assert.equal(url.origin, "https://pwa.malink.example");
  assert.equal(url.pathname, "/settings");
  assert.equal(url.search, "");
  assert.ok(url.hash.startsWith("#invite="));
  assert.equal(generated.expiresAt, 1_800_000_240_000);
  assert.equal(generated.includesMatrixLogin, true);

  const decoded = decodeDeviceInvitationLink(generated.link);
  assert.equal(decoded.matrixLogin?.loginToken, "x".repeat(256));
  assert.deepEqual(decoded.offer, offer);
  assert.equal(pairingLinkFromDeviceInvitation(decoded), pairingLink);
  assert.match(
    await QRCode.toDataURL(generated.link, { errorCorrectionLevel: "L" }),
    /^data:image\/png;base64,/,
  );
});

test("prepares a bounded QR PNG for Android saving or browser download", () => {
  const image = invitationQrPng(
    "data:image/png;base64,iVBORw0KGgo=",
    Date.parse("2026-09-03T10:00:00.000Z"),
  );
  assert.deepEqual(image, {
    filename: "malink-invitation-qr-20260903T100000Z.png",
    dataUrl: "data:image/png;base64,iVBORw0KGgo=",
    dataBase64: "iVBORw0KGgo=",
  });

  let appended = false;
  let clicked = false;
  let removed = false;
  const anchor = {
    href: "",
    download: "",
    hidden: false,
    click() { clicked = true; },
    remove() { removed = true; },
  };
  downloadInvitationQrPng(image, {
    createElement() { return anchor; },
    body: { append(node: unknown) { appended = node === anchor; } },
  } as never);
  assert.equal(anchor.href, image.dataUrl);
  assert.equal(anchor.download, image.filename);
  assert.equal(appended, true);
  assert.equal(clicked, true);
  assert.equal(removed, true);

  assert.throws(
    () => invitationQrPng("data:image/jpeg;base64,iVBORw0KGgo="),
    /not a PNG/,
  );
  assert.throws(
    () => invitationQrPng("data:image/png;base64,bm90LWEtcG5n"),
    /invalid/,
  );
});

test("keeps physical Gateway node identity out of the strict native Matrix binding", async () => {
  const offer = await signedOffer();
  const preview = {
    signedOffer: offer,
    gatewayName: "Development Gateway",
    gatewayId: "workspace-1",
    gatewayNodeId: "node-physical-1",
    verificationCode: "123 456",
    expiresAt: 1_800_000_300_000,
    transport: offer.offer.gatewayTransport,
  };

  assert.deepEqual(nativeMatrixRoomBindingFromPairingPreview(preview), {
    roomId: "!room:example",
    gatewayId: "workspace-1",
    conversationId: "!room:example",
    gatewayUserId: "@gateway:example",
    gatewayDeviceId: "GATEWAY",
    gatewayDeviceEd25519: "gateway-ed25519-public-key",
  });
  assert.equal(
    "gatewayNodeId" in nativeMatrixRoomBindingFromPairingPreview(preview),
    false,
  );
});

test("supports a Gateway-only invitation when get_login_token is unavailable", async () => {
  const offer = await signedOffer();
  const generated = createDeviceInvitationLink({
    pairingLink: encodePairingLink(offer),
    appUrl: "http://localhost:3000/",
  });

  const decoded = decodeDeviceInvitationLink(generated.link);
  assert.equal(decoded.matrixLogin, undefined);
  assert.equal(generated.includesMatrixLogin, false);
  assert.equal(generated.expiresAt, offer.offer.expiresAt);
});

test("rejects Matrix credentials for a different homeserver", async () => {
  const offer = await signedOffer();
  assert.throws(
    () =>
      createDeviceInvitationLink({
        pairingLink: encodePairingLink(offer),
        appUrl: "https://pwa.malink.example/",
        matrixLogin: {
          homeserver: "https://attacker.example",
          userId: "@alice:example",
          loginToken: "one-time-login-token",
          expiresAt: 1_800_000_240_000,
        },
      }),
    /does not match the Gateway homeserver/,
  );
});

test("does not start a new handshake when the invitation has under 15 seconds left", async () => {
  const now = 1_800_000_000_000;
  const offer = await signedOffer({
    issuedAt: now - 1_000,
    expiresAt: now + 14_999,
  });
  const deviceKeys = await generateDeviceKeyPair();
  let exchanged = false;
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    await assert.rejects(
      completePairing(
        {
          signedOffer: offer,
          gatewayName: offer.offer.gatewayName,
          gatewayId: offer.offer.gatewayId,
          verificationCode: "000 000",
          expiresAt: offer.offer.expiresAt,
          transport: offer.offer.gatewayTransport,
        },
        {
          keyId: deviceKeys.keyId,
          privateKey: deviceKeys.privateKey,
          publicKey: deviceKeys.publicKey,
          publicJwk: await crypto.subtle.exportKey("jwk", deviceKeys.publicKey),
        },
        {
          ...offer.offer.gatewayTransport,
          userId: "@alice:example",
          deviceId: "PWA_DEVICE",
          ed25519: "pwa-ed25519-public-key",
        },
        "Alice laptop",
        {
          async exchange() {
            exchanged = true;
            throw new Error("exchange must not run");
          },
        },
      ),
      /too close to expiry/,
    );
  } finally {
    Date.now = originalNow;
  }
  assert.equal(exchanged, false);
});

test("duplicate invitation requests share one Gateway operation and reuse its result", async () => {
  const lifecycle = new DeviceInvitationLifecycle<{
    link: string;
    expiresAt: number;
  }>();
  let creates = 0;
  let finish!: (value: { link: string; expiresAt: number }) => void;
  const create = () => {
    creates += 1;
    return new Promise<{ link: string; expiresAt: number }>((resolve) => {
      finish = resolve;
    });
  };

  const first = lifecycle.request(create);
  const duplicate = lifecycle.request(create);
  assert.equal(creates, 1);
  finish({ link: "https://malink.example/i/same", expiresAt: Date.now() + 60_000 });
  assert.deepEqual(await first, await duplicate);

  const reused = await lifecycle.request(create);
  assert.equal(reused.link, "https://malink.example/i/same");
  assert.equal(creates, 1);
});

test("clearing an invitation invalidates an in-flight late result", async () => {
  const lifecycle = new DeviceInvitationLifecycle<{
    link: string;
    expiresAt: number;
  }>();
  let finish!: (value: { link: string; expiresAt: number }) => void;
  const pending = lifecycle.request(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  lifecycle.clear();
  finish({ link: "https://malink.example/i/stale", expiresAt: Date.now() + 60_000 });
  await assert.rejects(pending, /request was cleared/);
  assert.equal(lifecycle.current(), null);
});

async function signedOffer(timestamps: {
  issuedAt?: number;
  expiresAt?: number;
} = {}) {
  const keys = await generateDeviceKeyPair();
  const offer: PairingOffer = {
    kind: "malink.pairing.offer",
    version: 1,
    offerId: "offer-1",
    gatewayId: "gateway-1",
    gatewayName: "Development Gateway",
    gatewayKey: await exportPairingPublicKey(keys.publicKey),
    gatewayTransport: {
      homeserver: "https://matrix.example",
      roomId: "!room:example",
      userId: "@gateway:example",
      deviceId: "GATEWAY",
      ed25519: "gateway-ed25519-public-key",
    },
    challenge:
      "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG",
    allowedOperations: [
      "prompt",
      "cancel",
      "decision",
      "session.settings",
      "session.create",
      "device.invite",
    ],
    issuedAt: timestamps.issuedAt ?? 1_800_000_000_000,
    expiresAt: timestamps.expiresAt ?? 1_800_000_300_000,
  };
  return signPairingOffer(offer, keys.privateKey, keys.keyId);
}
