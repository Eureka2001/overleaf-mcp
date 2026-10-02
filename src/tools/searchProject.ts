import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { joinDoc } from "../api/socket.js";
import { getActiveProject, refreshProjectTree, type ActiveProject } from "../session/activeProject.js";
import { logger } from "../util/logger.js";

const Schema = z.object({
  query: z.string().min(1).max(1000).describe("Literal text to find; LaTeX backslashes and regex punctuation are matched literally. May span lines."),
  case_sensitive: z.boolean().default(false).describe("Match letter case exactly. Defaults to case-insensitive search."),
  path_contains: z.string().optional().describe("Case-insensitive substring filter on project-relative document paths, e.g. 'sec/' or '.bib'."),
  context_lines: z.number().int().min(0).max(3).default(1).describe("Number of context lines before and after each match. Long lines are clipped around the match."),
  max_results: z.number().int().min(1).max(100).default(50).describe("Maximum matches to return across the project; total_matches still reports the full count."),
});

export type SearchOptions = z.infer<typeof Schema>;
export interface TextMatch {
  line: number;
  column: number;
  end_line: number;
  end_column: number;
  match: string;
  context: { line: number; start_column: number; text: string; truncated: boolean }[];
  context_truncated: boolean;
}

function lineAt(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

export function searchText(text: string, options: SearchOptions, limit = options.max_results): { matches: TextMatch[]; total: number } {
  const query = options.query.replace(/\r\n/g, "\n");
  if (!query) throw new Error("query must not be empty.");
  const literal = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(literal, options.case_sensitive ? "gu" : "giu");
  const lines = text.split("\n");
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) { starts.push(offset); offset += line.length + 1; }
  const matches: TextMatch[] = [];
  let total = 0;
  for (const found of text.matchAll(pattern)) {
    total++;
    if (matches.length >= limit) continue;
    const start = found.index;
    const end = start + found[0].length;
    const firstLine = lineAt(starts, start);
    const lastLine = lineAt(starts, end - 1);
    const context: TextMatch["context"] = [];
    const firstContext = Math.max(0, firstLine - options.context_lines);
    const lastContext = Math.min(lines.length - 1, lastLine + options.context_lines);
    const contextTruncated = lastContext - firstContext + 1 > 12;
    const indices = contextTruncated
      ? [...Array.from({ length: 6 }, (_, i) => firstContext + i), ...Array.from({ length: 6 }, (_, i) => lastContext - 5 + i)]
      : Array.from({ length: lastContext - firstContext + 1 }, (_, i) => firstContext + i);
    for (const i of indices) {
      const from = i === firstLine ? Math.max(0, start - starts[i] - 100) : 0;
      const clipped = lines[i].slice(from, from + 300);
      context.push({ line: i + 1, start_column: from + 1, text: clipped, truncated: from > 0 || from + clipped.length < lines[i].length });
    }
    const endLine = lineAt(starts, end);
    matches.push({
      line: firstLine + 1, column: start - starts[firstLine] + 1,
      end_line: endLine + 1, end_column: end - starts[endLine] + 1,
      match: found[0], context, context_truncated: contextTruncated,
    });
  }
  return { matches, total };
}

// Reads fresh documents without updateDoc: search snippets must not replace
// the baseline that read_file pinned for a later strict-version edit.
export async function searchDocuments(
  ap: ActiveProject,
  options: SearchOptions,
  readDoc: (id: string) => Promise<Awaited<ReturnType<typeof joinDoc>>> = joinDoc,
) {
  const docs = ap.entities.filter((entity) => entity.kind === "doc" &&
    (!options.path_contains || entity.path.toLowerCase().includes(options.path_contains.toLowerCase())))
    .sort((a, b) => a.path.localeCompare(b.path));
  const matches: (TextMatch & { path: string; doc_id: string; version: number })[] = [];
  const readErrors: { path: string; error: string }[] = [];
  let totalMatches = 0;
  let filesSearched = 0;
  let filesMatched = 0;
  for (const doc of docs) {
    try {
      const snapshot = await readDoc(doc.id);
      const result = searchText(snapshot.docLines.join("\n"), options, options.max_results - matches.length);
      filesSearched++;
      totalMatches += result.total;
      if (result.total > 0) filesMatched++;
      matches.push(...result.matches.map((match) => ({ path: doc.path, doc_id: doc.id, version: snapshot.version, ...match })));
    } catch (err) {
      readErrors.push({ path: doc.path, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return {
    project_id: ap.projectId, query: options.query, case_sensitive: options.case_sensitive,
    files_searched: filesSearched, files_matched: filesMatched,
    total_matches: totalMatches, returned_matches: matches.length,
    truncated: totalMatches > matches.length, complete: readErrors.length === 0,
    read_errors: readErrors, matches,
  };
}

export function registerSearchProject(server: McpServer): void {
  server.registerTool("search_project", {
    title: "Search the open Overleaf project",
    description: "Searches live editable text documents across the open project for literal text. " +
      "Refreshes the file tree, returns one-based line/column (UTF-16), context, doc_id and live version for each match. " +
      "Supports case sensitivity, path filtering and a project-wide result cap; reports truncation and per-file read failures explicitly. " +
      "Binary assets are skipped. Does not change text or read_file's cached edit baselines; call read_file before editing a match.",
    inputSchema: Schema.shape,
    annotations: { readOnlyHint: true },
  }, async (args) => {
    const ap = getActiveProject();
    if (!ap) return { content: [{ type: "text", text: "No project is open. Call open_project first." }], isError: true };
    try {
      await refreshProjectTree(ap);
      const summary = await searchDocuments(ap, args);
      const details = summary.matches.map((match) => `${match.path}:${match.line}:${match.column} (version ${match.version})\n` +
        match.context.map((line) => `  ${line.line}: ${line.start_column > 1 ? "…" : ""}${line.text}${line.truncated ? "…" : ""}`).join("\n")).join("\n\n");
      const headline = `${summary.total_matches} match(es) in ${summary.files_matched} of ${summary.files_searched} searched doc(s). ` +
        (summary.truncated ? `Showing ${summary.returned_matches}; results truncated. ` : "") +
        (!summary.complete ? `Incomplete search: ${summary.read_errors.length} document(s) could not be read. ` : "");
      return { content: [{ type: "text", text: headline + (details ? `\n\n${details}` : "") }], structuredContent: summary,
        ...(summary.complete ? {} : { isError: true }) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("search_project failed", msg);
      return { content: [{ type: "text", text: `Project search failed: ${msg}` }], isError: true };
    }
  });
}
