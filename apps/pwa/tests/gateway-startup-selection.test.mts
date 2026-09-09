import assert from 'node:assert/strict';
import test from 'node:test';
import { generateDeviceKeyPair, exportPairingPublicKey, generatePairingChallenge, signPairingOffer, signPairingRequest, signPairingCertificate, pairingOfferDigest, pairingRequestDigest, signWorkspaceGatewayDirectory } from '@malink/security';
import { loadTrustedGateway, saveTrustedGateway, applyWorkspaceGatewayDirectory, PAIRING_TRUST_PROFILES_STORAGE_KEY } from '../app/pairing.ts';
test('retired startup entry recovers through signed directory while explicit nodes stay exact', async (t) => {
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
        assert.ok(recovered);
        const nextDirectory = await signWorkspaceGatewayDirectory({
            ...directory.directory,
            directoryId: 'directory-after-second-update',
            revision: 3,
            gateways: [{ ...descriptor, gatewayNodeId: 'next-node',
                transport: { ...descriptor.transport, roomId: '!next:example', deviceId: 'NEXT' } }],
        }, keys.privateKey, keys.keyId);
        // A running connection can persist its now-retired node with the new
        // directory. Its transport differs from the original pairing certificate.
        const twiceUpdated = { ...recovered, gatewayDirectory: nextDirectory };
        saveTrustedGateway(twiceUpdated);
        const restoredAgain = await loadTrustedGateway();
        assert.equal(restoredAgain?.gatewayNodeId, 'next-node');
        assert.equal(restoredAgain?.gatewayTransport.deviceId, 'NEXT');
        assert.deepEqual(restoredAgain?.certificate, certificate);
        assert.equal((await loadTrustedGateway())?.gatewayNodeId, 'next-node', 'survives another reload');
        assert.equal(await loadTrustedGateway(undefined, 'new-node'), null, 'explicit retired node never changes target');
        await t.test('rejects a tampered replacement directory without writing storage', async () => {
            const tamperedDirectory = structuredClone(nextDirectory);
            tamperedDirectory.directory.gateways[0]!.transport.deviceId = 'ATTACKER';
            saveTrustedGateway({ ...twiceUpdated, gatewayDirectory: tamperedDirectory });
            const before = new Map(values);
            assert.equal(await loadTrustedGateway(), null);
            assert.deepEqual(values, before);
        });
        await t.test('still rejects invalid and expired authorization before recovery', async () => {
            const invalidCertificate = structuredClone(certificate);
            invalidCertificate.signature.value = 'invalid-signature';
            saveTrustedGateway({ ...twiceUpdated, certificate: invalidCertificate });
            assert.equal(await loadTrustedGateway(), null);
            saveTrustedGateway(twiceUpdated);
            const originalNow = Date.now;
            Date.now = () => certificate.certificate.expiresAt + 1;
            try { assert.equal(await loadTrustedGateway(), null); }
            finally { Date.now = originalNow; }
        });
        await t.test('rejects a different browser identity', async () => {
            saveTrustedGateway(twiceUpdated);
            assert.equal(await loadTrustedGateway({
                ...device, keyId: 'another-browser', publicJwk: request.request.deviceKey.publicKey,
            }), null);
        });
        await t.test('does not select any node when the signed directory is empty', async () => {
            const empty = await signWorkspaceGatewayDirectory({
                ...nextDirectory.directory, directoryId: 'empty', revision: 4, gateways: [],
            }, keys.privateKey, keys.keyId);
            saveTrustedGateway({ ...twiceUpdated, gatewayDirectory: empty });
            assert.equal(await loadTrustedGateway(), null);
        });
        await t.test('preserves transport validation for a node still in the directory', async () => {
            saveTrustedGateway({ ...recovered, gatewayTransport: { ...recovered.gatewayTransport, deviceId: 'ATTACKER' } });
            assert.equal(await loadTrustedGateway(), null);
        });
        await t.test('recovers across a third node update', async () => {
            assert.ok(restoredAgain);
            const third = await signWorkspaceGatewayDirectory({
                ...nextDirectory.directory, directoryId: 'third-update', revision: 4,
                gateways: [{ ...descriptor, gatewayNodeId: 'third-node',
                    transport: { ...descriptor.transport, deviceId: 'THIRD' } }],
            }, keys.privateKey, keys.keyId);
            saveTrustedGateway({ ...restoredAgain, gatewayDirectory: third });
            const recoveredThird = await loadTrustedGateway();
            assert.equal(recoveredThird?.gatewayTransport.deviceId, 'THIRD');
            assert.deepEqual(recoveredThird?.certificate, certificate);
        });
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
