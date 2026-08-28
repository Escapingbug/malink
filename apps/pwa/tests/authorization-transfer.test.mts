import assert from "node:assert/strict";
import test from "node:test";
import { encodePairingLink, type PairingOffer } from "@malink/protocol";
import {
  exportPairingPublicKey,
  generateDeviceKeyPair,
  signPairingOffer,
} from "@malink/security";
import { createDeviceInvitationLink } from "../app/pairing.ts";
import {
  parseAuthorizationTransfer,
  serializeAuthorizationTransfer,
} from "../app/authorizationTransfer.ts";

const NOW = 1_800_000_000_000;

test("round trips a one-time authorization without exporting device keys", async () => {
  const invitation = await generatedInvitation();
  const serialized = serializeAuthorizationTransfer(invitation, NOW);
  const document = JSON.parse(serialized) as Record<string, unknown>;

  assert.deepEqual(Object.keys(document).sort(), [
    "createdAt", "expiresAt", "invitation", "kind", "version",
  ]);
  assert.doesNotMatch(serialized, /privateKey|accessToken/iu);
  assert.deepEqual(parseAuthorizationTransfer(serialized, NOW), invitation);
});

test("rejects expired, modified, and unknown authorization files", async () => {
  const invitation = await generatedInvitation();
  const serialized = serializeAuthorizationTransfer(invitation, NOW);
  const parsed = JSON.parse(serialized) as Record<string, unknown>;

  assert.throws(
    () => parseAuthorizationTransfer(serialized, invitation.expiresAt),
    /expired/iu,
  );
  assert.throws(
    () => parseAuthorizationTransfer(JSON.stringify({ ...parsed, expiresAt: NOW + 1 }), NOW),
    /does not match/iu,
  );
  assert.throws(
    () => parseAuthorizationTransfer(JSON.stringify({ ...parsed, extra: true }), NOW),
    /invalid format/iu,
  );
});

async function generatedInvitation() {
  const keys = await generateDeviceKeyPair();
  const gatewayKey = await exportPairingPublicKey(keys.publicKey);
  const offer: PairingOffer = {
    kind: "malink.pairing.offer",
    version: 1,
    offerId: "portable-offer-1",
    gatewayId: "workspace-1",
    gatewayNodeId: "gateway-node-1",
    gatewayName: "Portable Gateway",
    gatewayKey,
    gatewayTransport: {
      homeserver: "https://matrix.example",
      roomId: "!project:example",
      userId: "@gateway:example",
      deviceId: "GATEWAY",
      ed25519: "A".repeat(43),
    },
    challenge: "B".repeat(43),
    allowedOperations: ["prompt", "cancel"],
    issuedAt: NOW - 1_000,
    expiresAt: NOW + 5 * 60_000,
  };
  return createDeviceInvitationLink({
    pairingLink: encodePairingLink(await signPairingOffer(
      offer,
      keys.privateKey,
      keys.keyId,
    )),
    appUrl: "https://pwa.example/",
  });
}
