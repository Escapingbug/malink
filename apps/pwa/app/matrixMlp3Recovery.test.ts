import { describe, expect, it, vi } from "vitest";
import {
  CoalescingAsyncRunner,
  MatrixMlp3ThreadDirectoryRecovery,
} from "./matrixMlp3Recovery";

describe("CoalescingAsyncRunner", () => {
  it("collapses requests queued in the same pointer batch", async () => {
    const task = vi.fn(async () => undefined);
    const runner = new CoalescingAsyncRunner(task);

    await Promise.all([runner.run(), runner.run(), runner.run()]);

    expect(task).toHaveBeenCalledTimes(1);
  });

  it("runs one trailing pass when a newer pointer arrives in flight", async () => {
    let releaseFirst!: () => void;
    const firstPass = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const task = vi.fn()
      .mockImplementationOnce(() => firstPass)
      .mockResolvedValue(undefined);
    const runner = new CoalescingAsyncRunner(task);

    const first = runner.run();
    await Promise.resolve();
    const second = runner.run();
    const third = runner.run();
    releaseFirst();
    await Promise.all([first, second, third]);

    expect(task).toHaveBeenCalledTimes(2);
  });

  it("allows a later pointer to retry after a failed pass", async () => {
    const task = vi.fn()
      .mockRejectedValueOnce(new Error("snapshot unavailable"))
      .mockResolvedValue(undefined);
    const runner = new CoalescingAsyncRunner(task);

    await expect(runner.run()).rejects.toThrow("snapshot unavailable");
    await expect(runner.run()).resolves.toBeUndefined();
    expect(task).toHaveBeenCalledTimes(2);
  });
});

describe("MatrixMlp3ThreadDirectoryRecovery", () => {
  it("checks each protocol only once after successful recovery", async () => {
    const coordinator = new MatrixMlp3ThreadDirectoryRecovery();
    const protocol = {};
    const recovery = vi.fn(async () => undefined);

    await Promise.all([
      coordinator.ensure(protocol, recovery),
      coordinator.ensure(protocol, recovery),
    ]);
    await coordinator.ensure(protocol, recovery);

    expect(recovery).toHaveBeenCalledTimes(1);
  });

  it("does not mark a failed directory recovery as complete", async () => {
    const coordinator = new MatrixMlp3ThreadDirectoryRecovery();
    const protocol = {};
    const recovery = vi.fn()
      .mockRejectedValueOnce(new Error("thread directory unavailable"))
      .mockResolvedValue(undefined);

    await expect(coordinator.ensure(protocol, recovery)).rejects.toThrow(
      "thread directory unavailable",
    );
    await expect(coordinator.ensure(protocol, recovery)).resolves.toBeUndefined();
    expect(recovery).toHaveBeenCalledTimes(2);
  });
});
