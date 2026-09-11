import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('every incompatible activation path has an explicit risk confirmation and no silent boolean default', () => {
  const source = readFileSync(new URL('../app/MalinkApp.tsx', import.meta.url), 'utf8');
  const update = source.slice(source.indexOf('async function startGatewayUpdateNode('), source.indexOf('async function observeGatewayExecutionHandoff('));
  assert.match(update, /Agent 可能无法重新连接/);
  assert.match(update, /新版开始写入后不能直接切回旧版/);
  assert.match(update, /if \(forwardOnly && !confirmIncompatibleUpgrade\(\)\) return/);
  assert.match(update, /forwardOnly \? \{ allowForwardOnly: true as const \}/);
  assert.match(update, /gatewayUpdateRequiresForwardOnlyConfirmation\(staged\)\) \{\s+if \(!confirmIncompatibleUpgrade\(\)\) return/);
  assert.match(update, /continuePublishedRelease && gatewayUpdateRequiresForwardOnlyConfirmation\(knownStatus\)\s+&& !confirmIncompatibleUpgrade\(\)/);
});
