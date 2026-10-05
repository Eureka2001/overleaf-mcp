import { HistoryClient, HistoryError } from "../api/history.js";
import type { HistoryChunk, HistoryFile, HistoryLabel, HistoryMeta, HistoryUpdate, HistoryUser } from "../api/historyTypes.js";
import { OverleafProtocolError } from "../api/errors.js";
import type { ActiveProject } from "../session/activeProject.js";

export type VersionRef = number | "latest";
export type HistoryAccess = "full" | "recent_and_labels" | "unknown";
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export function normalizeHistoryPath(path: string): string {
  const normalized = path.replace(/^\/+/, "");
  if (!normalized || normalized.length > 2048 || /[\x00-\x1f\\]/.test(normalized) || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new HistoryError("INVALID_PATH", "Use a project-relative history path with forward slashes, without empty or parent segments.");
  }
  return normalized;
}

export function authors(users: (HistoryUser | null)[]) {
  return users.slice(0, 10).map((user) => user === null ? { unknown: true } : {
    ...(user.id ? { id: user.id } : {}),
    name: [user.first_name, user.last_name].filter(Boolean).join(" ").slice(0, 200) || undefined,
  });
}
export function summarizeMeta(meta: HistoryMeta) {
  return { authors: authors(meta.users), start_time: new Date(meta.start_ts).toISOString(), end_time: new Date(meta.end_ts).toISOString() };
}
export function summarizeLabel(label: HistoryLabel) {
  return { label_id: label.id, name: label.comment.slice(0, 256), name_truncated: label.comment.length > 256,
    history_version: label.version, created_at: label.created_at,
    author: label.user_display_name?.slice(0, 200), author_id: label.user_id };
}
export function summarizeUpdate(update: HistoryUpdate) {
  // Keep complete path names, but cap each metadata collection's payload.
  const bounded = <T>(items: T[], limit: number, chars: number): T[] => {
    const selected: T[] = [];
    let size = 0;
    for (const item of items.slice(0, limit)) {
      const cost = JSON.stringify(item).length + 1;
      if (size + cost > chars) break;
      selected.push(item); size += cost;
    }
    return selected;
  };
  const paths = bounded(update.pathnames, 20, 4500);
  const labels = bounded(update.labels.map(summarizeLabel), 10, 4500);
  const operations = bounded(update.project_ops, 20, 4500);
  return {
    from_version: update.fromV, to_version: update.toV, ...summarizeMeta(update.meta),
    paths, path_count: update.pathnames.length, paths_truncated: paths.length < update.pathnames.length,
    labels, labels_truncated: labels.length < update.labels.length,
    project_operations: operations, project_operation_count: update.project_ops.length,
    project_operations_truncated: operations.length < update.project_ops.length,
  };
}

export class HistorySession {
  readonly access: HistoryAccess;
  readonly projectId: string;
  private readonly cutoff: number;
  private labelsPromise?: Promise<HistoryLabel[]>;
  private latestPromise?: ReturnType<HistoryClient["updates"]>;
  private readonly trees = new Map<number, Promise<HistoryFile[]>>();

  constructor(ap: ActiveProject, readonly client: HistoryClient = new HistoryClient(ap.projectId), now = Date.now()) {
    this.projectId = ap.projectId;
    if (client.projectId !== this.projectId) throw new HistoryError("INVALID_PROJECT", "History client belongs to a different project.");
    this.access = ap.project.features?.versioning === true ? "full" : ap.project.features?.versioning === false ? "recent_and_labels" : "unknown";
    this.cutoff = now - DAY_MS;
  }

  labels() { return this.labelsPromise ??= this.client.labels(); }
  latestPage() { return this.latestPromise ??= this.client.updates(); }

  async latestVersion(): Promise<number> {
    const page = await this.latestPage();
    this.validatePage(page);
    if (!page.updates.length) throw new HistoryError("HISTORY_UNAVAILABLE", "No project history was returned. The project may be new or use disabled/legacy history.");
    return page.updates[0].toV;
  }

  validatePage(page: Awaited<ReturnType<HistoryClient["updates"]>>, before?: number): void {
    for (const [index, update] of page.updates.entries()) {
      if ((before !== undefined && update.toV > before) || (index > 0 && update.toV > page.updates[index - 1].fromV)) {
        throw new OverleafProtocolError("history.updates", "schema", "descending non-overlapping version ranges", "invalid history order");
      }
    }
    if (page.nextBeforeTimestamp != null && (page.nextBeforeTimestamp >= (before ?? Number.MAX_SAFE_INTEGER) ||
      (page.updates.length && page.nextBeforeTimestamp > page.updates.at(-1)!.fromV))) {
      throw new OverleafProtocolError("history.updates", "schema", "decreasing version cursor", "history cursor does not advance");
    }
  }

  async resolveVersion(ref: VersionRef): Promise<number> {
    const latest = await this.latestVersion();
    const version = ref === "latest" ? latest : ref;
    if (!Number.isSafeInteger(version) || version < 0 || version > latest) throw new HistoryError("INVALID_VERSION", `Use a valid history version no later than ${latest}; OT versions are not history versions.`);
    await this.assertReadable(version, latest);
    return version;
  }

  private async assertReadable(version: number, latest: number): Promise<void> {
    if (this.access === "full" || version === latest) return;
    if ((await this.labels()).some((label) => label.version === version)) return;
    let page = await this.latestPage();
    let before: number | undefined;
    for (let count = 0; count < 8; count++) {
      this.validatePage(page, before);
      for (const update of page.updates) {
        // If a grouped range crosses the cutoff, only its recent end state is
        // known to be visible. Don't expose older interior versions by guessing.
        if ((update.meta.start_ts >= this.cutoff && version >= update.fromV && version <= update.toV) ||
          (update.meta.end_ts >= this.cutoff && version === update.toV)) return;
      }
      if (!page.updates.length || page.updates.at(-1)!.meta.end_ts < this.cutoff || page.nextBeforeTimestamp == null) break;
      before = page.nextBeforeTimestamp;
      page = await this.client.updates(10, before);
    }
    throw new HistoryError("HISTORY_ACCESS_LIMITED", "This history version is outside the confirmed recent-history or labeled-version range. Full history requires project history access.");
  }

  async snapshotTree(version: number): Promise<HistoryFile[]> {
    let pending = this.trees.get(version);
    if (!pending) {
      pending = this.client.tree(version, version).then(({ diff }) => {
        if (diff.some((file) => file.operation || file.newPathname)) throw new OverleafProtocolError("history.snapshot_tree", "schema", "unchanged files at one version", "snapshot contains change operations");
        return diff;
      });
      this.trees.set(version, pending);
    }
    return pending;
  }

  async snapshot(version: number, path: string): Promise<string> {
    const tree = await this.snapshotTree(version);
    const files = tree.filter((file) => file.pathname === path);
    if (!files.length) throw new HistoryError("HISTORY_PATH_NOT_FOUND", `File '${path}' does not exist at history version ${version}. Use list_history_files for that version.`);
    if (files.length !== 1) throw new HistoryError("AMBIGUOUS_HISTORY_PATH", "This path is ambiguous in the historical tree.");
    if (files[0].editable === false) throw new HistoryError("BINARY_HISTORY_FILE", "This historical file is binary. History tools return text source and binary change metadata, not PDFs or image bytes.");
    const { diff } = await this.client.diff(version, version, path);
    if (!Array.isArray(diff)) throw new HistoryError("BINARY_HISTORY_FILE", "This historical file is binary; its text cannot be read.");
    if (diff.some((chunk) => chunk.u === undefined)) throw new OverleafProtocolError("history.snapshot_text", "schema", "unchanged text at one version", "snapshot contains insertions/deletions");
    const text = diff.map((chunk) => chunk.u).join("");
    checkTextSize(text);
    return text;
  }

  async comparisonTree(from: number, to: number) {
    const [{ diff }, fromFiles, toFiles] = await Promise.all([
      this.client.tree(from, to), this.snapshotTree(from), this.snapshotTree(to),
    ]);
    const fromPaths = new Set(fromFiles.map((file) => file.pathname));
    const toPaths = new Set(toFiles.map((file) => file.pathname));
    return diff.map((file) => ({
      ...file,
      comparison_path: file.pathname,
      from_path: file.operation !== "added" && fromPaths.has(file.pathname) ? file.pathname : null,
      to_path: file.operation !== "removed" && toPaths.has(file.newPathname ?? file.pathname) ? file.newPathname ?? file.pathname : null,
    }));
  }
}

export type ComparisonFile = Awaited<ReturnType<HistorySession["comparisonTree"]>>[number];
export function summarizeFile(file: ComparisonFile) {
  return { comparison_path: file.comparison_path, from_path: file.from_path, to_path: file.to_path,
    from_exists: file.from_path !== null, to_exists: file.to_path !== null,
    operation: file.operation ?? "unchanged", editable: file.editable ?? (file.operation === "edited" ? true : null),
    ...(file.deletedAtV === undefined ? {} : { deleted_at_version: file.deletedAtV }) };
}
export function checkTextSize(text: string): void {
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) throw new HistoryError("TEXT_TOO_LARGE", "Historical text exceeds the 2 MiB processing limit.");
}
export function reconstructDiff(chunks: HistoryChunk[]) {
  const before = chunks.map((chunk) => chunk.u ?? chunk.d ?? "").join("");
  const after = chunks.map((chunk) => chunk.u ?? chunk.i ?? "").join("");
  checkTextSize(before); checkTextSize(after);
  return { before, after };
}
