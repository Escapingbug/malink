import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { gatewayUpdateRecoveryAction } from '../app/gatewayUpdateRecovery.ts';

test('preparation and activation have distinct user actions', () => {
  const release = { releaseId: 'new', buildId: 'build-new' };
  assert.equal(gatewayUpdateRecoveryAction({ release }).kind, 'start');
  assert.equal(gatewayUpdateRecoveryAction({ release }).label, 'Prepare new version');
  const ready = gatewayUpdateRecoveryAction({ release, status: { version: 1, phase: 'staged', releaseId: 'new', targetBuildId: 'build-new', updatedAt: 1 } });
  assert.equal(ready.kind, 'continue');
  assert.equal(ready.label, 'Switch to new version');
});

test('background resume cannot grant manual switch consent', () => {
  const source = readFileSync(new URL('../app/MalinkApp.tsx', import.meta.url), 'utf8');
  assert.match(source, /manualSwitch = false/);
  assert.match(source, /const switchRequested = manualSwitch &&/);
  assert.match(source, /startGatewayUpdateNode\(node, intent.mode \?\? "when_idle"\)/);
  assert.match(source, /onStart=\{\(node, mode\) => void startGatewayUpdateNode\(node, mode, true\)\}/);
  const guard = source.slice(source.indexOf('if (!switchRequested) {'));
  assert.ok(guard.indexOf('return;') < guard.indexOf('operation: "gateway.update.apply"'));
});
