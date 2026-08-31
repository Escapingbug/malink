import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const distRoot = new URL("../dist/", import.meta.url);

test("builds a static Malink shell under its configured base path", async () => {
  const html = await readFile(new URL("index.html", distRoot), "utf8");

  assert.match(html, /<title>Your agents, anywhere · Malink<\/title>/i);
  assert.match(html, /src="\/malink\/assets\//);
  assert.match(html, /href="\/malink\/assets\//);
  assert.doesNotMatch(html, /(?:src|href)="\/assets\//);
  await access(new URL("404.html", distRoot));
  await access(new URL(".nojekyll", distRoot));
  await assert.rejects(access(new URL("server/index.js", distRoot)));
});

test("ships installable metadata and an offline service worker", async () => {
  const [manifestText, serviceWorker] = await Promise.all([
    readFile(new URL("manifest.webmanifest", distRoot), "utf8"),
    readFile(new URL("sw.js", distRoot), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);

  assert.equal(manifest.name, "Malink — Secure Agent Workspace");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "./");
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0);
  await Promise.all(manifest.icons.map(({ src }) =>
    access(new URL(String(src).replace(/^\.\//u, ""), distRoot))
  ));

  assert.match(serviceWorker, /event\.request\.mode === "navigate"/);
  assert.match(serviceWorker, /cache:\s*"no-store"/);
  assert.match(serviceWorker, /pathname\.startsWith\("\/_matrix\/"\)/);
  assert.match(serviceWorker, /addEventListener\("push"/);
  assert.match(serviceWorker, /addEventListener\("notificationclick"/);
});

test("publishes a static authoritative build version", async () => {
  const body = JSON.parse(
    await readFile(new URL("version.json", distRoot), "utf8"),
  );

  assert.match(body.buildVersion, /^[A-Za-z0-9._+-]+$/u);
  if (process.env.MALINK_GATEWAY_RELEASE_ID && process.env.MALINK_GATEWAY_BUILD_ID) {
    assert.deepEqual(body.gatewayRelease, {
      releaseId: process.env.MALINK_GATEWAY_RELEASE_ID,
      buildId: process.env.MALINK_GATEWAY_BUILD_ID,
    });
  } else {
    assert.equal(body.gatewayRelease, undefined);
  }
});
