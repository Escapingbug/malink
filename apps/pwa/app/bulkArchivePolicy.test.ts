import { expect, it } from "vitest";
import { bulkArchiveEligible } from "./bulkArchivePolicy";
it("excludes active, archived, protected and pending sessions", () => {
  for (const status of ["running", "stopping", "archived"]) expect(bulkArchiveEligible(status, false, false)).toBe(false);
  expect(bulkArchiveEligible("idle", true, false)).toBe(false);
  expect(bulkArchiveEligible("idle", false, true)).toBe(false);
  expect(bulkArchiveEligible("idle", false, false)).toBe(true);
});
