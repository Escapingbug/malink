import assert from 'node:assert/strict';
import test from 'node:test';
import { generateDeviceKeyPair, exportPairingPublicKey, generatePairingChallenge, signPairingOffer, signPairingRequest, signPairingCertificate, pairingOfferDigest, pairingRequestDigest, signWorkspaceGatewayDirectory } from '@malink/security';
import { loadTrustedGateway, saveTrustedGateway, applyWorkspaceGatewayDirectory, PAIRING_TRUST_PROFILES_STORAGE_KEY } from '../app/pairing.ts';
test('retired startup entry recovers through signed directory while explicit nodes stay exact', async () => {
    const values = new Map<string, string>();
    const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) } });
    try {
        const now = Date.now(), keys = await generateDeviceKeyPair(), device = await generateDeviceKeyPair();
        const gatewayKey = await exportPairingPublicKey(keys.publicKey);
        const transport = { homeserver: 'https://matrix.example', roomId: '!old:example', userId: '@gateway:example', deviceId: 'OLD', ed25519: 'old-device-fingerprint' };
        const deviceTransport = { ...transport, userId: '@client:example', deviceId: 'CLIENT', ed25519: 'client-device-fingerprint' };
        const offer = await signPairingOffer({ kind: 'malink.pairing.offer', version: 1, offerId: 'offer', gatewayId: 'workspace', gatewayName: 'Computer', gatewayKey, gatewayTransport: transport, challenge: generatePairingChallenge(), allowedOperations: ['prompt'], issuedAt: now - 1000, expiresAt: now + 60000 }, keys.privateKey, keys.keyId);
        const request = await signPairingRequest({ kind: 'malink.pairing.request', version: 1, requestId: 'request', offerId: 'offer', offerDigest: await pairingOfferDigest(offer), gatewayId: 'workspace', deviceId: device.keyId, deviceName: 'Browser', deviceKey: await exportPairingPublicKey(device.publicKey), deviceTransport, requestedOperations: ['prompt'], issuedAt: now, expiresAt: now + 30000 }, offer, device.privateKey, device.keyId);
        const certificate = await signPairingCertificate({ kind: 'malink.pairing.certificate', version: 1, certificateId: 'cert', offerId: 'offer', offerDigest: await pairingOfferDigest(offer), requestId: 'request', requestDigest: await pairingRequestDigest(request), gatewayId: 'workspace', gatewayKeyId: keys.keyId, gatewayTransport: transport, deviceId: device.keyId, deviceName: 'Browser', deviceKey: request.request.deviceKey, deviceTransport, allowedOperations: ['prompt'], issuedAt: now, expiresAt: now + 86400000 }, offer, request, keys.privateKey, keys.keyId);
        const descriptor = { gatewayNodeId: 'new-node', workspaceId: 'workspace', gatewayName: 'Computer', transport: { ...transport, roomId: '!new:example', deviceId: 'NEW' }, publicKey: gatewayKey, projects: [], issuedAt: now };
        const directory = await signWorkspaceGatewayDirectory({ kind: 'malink.workspace.gateway-directory', version: 1, directoryId: 'directory', workspaceId: 'workspace', revision: 2, issuedAt: now, gateways: [descriptor] }, keys.privateKey, keys.keyId);
        const trust = { version: 1 as const, gatewayId: 'workspace', gatewayNodeId: 'workspace', gatewayName: 'Computer', gatewayKey, gatewayTransport: transport, offer, request, certificate, rotations: [], transportSnapshots: [], pairedAt: now, gatewayDirectory: directory };
        saveTrustedGateway(trust);
        const recovered = await loadTrustedGateway();
        assert.equal(recovered?.gatewayNodeId, 'new-node');
        assert.equal(recovered?.gatewayTransport.deviceId, 'NEW');
        assert.deepEqual(recovered?.certificate, certificate);
        assert.equal((await loadTrustedGateway(undefined, 'workspace'))?.gatewayTransport.deviceId, 'OLD');
        assert.equal((await loadTrustedGateway(undefined, 'new-node'))?.gatewayTransport.deviceId, 'NEW');
        saveTrustedGateway({ ...trust, gatewayDirectory: undefined });
        await applyWorkspaceGatewayDirectory({ ...trust, gatewayDirectory: undefined }, directory);
        assert.equal(JSON.parse(values.get(PAIRING_TRUST_PROFILES_STORAGE_KEY)!).activeGatewayId, 'new-node');
        const tampered = structuredClone(directory);
        tampered.directory.gateways[0]!.transport.deviceId = 'ATTACKER';
        saveTrustedGateway({ ...trust, gatewayDirectory: tampered });
        assert.equal(await loadTrustedGateway(), null);
    }
    finally {
        if (oldStorage)
            Object.defineProperty(globalThis, 'localStorage', oldStorage);
        else
            Reflect.deleteProperty(globalThis, 'localStorage');
    }
});
