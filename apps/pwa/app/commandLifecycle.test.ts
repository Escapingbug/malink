import { describe, expect, it, vi } from "vitest";
import {
  type CommandCompletion,
  waitForCommandCompletion,
} from "./commandLifecycle";

describe("waitForCommandCompletion", () => {
  it("can wait without a foreground deadline for a durable command", async () => {
    vi.useFakeTimers();
    try {
      let resolveCompletion!: (completion: CommandCompletion) => void;
      const completion = new Promise<CommandCompletion>((resolve) => {
        resolveCompletion = resolve;
      });
      const waiting = waitForCommandCompletion(completion, null);
      let settled = false;
      void waiting.finally(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(settled).toBe(false);

      resolveCompletion({
        commandId: "gateway-update-apply-1",
        sequence: 1,
        revision: 0,
        outcome: "succeeded",
      });
      await expect(waiting).resolves.toMatchObject({
        commandId: "gateway-update-apply-1",
        outcome: "succeeded",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
