import assert from "node:assert/strict";
import test from "node:test";
import { retryMatchingCommandRevisionConflict } from "../app/commandRevisionRetry.ts";
import { CommandReviewRequiredError } from "../app/client/MalinkClient.ts";
import { CommandRevisionConflictError } from "../app/matrix.ts";

test("automatically rebases a Gateway setup-link revision conflict", async () => {
  const retried: string[] = [];
  const result = await retryMatchingCommandRevisionConflict(
    new CommandRevisionConflictError(
      "gateway-invite-command-1",
      7,
      { operation: "gateway.enrollment.invite", lifetimeMs: 300_000 },
    ),
    "gateway.enrollment.invite",
    async (commandId) => {
      retried.push(commandId);
      return "setup-link-ready";
    },
  );

  assert.equal(result, "setup-link-ready");
  assert.deepEqual(retried, ["gateway-invite-command-1"]);
});

test("retries native conflicts which omit the current command operation", async () => {
  const retried: string[] = [];
  const result = await retryMatchingCommandRevisionConflict(
    new CommandReviewRequiredError({ commandId: "native-command-1" }),
    "gateway.enrollment.invite",
    async (commandId) => {
      retried.push(commandId);
      if (retried.length === 1) {
        throw new CommandReviewRequiredError({ commandId: "native-command-2" });
      }
      return "setup-link-ready";
    },
  );

  assert.equal(result, "setup-link-ready");
  assert.deepEqual(retried, ["native-command-1", "native-command-2"]);
});

test("does not replay a different pending action", async () => {
  let retryCount = 0;
  const conflict = new CommandReviewRequiredError({
    commandId: "delete-command-1",
    operation: "session.delete",
    expectedRevision: 4,
  });

  await assert.rejects(
    retryMatchingCommandRevisionConflict(
      conflict,
      "gateway.enrollment.invite",
      async () => {
        retryCount += 1;
        return "unexpected";
      },
    ),
    (error) => error === conflict,
  );
  assert.equal(retryCount, 0);
});

test("bounds repeated automatic revision retries", async () => {
  let retryCount = 0;

  await assert.rejects(
    retryMatchingCommandRevisionConflict(
      new CommandReviewRequiredError({ commandId: "native-command-1" }),
      "gateway.enrollment.approve",
      async () => {
        retryCount += 1;
        throw new CommandReviewRequiredError({
          commandId: `native-command-${retryCount + 1}`,
        });
      },
    ),
    (error) => error instanceof CommandReviewRequiredError &&
      error.review.commandId === "native-command-4",
  );
  assert.equal(retryCount, 3);
});
