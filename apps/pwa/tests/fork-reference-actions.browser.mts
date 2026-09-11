import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
await mkdir('../../artifacts/fork-reference-actions', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
 for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
  const page = await browser.newPage({ viewport }); const errors: string[] = [];
  page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(`${message.text()} ${message.location().url}`); });
  await page.goto('http://127.0.0.1:5193/malink/tests/fixtures/fork-reference-actions.html');
  await page.getByRole('button', { name: 'Create branch', exact: true }).click();
  await page.getByRole('heading', { name: 'Create conversation branch' }).waitFor();
  await page.getByRole('textbox', { name: 'Branch name' }).fill('Alternative design');
  assert.equal(await page.getByRole('dialog').evaluate(element => { const r = element.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }), true);
  await page.screenshot({ path: `../../artifacts/fork-reference-actions/fork-${viewport.width}.png` });
  await page.getByRole('dialog').getByRole('button', { name: 'Create branch', exact: true }).click();
  await page.getByText('Created: Alternative design').waitFor();
  await page.getByRole('button', { name: 'Quote…', exact: true }).click();
  await page.getByText('Preview quoted answer', { exact: true }).click();
  await page.getByRole('textbox', { name: 'Find a conversation' }).fill('Implementation 23');
  await page.getByRole('radio').check();
  await page.screenshot({ path: `../../artifacts/fork-reference-actions/quote-${viewport.width}.png` });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: 'Add to draft' }).click();
  assert.match(await page.getByRole('textbox', { name: 'Draft', exact: true }).inputValue(), /Source message: answer-1/);
  await page.getByRole('textbox', { name: 'Draft', exact: true }).fill('');
  await page.getByRole('button', { name: 'Quote…', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('malink:native-back')));
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.goto('http://127.0.0.1:5193/malink/tests/fixtures/fork-reference-actions.html?empty');
  await page.getByRole('button', { name: 'Quote…', exact: true }).click();
  await page.getByText(/No other open conversations/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Add to draft' }).isDisabled(), true);
  assert.deepEqual(errors, []); await page.close();
 }
 console.log('Conversation actions verified on desktop and mobile: entry, explanation, confirmation, quote preview/search, draft editing, empty state and Android Back.');
} finally { await browser.close(); }
