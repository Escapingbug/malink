import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
 await mkdir('/tmp/malink-settings-qa', { recursive: true });
 for (const width of [390, 1280]) {
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(process.env.SETTINGS_FIXTURE_URL ?? 'http://127.0.0.1:4179/malink/tests/fixtures/computer-settings/');
  await page.getByRole('button', { name: 'Update options', exact: true }).waitFor();
  await page.screenshot({ path: `/tmp/malink-settings-qa/list-${width}.png` });
  await page.getByRole('button', { name: 'Update options', exact: true }).click();
  await page.getByRole('button', { name: 'Update', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Execution tracks' }).isVisible(), false);
  assert.equal(await page.evaluate(() => window.checks), 1);
  assert.equal(await page.getByRole('dialog').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Check available versions' }).count(), 0);
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await page.getByText('Versions & advanced options', { exact: true }).click();
  await page.getByRole('button', { name: 'View update session', exact: true }).click();
  await page.getByRole('heading', { name: 'Update session' }).waitFor();
  await page.getByRole('button', { name: 'Back to computer settings' }).click();
  await page.getByText('Versions & advanced options', { exact: true }).click();
  await page.getByRole('heading', { name: 'Execution tracks' }).waitFor();
  assert.equal(await page.evaluate(() => window.checks), 1);
  await page.evaluate(() => window.setFixturePhase('staged'));
  await page.getByRole('button', { name: 'Switch to new version', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `/tmp/malink-settings-qa/ready-${width}.png` });
  await page.evaluate(() => window.setFixturePhase('committed'));
  await page.getByRole('button', { name: 'Switch to retained version v1', exact: true }).click();
  assert.equal(await page.evaluate(() => window.selectedVersion), undefined);
  await page.getByRole('button', { name: 'Confirm switch', exact: true }).click();
  assert.equal(await page.evaluate(() => window.selectedVersion), 'v1');
  assert.equal(await page.getByRole('button', { name: 'Switch to retained version v2', exact: true }).count(), 1);
  const overflow = await page.evaluate(() => [...document.querySelectorAll('.matrix-settings, .matrix-settings-body, .computer-details')].filter(el => el.scrollWidth > el.clientWidth + 2).map(el => el.className));
  assert.deepEqual(overflow, []);
  assert.deepEqual(errors, []);
  await page.getByRole('heading', { name: 'Execution tracks' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `/tmp/malink-settings-qa/settings-${width}.png` });
  console.log(JSON.stringify({ width, checks: 1, versionSelected: 'v1', overflow, errors }));
  await page.close();
 }
} finally { await browser.close(); }
