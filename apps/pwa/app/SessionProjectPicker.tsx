"use client";

import { useEffect, useRef, useState } from "react";
import type { GatewayWorkspaceState } from "./gatewayState";
import type { GatewayProjectOwner } from "./projectCatalog";

type Props = {
  active: boolean;
  workspaces: GatewayWorkspaceState[];
  projectGateways: ReadonlyMap<string, GatewayProjectOwner>;
  fallbackGateway: GatewayProjectOwner;
  selectedProjectId?: string;
  recentProjectIds: string[];
  busy: boolean;
  onCancel(): void;
  onChoose(project: GatewayWorkspaceState): void;
  onTemporary(): void;
  onNewProject?(): void;
  onManageProject?(projectId: string): void;
};

export function SessionProjectPicker(props: Props) {
  const [query, setQuery] = useState("");
  const [gatewayId, setGatewayId] = useState("");
  const [managing, setManaging] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const owner = (project: GatewayWorkspaceState) => props.projectGateways.get(project.projectId) ?? props.fallbackGateway;
  const gateways = [...new Map(props.workspaces.map(project => [owner(project).gatewayNodeId, owner(project)])).values()];
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = props.workspaces.filter(project => {
    const gateway = owner(project);
    const haystack = `${project.projectName} ${project.cwd} ${gateway.label} ${gateway.shortId}`.toLocaleLowerCase();
    return (!gatewayId || gateway.gatewayNodeId === gatewayId) && words.every(word => haystack.includes(word));
  });
  const recent = !query.trim() && !managing
    ? [...new Set(props.recentProjectIds)].flatMap(id => matches.find(project => project.projectId === id) ?? []).slice(0, 4)
    : [];
  const recentIds = new Set(recent.map(project => project.projectId));
  useEffect(() => {
    if (props.active) headingRef.current?.focus();
  }, [props.active]);

  const row = (project: GatewayWorkspaceState) => {
    const unavailable = project.capabilities?.canCreateSession === false;
    const selected = project.projectId === props.selectedProjectId;
    return <button type="button" key={project.projectId}
      className={`session-project-row${selected ? " is-selected" : ""}`}
      disabled={props.busy || (!managing && unavailable)}
      onClick={() => managing ? props.onManageProject?.(project.projectId) : props.onChoose(project)}>
      <span className="session-project-icon" aria-hidden="true">▱</span>
      <span className="session-project-copy"><strong>{project.projectName}</strong>
        <span>{owner(project).label}</span><small>{project.cwd}</small>
        {unavailable && <small>Session creation unavailable on this Gateway</small>}
      </span>
      <span className="session-project-arrow" aria-label={selected ? "Selected project" : undefined}>{selected ? "✓" : "›"}</span>
    </button>;
  };
  return <div className="session-project-picker">
    <header className="session-project-header">
      <div><span className="eyebrow">NEW SESSION · STEP 1 OF 2</span>
        <h2 id="session-project-title" ref={headingRef} tabIndex={-1}>{managing ? "Manage projects" : "Choose a project"}</h2>
        <p>{managing ? "Choose a project to open its settings." : "Where would you like to work?"}</p></div>
      <button type="button" disabled={props.busy} onClick={props.onCancel}>Cancel</button>
    </header>
    <div className="session-project-tools">
      <label className="session-project-search"><span aria-hidden="true">⌕</span>
        <input type="search" aria-label="Search projects, folders or devices" placeholder="Search projects, folders or devices" value={query} onChange={event => setQuery(event.target.value)} />
      </label>
      {gateways.length > 1 && <div className="session-project-filters" aria-label="Filter by Gateway">
        <button type="button" aria-pressed={!gatewayId} onClick={() => setGatewayId("")}>All devices</button>
        {gateways.map(gateway => <button type="button" key={gateway.gatewayNodeId} aria-pressed={gatewayId === gateway.gatewayNodeId}
          onClick={() => setGatewayId(gateway.gatewayNodeId)}>{gateway.label}</button>)}
      </div>}
      {!managing && <div className="session-project-shortcuts">
        <button type="button" disabled={props.busy} onClick={props.onTemporary}><span aria-hidden="true">✧</span><span><strong>Temporary conversation</strong><small>Start in an isolated folder</small></span><b aria-hidden="true">›</b></button>
        {props.onNewProject && <button type="button" disabled={props.busy} onClick={props.onNewProject}><span aria-hidden="true">＋</span><span><strong>New project</strong><small>Connect a working directory</small></span><b aria-hidden="true">›</b></button>}
      </div>}
    </div>
    <div className="session-project-results">
      <p className="session-project-count" role="status">{matches.length} {matches.length === 1 ? "project" : "projects"}</p>
      {recent.length > 0 && <section><h3>Recently used</h3>{recent.map(row)}</section>}
      {gateways.map(gateway => {
        const projects = matches.filter(project => owner(project).gatewayNodeId === gateway.gatewayNodeId && !recentIds.has(project.projectId))
          .sort((a, b) => a.projectName.localeCompare(b.projectName) || a.cwd.localeCompare(b.cwd) || a.projectId.localeCompare(b.projectId));
        return projects.length > 0 && <section key={gateway.gatewayNodeId}><h3>{gateway.label}<span>{projects.length}</span></h3>{projects.map(row)}</section>;
      })}
      {matches.length === 0 && <div className="session-project-empty"><strong>No projects found</strong><p>Try another project name, folder or device.</p>
        <button type="button" onClick={() => { setQuery(""); setGatewayId(""); }}>Clear filters</button></div>}
    </div>
    {props.onManageProject && <footer className="session-project-footer"><span>{managing ? "Project settings and cleanup" : "Keep your project list organized"}</span>
      <button type="button" disabled={props.busy} onClick={() => setManaging(!managing)}>{managing ? "Back to selection" : "Manage projects"}</button></footer>}
  </div>;
}
