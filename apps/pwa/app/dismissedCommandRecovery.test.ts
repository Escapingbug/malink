import { describe, expect, it } from "vitest";
import {
  readDismissedCommandRecoveries,
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
});
