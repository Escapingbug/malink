import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const directory = new URL("../../../artifacts/conversation-actions/", import.meta.url).pathname;
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const url = "http://127.0.0.1:5189/malink/tests/fixtures/conversation-actions.html";

  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport);
    await page.goto(url);
    await page.getByRole("button", { name: "Conversation details" }).click();
    await page.getByRole("button", { name: /Rename conversation/ }).click();
    const input = page.getByRole("textbox", { name: "Name" });
    await input.fill("同步状态核对");
    await page.screenshot({ path: `${directory}rename-${viewport.width}.png` });
    await page.getByRole("button", { name: "Save name" }).click();
    await page.getByRole("heading", { name: "同步状态核对" }).waitFor();
    assert.equal(await page.getByRole("dialog", { name: "Rename conversation" }).count(), 0);

    const copy = page.getByRole("button", { name: "Copy message" }).first();
    await copy.click();
    await page.getByRole("button", { name: "Message copied" }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "已核对同步状态，这条消息可以快速复制。");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${directory}copied-${viewport.width}.png` });
  }
  assert.deepEqual(errors, []);
  console.log("Conversation actions passed at 390px and 1280px: rename flow, clipboard copy, feedback and no horizontal overflow.");
} finally {
  await browser.close();
}
