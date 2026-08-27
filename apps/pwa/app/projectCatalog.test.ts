import { describe, expect, it } from "vitest";
import {
  canonicalGatewayProjects,
  gatewayNodeShortId,
  gatewayProjectOwners,
} from "./projectCatalog";

describe("canonicalGatewayProjects", () => {
  const workspace = {
    projectId: "project-root",
    projectName: "Malink",
    cwd: "/work/malink",
  };

  it("keeps the Gateway workspace label when sessions use aliases", () => {
    expect(
      canonicalGatewayProjects(workspace, [
        {
          projectId: "project-root",
          projectName: "Temporary task name",
          cwd: "/work/malink",
        },
      ]),
    ).toEqual([workspace]);
  });

  it("is stable across session ordering and chooses one label per project ID", () => {
    const first = {
      projectId: "project-other",
      projectName: "Beta",
      cwd: "/work/other",
    };
    const second = { ...first, projectName: "Alpha" };

    const forward = canonicalGatewayProjects(null, [first, second]);
    const reverse = canonicalGatewayProjects(null, [second, first]);

    expect(forward).toEqual(reverse);
    expect(forward).toEqual([{ ...first, projectName: "Alpha" }]);
  });

  it("keeps authorized projects that do not have any sessions yet", () => {
    const emptyProject = {
      projectId: "project-empty",
      projectName: "New Gateway",
      cwd: "/work/new-gateway",
    };

    expect(canonicalGatewayProjects(workspace, [], [emptyProject])).toEqual([
      workspace,
      emptyProject,
    ]);
  });

  it("maps signed directory project routes to stable Gateway labels", () => {
    const owners = gatewayProjectOwners([{
      gatewayNodeId: "c7134bb0-32ee-4861-89cc-b5b6bfab2910",
      gatewayName: "Office Mac",
      computerName: "alice-macbook",
      projects: [{ projectId: "project-root" }],
    }, {
      gatewayNodeId: "gateway-nas-87654321",
      gatewayName: "Home NAS",
      projects: [{ projectId: "project-other" }],
    }]);

    expect(owners.get("project-root")).toMatchObject({
      gatewayName: "Office Mac",
      computerName: "alice-macbook",
      shortId: "BFAB2910",
      label: "Office Mac · alice-macbook",
    });
    expect(owners.get("project-other")?.gatewayNodeId).toBe("gateway-nas-87654321");
    expect(gatewayNodeShortId("gateway-nas-87654321")).toBe("87654321");
  });
});
