import assert from "node:assert/strict";
import test from "node:test";
import { computerRepresentatives, computerNodeAliases } from "../app/computerPresentation.ts";
import { projectMatchesGatewayFilter } from "../app/gatewayFilter.ts";
const nodes = [{ gatewayNodeId: "mini" }, { gatewayNodeId: "old" }, { gatewayNodeId: "current" }];
const deployments = [{ active: nodes[2], recovery: nodes[1] }];
test("three nodes represent two computers using authoritative relationships", () => {
  assert.deepEqual(computerRepresentatives(nodes, deployments), [nodes[0], nodes[2]]);
  assert.equal(computerNodeAliases(nodes, deployments).get("old"), "current");
  assert.deepEqual(computerRepresentatives(nodes, []), nodes);
});
test("recovery remains discoverable when the active directory entry is missing", () => {
  assert.deepEqual(computerRepresentatives(nodes.slice(0, 2), deployments), nodes.slice(0, 2));
});
test("candidate does not become another computer", () => {
  const candidate = { gatewayNodeId: "candidate" };
  assert.equal(computerRepresentatives([...nodes, candidate], [{ ...deployments[0], candidate }]).length, 2);
});
test("computer filter includes recovery history without changing its execution owner", () => {
  const owner = { gatewayNodeId: "old", computerGatewayNodeId: "current" };
  const owners = new Map([["repair", owner]]);
  assert.equal(projectMatchesGatewayFilter("current", "repair", owners, "mini"), true);
  assert.equal(projectMatchesGatewayFilter("mini", "repair", owners, "mini"), false);
  assert.equal(owner.gatewayNodeId, "old");
});
