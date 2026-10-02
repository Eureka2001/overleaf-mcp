import { ensureSocketForProject, disconnectActive, fetchProjectSnapshot, getActiveSocket } from "../api/socket.js";
import { flattenTree, isTrackChangesOnForUser, type FlatEntity, type ProjectEntity } from "../api/projectTypes.js";
import type { CompileResponse } from "../api/compileTypes.js";
import { getIdentity } from "./identity.js";
import { clearDocCache } from "./docCache.js";

export interface ActiveProject {
  projectId: string;
  name: string;
  project: ProjectEntity;
  entities: FlatEntity[];
  trackChangesOnForMe: boolean;
  rootDocId?: string;
  rootDocPath?: string;
  lastCompile?: CompileResponse;
}

let active: ActiveProject | null = null;

export function setLastCompile(result: CompileResponse): void {
  if (active) active.lastCompile = result;
}

export function getActiveProject(): ActiveProject | null {
  return active;
}

// Use a separate short-lived socket for fresh structure. Keep the persistent
// socket's joined docs, read_file's pinned baselines and lastCompile intact.
export async function refreshProjectTree(ap: ActiveProject): Promise<void> {
  if (active !== ap) throw new Error("The active project changed. Open the intended project and try again.");
  const project = await fetchProjectSnapshot(ap.projectId);
  if (!project || project._id !== ap.projectId || !Array.isArray(project.rootFolder)) {
    throw new Error("Overleaf returned an invalid project tree; reopen the project and try again.");
  }
  if (active !== ap) throw new Error("The active project changed while refreshing its file tree.");
  const socket = getActiveSocket();
  if (socket?.projectId === ap.projectId) socket.joinedProject = project;
  ap.project = project;
  ap.name = project.name ?? ap.name;
  ap.entities = project.rootFolder[0] ? flattenTree(project.rootFolder[0]) : [];
  ap.rootDocId = project.rootDoc_id;
  ap.rootDocPath = ap.entities.find((entity) => entity.kind === "doc" && entity.id === ap.rootDocId)?.path;
  const identity = await getIdentity();
  ap.trackChangesOnForMe = isTrackChangesOnForUser(project, identity.userId);
}

export async function open(projectId: string): Promise<ActiveProject> {
  const { joinedProject } = await ensureSocketForProject(projectId);
  if (!joinedProject) {
    throw new Error("joinProject did not return a project entity");
  }
  clearDocCache();
  // rootFolder is an array containing the single top-level folder.
  const root = joinedProject.rootFolder?.[0];
  const entities = root ? flattenTree(root) : [];
  const identity = await getIdentity();
  const trackChangesOnForMe = isTrackChangesOnForUser(joinedProject, identity.userId);
  const rootDocId = joinedProject.rootDoc_id;
  const rootDocPath = rootDocId ? entities.find((e) => e.kind === "doc" && e.id === rootDocId)?.path : undefined;
  active = {
    projectId,
    name: joinedProject.name ?? "(unnamed)",
    project: joinedProject,
    entities,
    trackChangesOnForMe,
    rootDocId,
    rootDocPath,
  };
  return active;
}

export function close(): void {
  disconnectActive();
  clearDocCache();
  active = null;
}

export function findByPath(path: string): FlatEntity | undefined {
  if (!active) return undefined;
  const normalized = path.replace(/^\/+/, "");
  return active.entities.find((e) => e.path === normalized);
}

export function docPathById(ap: ActiveProject): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of ap.entities) if (e.kind === "doc") m.set(e.id, e.path);
  return m;
}
