/// <reference types="vite/client" />
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { NewSessionDialog } from "../../app/NewSessionDialog";
import { gatewayProjectOwner } from "../../app/projectCatalog";
import "../../app/globals.css";
const office = gatewayProjectOwner("office", "Office Gateway", "MacBook Pro");
const home = gatewayProjectOwner("home", "Home Gateway", "Linux workstation");
const workspaces = Array.from({ length: 45 }, (_, i) => ({
  projectId: `project-${i}`, projectName: i < 2 ? "Malink" : `Project ${String(i).padStart(2, "0")}`,
  cwd: i < 2 ? `/work/${i === 0 ? "product" : "research"}/malink` : `/work/team/services/project-${i}`,
  provider: i === 1 ? "agent" : "codex", permissionMode: "default",
}));
function Fixture() {
  const [open, setOpen] = useState(true);
  const [result, setResult] = useState("");
  return <><output>{result}</output><NewSessionDialog open={open} busy={false}
    selectProjectFirst={!location.search.includes("project-entry")}
    workspace={workspaces[0]} workspaces={workspaces}
    fallbackGateway={office} projectGateways={new Map(workspaces.map((p, i) => [p.projectId, i % 2 ? home : office]))}
    recentProjectIds={["project-0", "project-0", "project-1"]}
    models={[]} providers={[{ id: "codex", name: "Codex", models: [] }, { id: "agent", name: "Agent", models: [] }]}
    extensions={[]} onClose={() => setOpen(false)} onCreate={input => setResult(JSON.stringify(input))}
    onNewProject={() => setResult("new-project")} onManageProject={id => setResult(`manage:${id}`)} /></>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<Fixture />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
