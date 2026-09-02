import { describe, expect, it } from "vitest";
import { parseOwnPrivateThreadReceipts } from "./matrixSessionReadReceipts";

describe("parseOwnPrivateThreadReceipts", () => {
  it("accepts only the current account's private threaded receipts", () => {
    expect(parseOwnPrivateThreadReceipts({
      "$event-1": {
        "m.read.private": {
          "@owner:example.org": { ts: 42, thread_id: "$root-1" },
          "@other:example.org": { ts: 43, thread_id: "$root-other" },
        },
      },
      "$event-public": {
        "m.read": {
          "@owner:example.org": { ts: 44, thread_id: "$root-public" },
        },
      },
      "$event-main": {
        "m.read.private": {
          "@owner:example.org": { ts: 45, thread_id: "main" },
        },
      },
    }, "@owner:example.org")).toEqual([{
      eventId: "$event-1",
      threadRootEventId: "$root-1",
      timestamp: 42,
    }]);
  });
});
