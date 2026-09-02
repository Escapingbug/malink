import { describe, expect, it } from "vitest";
import {
  hasBackgroundCommandRecovery,
  readBackgroundCommandRecoveries,
  readDismissedCommandRecoveries,
  removeBackgroundCommandRecoveries,
  writeBackgroundCommandRecoveries,
  writeDismissedCommandRecoveries,
} from "./dismissedCommandRecovery";

describe("dismissed command recovery storage", () => {
  it("round trips hidden recovery versions", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const expected = new Set(["command-1\u0000accepted\u0000100"]);

    writeDismissedCommandRecoveries(storage, expected);

    expect(readDismissedCommandRecoveries(storage)).toEqual(expected);
  });

  it("fails closed to an empty set for invalid or unavailable storage", () => {
    expect(readDismissedCommandRecoveries({ getItem: () => "{}" })).toEqual(new Set());
    expect(readDismissedCommandRecoveries({ getItem: () => { throw new Error("blocked"); } }))
      .toEqual(new Set());
    expect(() => writeDismissedCommandRecoveries({ setItem: () => {
      throw new Error("blocked");
    } }, new Set(["command-1"]))).not.toThrow();
  });

  it("persists automatic background recovery separately from manual hiding", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const background = new Set(["command-2\u0000running\u0000200"]);

    writeBackgroundCommandRecoveries(storage, background);

    expect(readBackgroundCommandRecoveries(storage)).toEqual(background);
    expect(readDismissedCommandRecoveries(storage)).toEqual(new Set());
  });

  it("keeps background recovery attached to one command across state changes", () => {
    const current = new Set(["command-2"]);
    const legacy = new Set(["command-2\u0000running\u0000200"]);

    expect(hasBackgroundCommandRecovery(current, "command-2")).toBe(true);
    expect(hasBackgroundCommandRecovery(legacy, "command-2")).toBe(true);
    expect(hasBackgroundCommandRecovery(legacy, "command-3")).toBe(false);
  });

  it("removes current and legacy markers when background recovery finishes", () => {
    const current = new Set([
      "command-1",
      "command-2\u0000running\u0000200",
      "command-3",
    ]);

    expect(removeBackgroundCommandRecoveries(
      current,
      ["command-1", "command-2"],
    )).toEqual(new Set(["command-3"]));
    expect(current.size).toBe(3);
  });
});
