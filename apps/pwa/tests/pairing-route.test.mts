import assert from "node:assert/strict";
import test from "node:test";
import { hasPairingRoute, pairingRouteFromUrl } from "../app/pairingRoute.ts";

test("extracts a pairing invitation received by an already running app", () => {
  const route = pairingRouteFromUrl(
    "https://malink.example/work#session=keep&pair=malink%3A%2F%2Fpair%3Fdata%3Done",
  );
  assert.equal(route.pairingLink, "malink://pair?data=one");
  assert.equal(route.sanitizedPath, "/work#session=keep");
  assert.equal(hasPairingRoute(route), true);
});

test("extracts a self-contained device invitation and removes it from history", () => {
  const route = pairingRouteFromUrl("https://malink.example/#invite=signed-payload");
  assert.equal(route.deviceInvitation, "signed-payload");
  assert.equal(route.sanitizedPath, "/");
});

test("extracts an Android-delivered authorization file and removes it from history", () => {
  const route = pairingRouteFromUrl(
    "https://malink.example/#session=keep&authorization=eyJraW5kIjoidGVzdCJ9",
  );
  assert.equal(route.authorizationTransfer, "eyJraW5kIjoidGVzdCJ9");
  assert.equal(route.sanitizedPath, "/#session=keep");
  assert.equal(hasPairingRoute(route), true);
});

test("sanitizes a retired short invitation without trying to resolve it", () => {
  const route = pairingRouteFromUrl("https://malink.example/#i=abc&k=secret");
  assert.equal(route.legacyShortInvitation, true);
  assert.equal(route.pairingLink, null);
  assert.equal(route.deviceInvitation, null);
  assert.equal(route.authorizationTransfer, null);
  assert.equal(route.sanitizedPath, "/");
  assert.equal(hasPairingRoute(route), true);
});
