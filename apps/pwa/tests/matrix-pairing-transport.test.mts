import assert from "node:assert/strict";
import test from "node:test";
import type { SignedPairingOffer, SignedPairingRequest } from "@malink/protocol";
import type { MatrixClient } from "matrix-js-sdk";
import {
  createMatrixPairingTransport,
  pairingRequestRetryDelayMs,
} from "../app/matrix.ts";

test("retries the exact pairing request with fresh Matrix transaction IDs", async () => {
  const controller = new AbortController();
  const sent: Array<{ content: Record<string, unknown>; transactionId: string }> = [];
  const client = {
    async sendMessage(
      _roomId: string,
      content: Record<string, unknown>,
      transactionId: string,
    ) {
      sent.push({ content, transactionId });
      if (sent.length === 3) controller.abort();
      return {};
    },
    on() {},
    off() {},
    getRoom() {
      return null;
    },
  } as unknown as MatrixClient;
  const request = {
    request: {
      requestId: "durable-request-1",
      expiresAt: Date.now() + 60_000,
    },
  } as SignedPairingRequest;
  const offer = {
    offer: { offerId: "one-use-offer-1" },
  } as SignedPairingOffer;
  const progress: string[] = [];
  const transport = createMatrixPairingTransport(
    client,
    "Room.timeline",
    "Event.decrypted",
    "m.notice" as never,
    "!project:example",
    (detail) => progress.push(detail),
    () => 0,
  );

  await assert.rejects(
    transport.exchange(request, offer, controller.signal),
    (error: unknown) =>
      error instanceof DOMException && error.name === "AbortError",
  );

  assert.equal(sent.length, 3);
  assert.equal(new Set(sent.map((entry) => entry.transactionId)).size, 3);
  const requests = sent.map((entry) =>
    ((entry.content["io.malink"] as Record<string, unknown>)
      .pairing_request),
  );
  assert.ok(requests.every((candidate) => candidate === request));
  assert.ok(progress.some((detail) => /Recovering the approved pairing response/u.test(detail)));
});

test("backs off pairing response recovery and caps repeated retries", () => {
  assert.deepEqual(
    [0, 1, 2, 20].map(pairingRequestRetryDelayMs),
    [2_000, 5_000, 10_000, 10_000],
  );
  assert.throws(() => pairingRequestRetryDelayMs(-1), /non-negative integer/u);
});
