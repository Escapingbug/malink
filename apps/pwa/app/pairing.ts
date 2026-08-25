import {
  canonicalJson,
  createDeviceInvitationLink as createProtocolDeviceInvitationLink,
  decodeDeviceInvitationLink as decodeProtocolDeviceInvitationLink,
  decodePairingLink,
  pairingLinkFromDeviceInvitation as protocolPairingLinkFromDeviceInvitation,
  signedGatewayDeviceRotationSchema,
  signedGatewayTransportSnapshotSchema,
  signedPairingCertificateSchema,
  signedPairingOfferSchema,
  signedPairingRequestSchema,
  signedPairingResponseSchema,
  signedWorkspaceDeviceGrantSchema,
  signedWorkspaceGatewayDirectorySchema,
  type MatrixTransportBinding,
  type DeviceInvitation,
  type GeneratedDeviceInvitation,
  type MatrixLoginInvitation,
  type PairingPublicKey,
  type SignedGatewayDeviceRotation,
  type SignedGatewayTransportSnapshot,
  type SignedPairingCertificate,
  type SignedPairingOffer,
  type SignedPairingRequest,
  type SignedPairingResponse,
  type SignedWorkspaceDeviceGrant,
  type SignedWorkspaceGatewayDirectory,
} from "@malink/protocol";
import {
  exportPairingPublicKey,
  pairingOfferDigest,
  signPairingRequest,
  verifyGatewayDeviceRotation,
  verifyGatewayTransportSnapshot,
  verifyPairingCertificate,
  verifyPairingOffer,
  verifyPairingRequest,
  verifyPairingResponse,
  verifyWorkspaceGatewayDirectory,
} from "@malink/security";
import type { DeviceIdentity } from "./matrix";

export const PAIRING_TRUST_STORAGE_KEY = "malink.pairing.trust.v1";
export const PAIRING_TRUST_PROFILES_STORAGE_KEY = "malink.pairing.trust.profiles.v1";
export const PENDING_PAIRING_STORAGE_KEY = "malink.pairing.pending.v1";
const PAIRING_REQUEST_TTL_MS = 2 * 60_000;
// Once signed, this is a durable authorization transaction rather than an
// invitation draft. The Gateway still rejects a revoked/expired certificate.
const PENDING_PAIRING_RETENTION_MS = 366 * 24 * 60 * 60_000;
const MIN_PAIRING_START_WINDOW_MS = 15_000;
const MAX_CLOCK_SKEW_MS = 30_000;

export type PairingPreview = {
  signedOffer: SignedPairingOffer;
  gatewayName: string;
  gatewayId: string;
  gatewayNodeId: string;
  verificationCode: string;
  expiresAt: number;
  transport: MatrixTransportBinding;
};

export type {
  DeviceInvitation,
  GeneratedDeviceInvitation,
  MatrixLoginInvitation,
} from "@malink/protocol";

export type TrustedGateway = {
  version: 1;
  gatewayId: string;
  gatewayNodeId: string;
  gatewayName: string;
  activeDeviceCount?: number;
  gatewayKey: PairingPublicKey;
  gatewayTransport: MatrixTransportBinding;
  offer: SignedPairingOffer;
  request: SignedPairingRequest;
  certificate: SignedPairingCertificate;
  workspaceGrant?: SignedWorkspaceDeviceGrant;
  gatewayDirectory?: SignedWorkspaceGatewayDirectory;
  rotations: SignedGatewayDeviceRotation[];
  transportSnapshots: SignedGatewayTransportSnapshot[];
  pairedAt: number;
};

type TrustedGatewayProfiles = {
  version: 1;
  activeGatewayId: string | null;
  gateways: Record<string, TrustedGateway>;
};

type PendingPairing = {
  version: 1;
  offer: SignedPairingOffer;
  request: SignedPairingRequest;
  savedAt: number;
};

export type PendingPairingRecovery =
  | { status: "ready"; preview: PairingPreview }
  | { status: "expired" };

export interface PairingTransport {
  exchange(
    request: SignedPairingRequest,
    offer: SignedPairingOffer,
    signal?: AbortSignal,
  ): Promise<SignedPairingResponse>;
}

export class PairingRejectedError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code: string, retryable: boolean) {
    super(message);
    this.name = "PairingRejectedError";
    this.code = code;
    this.retryable = retryable;
  }
}

export async function inspectPairingLink(
  input: string,
  now = Date.now(),
): Promise<PairingPreview> {
  const signedOffer = decodeFlexiblePairingLink(input.trim());
  const offer = await verifyPairingOffer(signedOffer, undefined, {
    now,
    maxFutureSkewMs: MAX_CLOCK_SKEW_MS,
  });
  return {
    signedOffer,
    gatewayName: offer.gatewayName,
    gatewayId: offer.gatewayId,
    gatewayNodeId: offer.gatewayNodeId ?? offer.gatewayId,
    verificationCode: await verificationCode(signedOffer),
    expiresAt: offer.expiresAt,
    transport: offer.gatewayTransport,
  };
}

export function createDeviceInvitationLink(input: {
  pairingLink: string;
  appUrl: string;
  matrixLogin?: MatrixLoginInvitation;
}): GeneratedDeviceInvitation {
  return createProtocolDeviceInvitationLink(input);
}

export function decodeDeviceInvitationLink(input: string): DeviceInvitation {
  return decodeProtocolDeviceInvitationLink(
    input,
    typeof window === "undefined"
      ? "https://malink.invalid/"
      : window.location.href,
  );
}

export function pairingLinkFromDeviceInvitation(
  invitation: DeviceInvitation,
): string {
  return protocolPairingLinkFromDeviceInvitation(invitation);
}

export async function completePairing(
  preview: PairingPreview,
  identity: DeviceIdentity,
  deviceTransport: MatrixTransportBinding,
  deviceName: string,
  transport: PairingTransport,
  signal?: AbortSignal,
): Promise<TrustedGateway> {
  const now = Date.now();
  const reusable = await loadReusablePendingRequest(
    preview,
    identity,
    deviceTransport,
    now,
  );
  let signedRequest = reusable?.request ?? null;
  const pendingSavedAt = reusable?.savedAt ?? now;
  if (!signedRequest) {
    if (preview.signedOffer.offer.expiresAt <= now + MIN_PAIRING_START_WINDOW_MS) {
      throw new Error(
        "This pairing invitation is expired or too close to expiry. Scan a new invitation.",
      );
    }
    const offerDigest = await pairingOfferDigest(preview.signedOffer);
    const request = {
      kind: "malink.pairing.request" as const,
      version: 1 as const,
      requestId: crypto.randomUUID(),
      offerId: preview.signedOffer.offer.offerId,
      offerDigest,
      gatewayId: preview.gatewayId,
      deviceId: identity.keyId,
      deviceName: normalizeDeviceName(deviceName),
      deviceKey: await exportPairingPublicKey(identity.publicKey),
      deviceTransport,
      requestedOperations: preview.signedOffer.offer.allowedOperations,
      issuedAt: now,
      expiresAt: Math.min(preview.expiresAt, now + PAIRING_REQUEST_TTL_MS),
    };
    signedRequest = await signPairingRequest(
      request,
      preview.signedOffer,
      identity.privateKey,
      identity.keyId,
    );
  }
  savePendingPairing({
    version: 1,
    offer: preview.signedOffer,
    request: signedRequest,
    savedAt: pendingSavedAt,
  });

  let exchanged: SignedPairingResponse;
  try {
    exchanged = await transport.exchange(
      signedRequest,
      preview.signedOffer,
      signal,
    );
  } catch (error) {
    if (error instanceof PairingRejectedError && !error.retryable) {
      clearPendingPairing();
    }
    throw error;
  }
  const signedResponse = signedPairingResponseSchema.parse(exchanged);
  if (signedResponse.response.expiresAt <= Date.now()) {
    clearPendingPairing();
    throw new Error(
      "The saved pairing response expired. Scan a new Gateway QR code.",
    );
  }
  const response = await verifyPairingResponse(
    signedResponse,
    preview.signedOffer,
    signedRequest,
  );

  const certificate = response.certificate;
  const trust: TrustedGateway = {
    version: 1,
    gatewayId: preview.gatewayId,
    gatewayNodeId: preview.gatewayNodeId,
    gatewayName: preview.gatewayName,
    ...activeDeviceCountField(signedResponse.response),
    gatewayKey: preview.signedOffer.offer.gatewayKey,
    gatewayTransport: certificate.certificate.gatewayTransport,
    offer: preview.signedOffer,
    request: signedRequest,
    certificate,
    ...(response.workspaceGrant === undefined
      ? {}
      : { workspaceGrant: signedWorkspaceDeviceGrantSchema.parse(response.workspaceGrant) }),
    ...(response.gatewayDirectory === undefined
      ? {}
      : { gatewayDirectory: signedWorkspaceGatewayDirectorySchema.parse(response.gatewayDirectory) }),
    rotations: [],
    transportSnapshots: [],
    pairedAt: Date.now(),
  };
  clearPendingPairing();
  saveTrustedGateway(trust);
  if (trust.gatewayDirectory) saveGatewayDirectoryProfiles(trust, trust.gatewayDirectory);
  return trust;
}

function activeDeviceCountField(
  input: unknown,
): { activeDeviceCount: number } | Record<string, never> {
  if (!input || typeof input !== "object") return {};
  const candidate = (input as Record<string, unknown>).activeDeviceCount;
  return typeof candidate === "number" &&
    Number.isSafeInteger(candidate) &&
    candidate > 0
    ? { activeDeviceCount: candidate }
    : {};
}

export async function loadPendingPairingRecovery(
  identity: DeviceIdentity,
  now = Date.now(),
): Promise<PendingPairingRecovery | null> {
  const pending = readPendingPairing();
  if (!pending) return null;
  if (pending.savedAt + PENDING_PAIRING_RETENTION_MS <= now) {
    clearPendingPairing();
    return { status: "expired" };
  }
  try {
    await verifyPairingOffer(pending.offer, undefined, {
      now: pending.offer.offer.issuedAt,
    });
    await verifyPairingRequest(pending.request, pending.offer, {
      now: pending.request.request.issuedAt,
    });
    if (
      pending.request.request.deviceId !== identity.keyId ||
      pending.request.request.deviceKey.keyId !== identity.keyId
    ) {
      clearPendingPairing();
      return { status: "expired" };
    }
    return {
      status: "ready",
      preview: await previewFromOffer(
        pending.offer,
        pending.offer.offer.issuedAt,
        pending.savedAt + PENDING_PAIRING_RETENTION_MS,
      ),
    };
  } catch {
    clearPendingPairing();
    return { status: "expired" };
  }
}

export async function loadTrustedGateway(
  identity?: DeviceIdentity,
  gatewayId?: string,
): Promise<TrustedGateway | null> {
  if (typeof localStorage === "undefined") return null;
  const profiles = readTrustedGatewayProfiles();
  const selectedGatewayId = gatewayId ?? profiles.activeGatewayId;
  const selected = selectedGatewayId
    ? profiles.gateways[selectedGatewayId]
    : undefined;
  const value = selected
    ? JSON.stringify(selected)
    : gatewayId
      ? null
      : localStorage.getItem(PAIRING_TRUST_STORAGE_KEY);
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as TrustedGateway;
    const offer = signedPairingOfferSchema.parse(parsed.offer);
    const request = signedPairingRequestSchema.parse(parsed.request);
    const certificate = signedPairingCertificateSchema.parse(parsed.certificate);
    await verifyPairingOffer(offer, parsed.gatewayKey.publicKey, {
      now: offer.offer.issuedAt,
    });
    await verifyPairingRequest(request, offer, {
      now: request.request.issuedAt,
    });
    await verifyPairingCertificate(certificate, offer, request);
    if (
      identity &&
      (certificate.certificate.deviceId !== identity.keyId ||
        certificate.certificate.deviceKey.keyId !== identity.keyId)
    ) {
      return null;
    }
    const rotations = (parsed.rotations ?? []).map((rotation) =>
      signedGatewayDeviceRotationSchema.parse(rotation),
    );
    const transportSnapshots = (parsed.transportSnapshots ?? []).map(
      (snapshot) => signedGatewayTransportSnapshotSchema.parse(snapshot),
    );
    const gatewayNodeId = parsed.gatewayNodeId ?? parsed.gatewayId;
    const gatewayDirectory = parsed.gatewayDirectory
      ? signedWorkspaceGatewayDirectorySchema.parse(parsed.gatewayDirectory)
      : undefined;
    const directory = gatewayDirectory
      ? await verifyWorkspaceGatewayDirectory(gatewayDirectory, parsed.gatewayKey.publicKey, {
          workspaceId: parsed.gatewayId,
        })
      : undefined;
    const directoryGateway = directory?.gateways.find(
      gateway => gateway.gatewayNodeId === gatewayNodeId,
    );
    let expectedTransport = directoryGateway?.transport ?? certificate.certificate.gatewayTransport;
    let previousIssuedAt = certificate.certificate.issuedAt;
    const rotationIds = new Set<string>();
    const snapshotIds = new Set<string>();
    const updates = [
      ...rotations.map((signed) => ({
        kind: "rotation" as const,
        issuedAt: signed.rotation.issuedAt,
        signed,
      })),
      ...transportSnapshots.map((signed) => ({
        kind: "snapshot" as const,
        issuedAt: signed.snapshot.issuedAt,
        signed,
      })),
    ].sort((left, right) => left.issuedAt - right.issuedAt);
    for (const update of updates) {
      if (update.issuedAt <= previousIssuedAt) return null;
      if (update.kind === "rotation") {
        const rotation = await verifyGatewayDeviceRotation(
          update.signed,
          parsed.gatewayKey.publicKey,
          {
            gatewayId: parsed.gatewayId,
            previousTransport: expectedTransport,
          },
          { now: update.issuedAt },
        );
        if (rotationIds.has(rotation.rotationId)) return null;
        rotationIds.add(rotation.rotationId);
        expectedTransport = rotation.nextTransport;
      } else {
        const snapshot = await verifyGatewayTransportSnapshot(
          update.signed,
          parsed.gatewayKey.publicKey,
          {
            gatewayId: parsed.gatewayId,
            currentTransport: expectedTransport,
          },
          { now: update.issuedAt },
        );
        if (snapshotIds.has(snapshot.snapshotId)) return null;
        snapshotIds.add(snapshot.snapshotId);
        expectedTransport = snapshot.transport;
      }
      previousIssuedAt = update.issuedAt;
    }
    if (
      parsed.version !== 1 ||
      !parsed.gatewayId ||
      !parsed.gatewayName ||
      !parsed.gatewayKey ||
      !parsed.gatewayTransport ||
      !parsed.offer ||
      !parsed.request ||
      !parsed.certificate ||
      certificate.certificate.expiresAt <= Date.now() ||
      certificate.certificate.gatewayId !== parsed.gatewayId ||
      certificate.certificate.gatewayKeyId !== parsed.gatewayKey.keyId ||
      canonicalJson(expectedTransport) !==
        canonicalJson(parsed.gatewayTransport)
    ) {
      return null;
    }
    return {
      ...parsed,
      gatewayNodeId: parsed.gatewayNodeId ?? parsed.gatewayId,
      ...(gatewayDirectory ? { gatewayDirectory } : {}),
      offer,
      request,
      certificate,
      rotations,
      transportSnapshots,
    };
  } catch {
    return null;
  }
}

function saveGatewayDirectoryProfiles(
  base: TrustedGateway,
  signed: SignedWorkspaceGatewayDirectory,
): void {
  if (typeof localStorage === "undefined") return;
  const profiles = readTrustedGatewayProfiles();
  const gateways = { ...profiles.gateways };
  for (const descriptor of signed.directory.gateways) {
    gateways[descriptor.gatewayNodeId] = {
      ...base,
      gatewayNodeId: descriptor.gatewayNodeId,
      gatewayName: descriptor.gatewayName,
      gatewayTransport: descriptor.transport,
      gatewayDirectory: signed,
      rotations: [],
      transportSnapshots: [],
    };
  }
  writeTrustedGatewayProfiles({
    version: 1,
    activeGatewayId: base.gatewayNodeId,
    gateways,
  });
}

export async function loadTrustedGateways(
  identity?: DeviceIdentity,
): Promise<TrustedGateway[]> {
  if (typeof localStorage === "undefined") return [];
  migrateLegacyTrustedGateway();
  const profiles = readTrustedGatewayProfiles();
  const gateways = await Promise.all(
    Object.keys(profiles.gateways).map((gatewayId) =>
      loadTrustedGateway(identity, gatewayId),
    ),
  );
  return gateways
    .filter((gateway): gateway is TrustedGateway => gateway !== null)
    .sort((left, right) => right.pairedAt - left.pairedAt);
}

export function activeTrustedGatewayId(): string | null {
  if (typeof localStorage === "undefined") return null;
  migrateLegacyTrustedGateway();
  return readTrustedGatewayProfiles().activeGatewayId;
}

export function selectTrustedGateway(gatewayId: string): void {
  if (typeof localStorage === "undefined") return;
  const profiles = readTrustedGatewayProfiles();
  if (!profiles.gateways[gatewayId]) {
    throw new Error(`Gateway ${gatewayId} is not saved on this device.`);
  }
  writeTrustedGatewayProfiles({ ...profiles, activeGatewayId: gatewayId });
}

export function latestGatewayTransportIssuedAt(trust: TrustedGateway): number {
  return Math.max(
    trust.certificate.certificate.issuedAt,
    ...trust.rotations.map((rotation) => rotation.rotation.issuedAt),
    ...trust.transportSnapshots.map((snapshot) => snapshot.snapshot.issuedAt),
  );
}

export async function applyGatewayDeviceRotation(
  trust: TrustedGateway,
  input: unknown,
  now = Date.now(),
): Promise<TrustedGateway> {
  const signedRotation = signedGatewayDeviceRotationSchema.parse(input);
  if (
    trust.rotations.some(
      (known) =>
        known.rotation.rotationId === signedRotation.rotation.rotationId,
    )
  ) {
    return trust;
  }
  const lastIssuedAt = latestGatewayTransportIssuedAt(trust);
  // A durable root snapshot supersedes every incremental rotation at or before
  // its issue time. Those events can still be present in the Matrix timeline
  // after recovery and must not be interpreted as a new chain discontinuity.
  if (signedRotation.rotation.issuedAt <= lastIssuedAt) return trust;
  const rotation = await verifyGatewayDeviceRotation(
    signedRotation,
    trust.gatewayKey.publicKey,
    {
      gatewayId: trust.gatewayId,
      previousTransport: trust.gatewayTransport,
      issuedAfter: lastIssuedAt,
    },
    { now },
  );
  return {
    ...trust,
    gatewayTransport: rotation.nextTransport,
    rotations: [...trust.rotations, signedRotation],
  };
}

export async function applyGatewayTransportSnapshot(
  trust: TrustedGateway,
  input: unknown,
  now = Date.now(),
): Promise<TrustedGateway> {
  const signedSnapshot = signedGatewayTransportSnapshotSchema.parse(input);
  const lastIssuedAt = latestGatewayTransportIssuedAt(trust);
  const snapshot = await verifyGatewayTransportSnapshot(
    signedSnapshot,
    trust.gatewayKey.publicKey,
    {
      gatewayId: trust.gatewayId,
      currentTransport: trust.gatewayTransport,
      ...(signedSnapshot.snapshot.issuedAt > lastIssuedAt
        ? { issuedAfter: lastIssuedAt }
        : {}),
    },
    { now },
  );
  if (snapshot.issuedAt <= lastIssuedAt) return trust;
  return {
    ...trust,
    gatewayTransport: snapshot.transport,
    // A root snapshot supersedes all older incremental anchors. Retain only
    // updates that could have followed it (normally none at fetch time).
    rotations: trust.rotations.filter(
      (rotation) => rotation.rotation.issuedAt > snapshot.issuedAt,
    ),
    transportSnapshots: [signedSnapshot],
  };
}

export async function applyWorkspaceGatewayDirectory(
  trust: TrustedGateway,
  input: unknown,
): Promise<TrustedGateway> {
  const signed = signedWorkspaceGatewayDirectorySchema.parse(input);
  const currentRevision = trust.gatewayDirectory?.directory.revision;
  if (
    currentRevision === signed.directory.revision
  ) {
    if (canonicalJson(trust.gatewayDirectory) !== canonicalJson(signed)) {
      throw new Error("Workspace Gateway Directory revision is immutable.");
    }
    return trust;
  }
  const directory = await verifyWorkspaceGatewayDirectory(
    signed,
    trust.gatewayKey.publicKey,
    {
      workspaceId: trust.gatewayId,
    },
  );
  // The signed directory is mirrored to every Gateway room, whose Matrix
  // timelines can arrive in different orders. An already verified older copy
  // is stale delivery, not a rollback attempt against the durable revision.
  if (currentRevision !== undefined && directory.revision < currentRevision) {
    return trust;
  }
  const descriptor = directory.gateways.find(
    gateway => gateway.gatewayNodeId === trust.gatewayNodeId,
  );
  const next: TrustedGateway = {
    ...trust,
    gatewayDirectory: signed,
    ...(descriptor
      ? {
          gatewayName: descriptor.gatewayName,
          gatewayTransport: descriptor.transport,
        }
      : {}),
  };
  saveTrustedGateway(next);
  saveGatewayDirectoryProfiles(next, signed);
  return next;
}

export function saveTrustedGateway(trust: TrustedGateway): void {
  if (typeof localStorage === "undefined") return;
  const profiles = readTrustedGatewayProfiles();
  const gatewayNodeId = trust.gatewayNodeId ?? trust.gatewayId;
  writeTrustedGatewayProfiles({
    version: 1,
    activeGatewayId: gatewayNodeId,
    gateways: { ...profiles.gateways, [gatewayNodeId]: { ...trust, gatewayNodeId } },
  });
  // Keep the legacy active record during the rolling migration. Older PWA
  // builds can still reconnect to the last selected Gateway without learning
  // about or deleting the other profiles.
  localStorage.setItem(PAIRING_TRUST_STORAGE_KEY, JSON.stringify(trust));
}

export function clearTrustedGateway(gatewayId?: string): void {
  if (typeof localStorage === "undefined") return;
  migrateLegacyTrustedGateway();
  const profiles = readTrustedGatewayProfiles();
  const target = gatewayId ?? profiles.activeGatewayId;
  if (!target) {
    localStorage.removeItem(PAIRING_TRUST_STORAGE_KEY);
    return;
  }
  const gateways = { ...profiles.gateways };
  delete gateways[target];
  const activeGatewayId =
    profiles.activeGatewayId === target
      ? Object.keys(gateways)[0] ?? null
      : profiles.activeGatewayId;
  writeTrustedGatewayProfiles({ version: 1, activeGatewayId, gateways });
  const active = activeGatewayId ? gateways[activeGatewayId] : undefined;
  if (active) {
    localStorage.setItem(PAIRING_TRUST_STORAGE_KEY, JSON.stringify(active));
  } else {
    localStorage.removeItem(PAIRING_TRUST_STORAGE_KEY);
  }
}

function readTrustedGatewayProfiles(): TrustedGatewayProfiles {
  migrateLegacyTrustedGateway();
  const value = localStorage.getItem(PAIRING_TRUST_PROFILES_STORAGE_KEY);
  if (!value) return { version: 1, activeGatewayId: null, gateways: {} };
  try {
    const parsed = JSON.parse(value) as Partial<TrustedGatewayProfiles>;
    if (parsed.version !== 1 || !parsed.gateways || typeof parsed.gateways !== "object") {
      throw new Error("Invalid Gateway profile registry");
    }
    return {
      version: 1,
      activeGatewayId:
        typeof parsed.activeGatewayId === "string" ? parsed.activeGatewayId : null,
      gateways: parsed.gateways,
    };
  } catch (error) {
    throw new Error("Saved Gateway profiles are invalid and require explicit repair.", {
      cause: error,
    });
  }
}

function writeTrustedGatewayProfiles(profiles: TrustedGatewayProfiles): void {
  localStorage.setItem(
    PAIRING_TRUST_PROFILES_STORAGE_KEY,
    JSON.stringify(profiles),
  );
}

function migrateLegacyTrustedGateway(): void {
  if (localStorage.getItem(PAIRING_TRUST_PROFILES_STORAGE_KEY)) return;
  const legacy = localStorage.getItem(PAIRING_TRUST_STORAGE_KEY);
  if (!legacy) return;
  try {
    const trust = JSON.parse(legacy) as TrustedGateway;
    if (!trust.gatewayId) return;
    const gatewayNodeId = trust.gatewayNodeId ?? trust.gatewayId;
    writeTrustedGatewayProfiles({
      version: 1,
      activeGatewayId: gatewayNodeId,
      gateways: { [gatewayNodeId]: { ...trust, gatewayNodeId } },
    });
  } catch {
    // Existing validation remains the authority for malformed legacy trust.
  }
}

export function clearPendingPairing(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(PENDING_PAIRING_STORAGE_KEY);
}

export function trustedGatewayConfig(trust: TrustedGateway): {
  gatewayId: string;
  gatewayNodeId: string;
  homeserver: string;
  roomId: string;
  gatewayMatrixUserId: string;
  gatewayMatrixDeviceId: string;
  gatewayMatrixEd25519: string;
} {
  return {
    gatewayId: trust.gatewayId,
    gatewayNodeId: trust.gatewayNodeId ?? trust.gatewayId,
    homeserver: trust.gatewayTransport.homeserver,
    roomId: trust.gatewayTransport.roomId,
    gatewayMatrixUserId: trust.gatewayTransport.userId,
    gatewayMatrixDeviceId: trust.gatewayTransport.deviceId,
    gatewayMatrixEd25519: trust.gatewayTransport.ed25519,
  };
}

function decodeFlexiblePairingLink(input: string): SignedPairingOffer {
  try {
    return decodePairingLink(input);
  } catch (firstError) {
    let data: string | null = null;
    try {
      const url = new URL(input, window.location.href);
      if (url.searchParams.has("pair") || url.searchParams.has("data")) {
        throw new Error("Query-string pairing links are not accepted.");
      }
      data = new URLSearchParams(url.hash.replace(/^#/, "")).get("pair");
    } catch {
      // The strict decoder below supplies the user-facing error.
    }
    if (!data) {
      throw new Error("Paste a complete Malink pairing link.", {
        cause: firstError,
      });
    }
    if (data.startsWith("malink://")) return decodePairingLink(data);
    return decodePairingLink(`malink://pair?data=${data}`);
  }
}

async function loadReusablePendingRequest(
  preview: PairingPreview,
  identity: DeviceIdentity,
  deviceTransport: MatrixTransportBinding,
  now: number,
): Promise<{ request: SignedPairingRequest; savedAt: number } | null> {
  const pending = readPendingPairing();
  if (!pending) return null;
  if (
    pending.offer.offer.offerId !== preview.signedOffer.offer.offerId ||
    canonicalJson(pending.offer) !== canonicalJson(preview.signedOffer)
  ) {
    return null;
  }
  if (
    pending.request.request.deviceId !== identity.keyId ||
    canonicalJson(pending.request.request.deviceTransport) !==
      canonicalJson(deviceTransport)
  ) {
    clearPendingPairing();
    throw new Error(
      "The saved pairing request belongs to another device. Scan a new Gateway QR code.",
    );
  }
  if (pending.savedAt + PENDING_PAIRING_RETENTION_MS <= now) {
    clearPendingPairing();
    throw new Error(
      "The previous pairing request expired. Scan a new Gateway QR code.",
    );
  }
  try {
    await verifyPairingRequest(pending.request, pending.offer, {
      now: pending.request.request.issuedAt,
    });
    return { request: pending.request, savedAt: pending.savedAt };
  } catch {
    clearPendingPairing();
    throw new Error(
      "The saved pairing request could not be verified. Scan a new Gateway QR code.",
    );
  }
}

function readPendingPairing(): PendingPairing | null {
  if (typeof localStorage === "undefined") return null;
  const value = localStorage.getItem(PENDING_PAIRING_STORAGE_KEY);
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as PendingPairing;
    return {
      version: 1,
      offer: signedPairingOfferSchema.parse(parsed.offer),
      request: signedPairingRequestSchema.parse(parsed.request),
      savedAt:
        Number.isSafeInteger(parsed.savedAt) && parsed.savedAt >= 0
          ? parsed.savedAt
          : (() => {
              throw new Error("Invalid pending pairing timestamp.");
            })(),
    };
  } catch {
    clearPendingPairing();
    return null;
  }
}

function savePendingPairing(pending: PendingPairing): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(PENDING_PAIRING_STORAGE_KEY, JSON.stringify(pending));
}

async function previewFromOffer(
  signedOffer: SignedPairingOffer,
  now: number,
  expiresAt = signedOffer.offer.expiresAt,
): Promise<PairingPreview> {
  const offer = await verifyPairingOffer(signedOffer, undefined, { now });
  return {
    signedOffer,
    gatewayName: offer.gatewayName,
    gatewayId: offer.gatewayId,
    gatewayNodeId: offer.gatewayNodeId ?? offer.gatewayId,
    verificationCode: await verificationCode(signedOffer),
    expiresAt,
    transport: offer.gatewayTransport,
  };
}

function normalizeDeviceName(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return (normalized || "Malink PWA").slice(0, 128);
}

async function verificationCode(offer: SignedPairingOffer): Promise<string> {
  const digest = await sha256(
    new TextEncoder().encode(
      canonicalJson({
        offerId: offer.offer.offerId,
        challenge: offer.offer.challenge,
        gatewayKeyId: offer.offer.gatewayKey.keyId,
      }),
    ),
  );
  const number =
    (((digest[0] << 16) | (digest[1] << 8) | digest[2]) >>> 0) % 1_000_000;
  return number.toString().padStart(6, "0").replace(/(\d{3})(\d{3})/, "$1 $2");
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
}
