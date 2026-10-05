import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HistoryClient, HistoryError } from "../api/history.js";
import { HistoryVersionSchema, type HistoryChunk } from "../api/historyTypes.js";
import { OverleafAuthError, OverleafProtocolError } from "../api/errors.js";
import { getActiveProject, type ActiveProject } from "../session/activeProject.js";
import { decodeCursor, encodeCursor, fitPage } from "../history/cursor.js";
import { formatHistoryDiff, renderHistoryDiff, sliceHistoryText, snapshotDiff } from "../history/diff.js";
import { HistorySession, normalizeHistoryPath, reconstructDiff, summarizeFile, summarizeLabel, summarizeUpdate, type ComparisonFile } from "../history/session.js";
import { logger } from "../util/logger.js";

const VersionRefSchema = z.union([HistoryVersionSchema, z.literal("latest")]).describe("Project history version from list_history (not read_file's OT version), or 'latest'.");
const CursorInput = z.string().min(1).max(4096).optional().describe("Opaque next_cursor from this tool for the same project and arguments.");
const MaxChars = z.number().int().min(1000).max(200_000).default(20_000).describe("Maximum returned source/diff characters, default 20000. Truncation includes an exact continuation position.");
export const ListHistorySchema = z.object({
  mode: z.enum(["updates", "labels"]).default("updates").describe("List grouped edits, or named versions/labels with their history_version."),
  cursor: CursorInput,
  limit: z.number().int().min(1).max(100).default(20).describe("Maximum entries to return; server pages may be larger and are safely repaginated."),
});
export const ListHistoryFilesSchema = z.object({
  history_version: VersionRefSchema,
  cursor: CursorInput,
  limit: z.number().int().min(1).max(500).default(100).describe("Maximum historical files to return."),
});
export const ReadHistoryFileSchema = z.object({
  history_version: VersionRefSchema,
  path: z.string().min(1).max(2048).describe("File path at that history version, from list_history_files; use forward slashes."),
  start_line: z.number().int().min(1).default(1).describe("One-based first line to read."),
  start_column: z.number().int().min(1).default(1).describe("One-based UTF-16 column on the first line; use next_start_column when a long paragraph was truncated."),
  end_line: z.number().int().min(1).optional().describe("Optional inclusive last line. Omit to read to the end, subject to max_chars."),
  max_chars: MaxChars,
});
export const CompareVersionsSchema = z.object({
  from_version: HistoryVersionSchema.describe("Older project history version from list_history or its labels."),
  to_version: VersionRefSchema.default("latest"),
  path: z.string().min(1).max(2048).optional().describe("Omit for changed-file metadata only. To view compact text changes, pass comparison_path from the overview (or an unambiguous old/new path)."),
  cursor: CursorInput,
  limit: z.number().int().min(1).max(500).default(100).describe("Maximum changed files in the overview; does not expand their text."),
  context_lines: z.number().int().min(0).max(10).default(3).describe("Unchanged lines around each changed paragraph; defaults to 3."),
  max_chars: MaxChars,
});

interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}
export interface HistoryToolDependencies {
  getProject?: () => ActiveProject | null;
  createClient?: (ap: ActiveProject) => HistoryClient;
  now?: () => number;
}
const success = (payload: Record<string, unknown>, text?: string): ToolResult => ({
  content: [{ type: "text", text: text ?? JSON.stringify(payload, null, 2) }], structuredContent: payload,
});
function failure(err: unknown): ToolResult {
  const code = err instanceof HistoryError ? err.code : err instanceof OverleafProtocolError ? "HISTORY_PROTOCOL_ERROR" :
    err instanceof OverleafAuthError ? "AUTHENTICATION_REQUIRED" : err instanceof z.ZodError ? "INVALID_ARGUMENTS" : "HISTORY_READ_FAILED";
  const message = err instanceof HistoryError || err instanceof OverleafProtocolError ? err.message :
    code === "AUTHENTICATION_REQUIRED" ? "Session authentication failed. Log in and reopen the project." :
    code === "INVALID_ARGUMENTS" ? "Invalid history tool arguments. Check versions, line ranges and limits." : "Could not read history. Check the connection and try again.";
  logger.error("history tool failed", code);
  return { content: [{ type: "text", text: message }], structuredContent: { error: { code, message,
    ...(err instanceof HistoryError && err.status ? { http_status: err.status } : {}) } }, isError: true };
}

export function createHistoryHandlers(deps: HistoryToolDependencies = {}) {
  const getProject = deps.getProject ?? getActiveProject;
  const run = async (action: (session: HistorySession) => Promise<ToolResult>): Promise<ToolResult> => {
    const ap = getProject();
    if (!ap) return failure(new HistoryError("NO_PROJECT", "No project is open. Call open_project first."));
    try {
      const session = new HistorySession(ap, deps.createClient?.(ap), deps.now?.());
      const result = await action(session);
      if (getProject() !== ap) throw new HistoryError("PROJECT_CHANGED", "The active project changed during this history read. Reopen the intended project and retry.");
      return result;
    } catch (err) { return failure(err); }
  };

  return {
    list_history: (input: unknown) => run(async (session) => {
      const args = ListHistorySchema.parse(input);
      const cursor = decodeCursor(args.cursor, session.projectId, args.mode);
      if (args.mode === "labels") {
        const labels = (await session.labels()).sort((a, b) => b.version - a.version || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const available = cursor?.kind === "labels" ? labels.filter((label) => label.version < cursor.after_version ||
          (label.version === cursor.after_version && label.id > cursor.after_id)) : labels;
        const shown = fitPage(available.map(summarizeLabel), args.limit);
        const last = shown.at(-1);
        return success({ project_id: session.projectId, mode: args.mode, history_access: session.access,
          count: shown.length, total_labels: labels.length, truncated: shown.length < available.length, labels: shown,
          next_cursor: shown.length < available.length && last ? encodeCursor({ kind: "labels", project_id: session.projectId,
            after_version: last.history_version, after_id: last.label_id }) : null });
      }
      const before = cursor?.kind === "updates" ? cursor.before : undefined;
      const page = before === undefined ? await session.latestPage() : await session.client.updates(args.limit, before);
      session.validatePage(page, before);
      const cutoff = (deps.now?.() ?? Date.now()) - 24 * 60 * 60 * 1000;
      const restricted = session.access !== "full";
      const latest = before === undefined ? page.updates[0]?.toV : await session.latestVersion();
      const eligible = restricted ? page.updates.filter((update) => update.meta.end_ts >= cutoff || update.toV === latest) : page.updates;
      const limited = restricted && eligible.length < page.updates.length;
      const shown = fitPage(eligible.map((update) => ({ ...summarizeUpdate(update),
        readable_range: !restricted ? "full" : update.meta.start_ts >= cutoff ? "recent" : "endpoint_only" })), args.limit);
      const clipped = shown.length < eligible.length;
      const nextBefore = clipped ? shown.at(-1)!.from_version : limited ? undefined : page.nextBeforeTimestamp;
      return success({ project_id: session.projectId, mode: args.mode, history_access: session.access,
        latest_history_version: latest, count: shown.length, updates: shown,
        truncated: clipped, access_limit_reached: limited,
        history_available: page.updates.length > 0,
        next_cursor: nextBefore == null ? null : encodeCursor({ kind: "updates", project_id: session.projectId, before: nextBefore }),
        ...(page.updates.length ? {} : { notice: "No updates returned; the project may have no history or use disabled/legacy history." }) });
    }),

    list_history_files: (input: unknown) => run(async (session) => {
      const args = ListHistoryFilesSchema.parse(input);
      const cursor = decodeCursor(args.cursor, session.projectId, "files");
      if (cursor?.kind === "files" && args.history_version !== "latest" && args.history_version !== cursor.version) throw new HistoryError("INVALID_CURSOR", "Use the same history_version with this file cursor.");
      const version = await session.resolveVersion(cursor?.kind === "files" ? cursor.version : args.history_version);
      const files = (await session.snapshotTree(version)).map((file) => ({ path: file.pathname, editable: file.editable ?? null }))
        .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      const offset = cursor?.kind === "files" ? cursor.offset : 0;
      const shown = fitPage(files, args.limit, offset);
      const nextOffset = offset + shown.length;
      return success({ project_id: session.projectId, history_version: version, history_access: session.access,
        count: shown.length, total_files: files.length, files: shown, truncated: nextOffset < files.length,
        next_cursor: nextOffset < files.length ? encodeCursor({ kind: "files", project_id: session.projectId, version, offset: nextOffset }) : null });
    }),

    read_history_file: (input: unknown) => run(async (session) => {
      const args = ReadHistoryFileSchema.parse(input);
      const version = await session.resolveVersion(args.history_version);
      const path = normalizeHistoryPath(args.path);
      const text = await session.snapshot(version, path);
      const slice = sliceHistoryText(text, args.start_line, args.end_line, args.start_column, args.max_chars);
      const payload = { project_id: session.projectId, path, history_version: version, history_access: session.access, kind: "doc", ...slice };
      return success(payload, slice.text + (slice.truncated ? `\n\n[Truncated. Continue at history_version=${version}, start_line=${slice.next_start_line}, start_column=${slice.next_start_column}.]` : ""));
    }),

    compare_versions: (input: unknown) => run(async (session) => {
      const args = CompareVersionsSchema.parse(input);
      const path = args.path === undefined ? undefined : normalizeHistoryPath(args.path);
      const cursor = decodeCursor(args.cursor, session.projectId, path === undefined ? "compare" : "diff");
      if ((cursor?.kind === "compare" || cursor?.kind === "diff") &&
        (cursor.from !== args.from_version || (args.to_version !== "latest" && cursor.to !== args.to_version))) throw new HistoryError("INVALID_CURSOR", "Use the same versions with this comparison cursor.");
      if (cursor?.kind === "diff" && (cursor.path !== path || cursor.context_lines !== args.context_lines)) throw new HistoryError("INVALID_CURSOR", "Use the same path and context_lines with this diff cursor.");
      const from = await session.resolveVersion(args.from_version);
      const to = await session.resolveVersion(cursor?.kind === "compare" || cursor?.kind === "diff" ? cursor.to : args.to_version);
      if (from > to) throw new HistoryError("INVALID_VERSION_RANGE", "from_version must be no later than to_version.");
      let files: ComparisonFile[];
      let snapshotFallback = false;
      try { files = await session.comparisonTree(from, to); }
      catch (err) {
        if (!(err instanceof HistoryError) || err.code !== "RANGE_TOO_LARGE" || path === undefined) throw err;
        const [oldFiles, newFiles] = await Promise.all([session.snapshotTree(from), session.snapshotTree(to)]);
        if (!oldFiles.some((file) => file.pathname === path) || !newFiles.some((file) => file.pathname === path)) {
          throw new HistoryError("RANGE_TOO_LARGE", "Narrow the version range to identify renames/additions/deletions. Snapshot fallback requires the same path in both versions.");
        }
        const oldFile = oldFiles.find((file) => file.pathname === path)!;
        files = [{ ...oldFile, comparison_path: path, from_path: path, to_path: path }];
        snapshotFallback = true;
      }
      if (path === undefined) {
        const changed = files.filter((file) => file.operation).sort((a, b) => a.pathname < b.pathname ? -1 : a.pathname > b.pathname ? 1 : 0);
        const offset = cursor?.kind === "compare" ? cursor.offset : 0;
        const shown = fitPage(changed.map(summarizeFile), args.limit, offset);
        const nextOffset = offset + shown.length;
        const counts = { added: 0, removed: 0, edited: 0, renamed: 0 };
        for (const file of changed) counts[file.operation!]++;
        return success({ project_id: session.projectId, from_version: from, to_version: to, history_access: session.access,
          changed_files: changed.length, count: shown.length, counts, files: shown, truncated: nextOffset < changed.length,
          next_cursor: nextOffset < changed.length ? encodeCursor({ kind: "compare", project_id: session.projectId, from, to, offset: nextOffset }) : null });
      }

      const exact = files.filter((file) => file.comparison_path === path);
      const candidates = exact.length ? exact : files.filter((file) => file.from_path === path || file.to_path === path);
      if (!candidates.length) throw new HistoryError("HISTORY_PATH_NOT_FOUND", "Path is not present in this historical comparison. Use its changed-file overview or list_history_files.");
      if (candidates.length !== 1) throw new HistoryError("AMBIGUOUS_HISTORY_PATH", "This path refers to multiple historical file identities. Narrow the version range.");
      const file = candidates[0];
      const base = { project_id: session.projectId, from_version: from, to_version: to, history_access: session.access, ...summarizeFile(file) };
      const binaryResult = () => success({ ...base, editable: false, binary: true, hunks: [], next_cursor: null,
        notice: "Binary file: only historical file-change metadata is available." });
      if (file.editable === false) return binaryResult();
      let chunks: HistoryChunk[] = [];
      let source = "history";
      try {
        if (snapshotFallback) {
          const [before, after] = await Promise.all([session.snapshot(from, file.from_path!), session.snapshot(to, file.to_path!)]);
          chunks = snapshotDiff(before, after);
          source = "snapshot_fallback";
        } else if (file.operation === "added" || file.operation === "removed") {
          const before = file.from_path ? await session.snapshot(from, file.from_path) : "";
          const after = file.to_path ? await session.snapshot(to, file.to_path) : "";
          chunks = snapshotDiff(before, after);
          source = "snapshot";
        } else if (file.operation) {
          const [oldText, newText] = await Promise.all([
            file.from_path ? session.snapshot(from, file.from_path) : Promise.resolve(""),
            file.to_path ? session.snapshot(to, file.to_path) : Promise.resolve(""),
          ]);
          try {
            const { diff } = await session.client.diff(from, to, file.comparison_path);
            if (!Array.isArray(diff)) return binaryResult();
            chunks = diff;
            const reconstructed = reconstructDiff(chunks);
            if (oldText !== reconstructed.before || newText !== reconstructed.after) throw new HistoryError("HISTORY_INCONSISTENT_DIFF", "Overleaf's text diff does not match the two historical snapshots. Narrow the range and retry.");
          } catch (err) {
            if (!(err instanceof HistoryError) || err.code !== "RANGE_TOO_LARGE" || file.from_path === null || file.from_path !== file.to_path) throw err;
            chunks = snapshotDiff(oldText, newText);
            source = "snapshot_fallback";
          }
        }
      } catch (err) {
        // Some deployments omit editable from tree entries. Preserve the
        // metadata-only contract when a snapshot reveals a binary endpoint.
        if (err instanceof HistoryError && err.code === "BINARY_HISTORY_FILE") return binaryResult();
        throw err;
      }
      const position = cursor?.kind === "diff" ? { hunk: cursor.hunk, line: cursor.line, column: cursor.column } : undefined;
      const view = formatHistoryDiff(chunks, args.context_lines, args.max_chars, position);
      if (view.truncated && !view.hunks.length) throw new HistoryError("OUTPUT_LIMIT_TOO_SMALL", "Increase max_chars to include at least one diff fragment.");
      const { next, ...details } = view;
      const payload = { ...base, operation: snapshotFallback ? view.content_changed ? "edited" : "unchanged" : base.operation,
        binary: false, diff_source: source, file_identity_verified: source !== "snapshot_fallback",
        attribution_available: source === "history" && chunks.some((chunk) => chunk.meta),
        ...details, next_cursor: next ? encodeCursor({ kind: "diff", project_id: session.projectId, from, to, path,
          context_lines: args.context_lines, ...next }) : null };
      const rendered = renderHistoryDiff(view.hunks);
      return success(payload, `${file.from_path ?? "(absent)"} -> ${file.to_path ?? "(absent)"} (history ${from} -> ${to})\n` +
        (rendered || "No text changes.") + (view.truncated ? "\n[Diff truncated; continue with next_cursor and the same versions/path/context_lines.]" : "") +
        (source === "snapshot_fallback" ? "\n[Compared endpoint snapshots; edit-author metadata is unavailable.]" : ""));
    }),
  };
}

export function registerHistory(server: McpServer): void {
  const handlers = createHistoryHandlers();
  server.registerTool("list_history", {
    title: "List project history or labeled versions",
    description: "Lists grouped project history or named versions, with history version numbers, dates, authors and changed paths. " +
      "Requires open_project. Uses bounded pagination; pass next_cursor for more. History versions differ from document OT versions. " +
      "Respects full-history access or the recent/labeled-version range; does not modify the project.",
    inputSchema: ListHistorySchema.shape, annotations: { readOnlyHint: true },
  }, handlers.list_history);
  server.registerTool("list_history_files", {
    title: "List files at a project history version",
    description: "Lists the actual files and editability at one fixed project history version, including old paths of now-renamed/deleted files. " +
      "Use these historical paths with read_history_file. Pagination pins 'latest' to an integer version. Leaves the live file tree and editing cache untouched.",
    inputSchema: ListHistoryFilesSchema.shape, annotations: { readOnlyHint: true },
  }, handlers.list_history_files);
  server.registerTool("read_history_file", {
    title: "Read historical TeX or text source",
    description: "Reads a file's text source at a project history version, not a PDF. Returns text and the fixed history_version, line/byte counts and continuation positions. " +
      "Supports one-based line/column ranges and a character limit. Binary files are refused. Does not change the live edit baseline; use read_file before editing.",
    inputSchema: ReadHistoryFileSchema.shape, annotations: { readOnlyHint: true },
  }, handlers.read_history_file);
  server.registerTool("compare_versions", {
    title: "Compare project history versions",
    description: "Without path, returns only changed-file metadata (added/removed/edited/renamed). " +
      "With path, returns a compact line-numbered source diff containing modified paragraphs and a few context lines, not full unchanged files. " +
      "Limits output and provides next_cursor; replay with the same versions/path/context_lines. Supports latest history and binary change metadata. " +
      "Large-range same-path text comparisons can fall back to endpoint snapshots, explicitly without edit-author attribution. Read-only; never restores versions.",
    inputSchema: CompareVersionsSchema.shape, annotations: { readOnlyHint: true },
  }, handlers.compare_versions);
}
