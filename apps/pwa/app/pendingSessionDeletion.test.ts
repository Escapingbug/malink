import { describe, expect, it } from "vitest";
import {
  pendingSessionLifecycleIds,
  reconcilePendingSessionDeletions,
  sessionLifecycleRouteKey,
  sessionsAvailableForAutomaticSelection,
  setSessionDeletionPending,
} from "./pendingSessionDeletion";

describe("pending session deletion", () => {
  it("excludes the last deleting session from automatic selection", () => {
    const pending = setSessionDeletionPending(new Set(), "last", true);

    expect(
      sessionsAvailableForAutomaticSelection([{ id: "last" }], pending),
    ).toEqual([]);
  });

  it("keeps overlapping deletions independent and can restore a failed one", () => {
    const first = setSessionDeletionPending(new Set(), "first", true);
    const both = setSessionDeletionPending(first, "second", true);
    const restored = setSessionDeletionPending(both, "second", false);

    expect([...first]).toEqual(["first"]);
    expect([...both]).toEqual(["first", "second"]);
    expect([...restored]).toEqual(["first"]);
  });

  it("drops a marker only after authoritative deletion converges", () => {
    const pending = new Set(["target"]);

    expect([
      ...reconcilePendingSessionDeletions(
        pending,
        new Set(["target", "other"]),
      ),
    ]).toEqual(["target"]);
    expect([
      ...reconcilePendingSessionDeletions(pending, new Set(["other"])),
    ]).toEqual([]);
  });

  it("derives pending selection exclusions from the live lifecycle map", () => {
    const actions = new Map<string, "archive">([
      ["first", "archive"],
      ["second", "archive"],
    ]);

    expect([...pendingSessionLifecycleIds(actions)]).toEqual(["first", "second"]);
  });

  it("keeps same-ID lifecycle work isolated by project route", () => {
    const sessions = [
      { id: "shared-update", projectId: "project-a" },
      { id: "shared-update", projectId: "project-b" },
    ];
    const pending = new Set([
      sessionLifecycleRouteKey("project-a", "shared-update"),
    ]);

    expect(sessionsAvailableForAutomaticSelection(sessions, pending)).toEqual([
      { id: "shared-update", projectId: "project-b" },
    ]);
  });
});
