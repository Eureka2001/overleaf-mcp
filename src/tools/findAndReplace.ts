import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { textToOps, type ShareJsOp } from "../ot/diff.js";
import { TRACK_MODES } from "../ot/trackedChanges.js";
import { prepareBaseline, resolveDocForEdit, submitAndVerify } from "../ot/editPipeline.js";
import { logger } from "../util/logger.js";
import { projectIdArg, projectTool } from "./project.js";

const Schema = z.object({
  project_id: projectIdArg,
  path: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Project-relative path of the doc to edit, e.g. 'main.tex'. If omitted, defaults to the project's root doc.",
    ),
  old_string: z
    .string()
    .min(1)
    .describe(
      "Exact substring to find — must match byte-for-byte including whitespace. Must be unique in the doc unless `replace_all` is true.",
    ),
  new_string: z
    .string()
    .describe("Replacement text. May be empty (effectively a delete)."),
  replace_all: z
    .boolean()
    .default(false)
    .describe(
      "If true, replace every occurrence of `old_string`. If false (default), `old_string` must match exactly once — multi-match returns a list of locations so you can disambiguate with a longer `old_string`.",
    ),
  expected_version: z
    .number()
    .int()
    .optional()
    .describe("Optional safety check. If the doc's current version differs, the edit is rejected."),
  track: z
    .enum(TRACK_MODES)
    .default("on")
    .describe(
      "Tracked-changes mode. This is a client *request*, not a guarantee — when the project has `track_changes_on_for_me: true` (visible in `open_project`'s response), the server forces tracking regardless of what you pass, and the tool response will report `tracked: true, track_overridden: true`. Don't tell the user 'this will be untracked' without first checking that flag from `open_project`. Modes: 'on' (default) — explicitly request tracking; edit lands as a pending suggestion in Overleaf's Review panel. 'off' — request a direct untracked write (may be overridden as above). 'auto' — track iff the project's tc setting says so.",
    ),
  strict_version: z
    .boolean()
    .default(false)
    .describe(
      "If true, re-fetch the doc version before sending the edit and refuse if the cached baseline is stale. Catches races from parallel agents (each MCP process has its own cache) or a concurrently open Overleaf web editor at the cost of one extra round-trip. Without this, the server's OT transform handles stale-version edits silently, which can land the op in an unexpected location or collapse it to a no-op. Recommended when several agents may be editing the same project.",
    ),
});

// Find every non-overlapping start index of `needle` in `haystack`.
export function findAllIndices(haystack: string, needle: string): number[] {
  if (!needle) return [];
  const out: number[] = [];
  let i = 0;
  while (i <= haystack.length - needle.length) {
    const j = haystack.indexOf(needle, i);
    if (j < 0) break;
    out.push(j);
    i = j + needle.length;
  }
  return out;
}

// Map a char index into (1-based line, 1-based col, the full line text).
export function lineOf(text: string, idx: number): { line: number; col: number; lineText: string } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < idx; i++) {
    if (text.charCodeAt(i) === 0x0a /* \n */) {
      line++;
      lineStart = i + 1;
    }
  }
  const nextNl = text.indexOf("\n", lineStart);
  const lineEnd = nextNl < 0 ? text.length : nextNl;
  return { line, col: idx - lineStart + 1, lineText: text.slice(lineStart, lineEnd) };
}

export function registerFindAndReplace(server: McpServer): void {
  server.registerTool(
    "find_and_replace",
    {
      title: "Surgical find-and-replace in an Overleaf doc",
      description:
        "Replace one occurrence — or all, with `replace_all: true` — of `old_string` with `new_string` in a doc, without re-emitting the rest of the file. " +
        "By default `old_string` must be unique; ambiguous matches are returned with line:column locations so you can extend the match. " +
        "Submits the minimal OT operation through the same pathway as `edit_file`, so by default it lands as a pending suggestion in Overleaf's Review panel (track:'on'). " +
        "If `path` is omitted, defaults to the project's root doc. " +
        "USE WHEN: a SINGLE targeted edit (one typo, one label rename, one heading change) in a large doc — saves tokens vs. re-emitting the body and avoids accidental whitespace drift. " +
        "AVOID FOR BATCH WORK: for multiple substitutions (e.g. converting many words, applying a style guide across a chapter) prefer ONE `edit_file` call with all changes computed client-side. " +
        "Each find_and_replace is its own round-trip with its own race window, its own tracked-change entry, and its own cache-sync cycle — calling it N times for N small changes amplifies the failure modes that one batched `edit_file` would avoid.",
      inputSchema: Schema.shape,
    },
    projectTool("write", async (args) => {
      const resolved = resolveDocForEdit(args.path);
      if (!resolved.ok) return resolved.response;
      const { ap, entity } = resolved.doc;
      try {
        const baseline = await prepareBaseline(entity, { expected_version: args.expected_version, strict_version: args.strict_version });
        if (!baseline.ok) return baseline.response;
        const { cached } = baseline;
        const indices = findAllIndices(cached.text, args.old_string);
        if (indices.length === 0) {
          return {
            content: [{
              type: "text",
              text:
                `\`old_string\` not found in '${entity.path}' (doc has ${cached.text.length} chars at version ${cached.version}). ` +
                `Check whitespace, line endings, and that you're reading the current text — re-call read_file if unsure.`,
            }],
            isError: true,
          };
        }
        if (indices.length > 1 && !args.replace_all) {
          const sample = indices.slice(0, 10).map((i) => {
            const { line, col, lineText } = lineOf(cached.text, i);
            const trimmed = lineText.trim();
            const preview = trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
            return `  line ${line}:${col}  ${preview}`;
          }).join("\n");
          const more = indices.length > 10 ? `\n  ...and ${indices.length - 10} more` : "";
          return {
            content: [{
              type: "text",
              text:
                `\`old_string\` matched ${indices.length} times in '${entity.path}'. ` +
                `Either extend \`old_string\` so it uniquely identifies one occurrence, or pass \`replace_all: true\` to replace every match.\nMatches:\n${sample}${more}`,
            }],
            isError: true,
          };
        }
        const preEditText = cached.text;
        const newContent = args.replace_all
          ? cached.text.split(args.old_string).join(args.new_string)
          : cached.text.slice(0, indices[0]) + args.new_string + cached.text.slice(indices[0] + args.old_string.length);
        const ops: ShareJsOp[] = textToOps(cached.text, newContent);
        if (ops.length === 0) {
          return {
            content: [{ type: "text", text: "No-op: old_string is identical to new_string at every match." }],
            structuredContent: { path: entity.path, doc_id: entity.id, version: cached.version, ops_applied: 0 },
          };
        }
        const r = await submitAndVerify({
          ap, entity, cached, preEditText,
          expectedText: newContent,
          ops, track: args.track,
        });
        const replacements = args.replace_all ? indices.length : 1;

        if (r.silentNoOp) {
          return {
            content: [{ type: "text", text:
              `Server acked the OT update for '${entity.path}' but the doc text is unchanged (silent no-op). ` +
              `\`old_string\` matched in your cached baseline, ops were sent and acked, but the server's doc didn't move — usually because a parallel agent or open editor bumped the version between your last read and this edit, and the server's OT transform collapsed your ops. ` +
              `Cache is now synced to the real server state (v${r.versionAfter}). Re-call read_file and retry; consider \`strict_version: true\` to fail fast on stale baselines.`,
            }],
            isError: true,
            structuredContent: {
              path: entity.path,
              doc_id: entity.id,
              replacements: 0,
              ops_applied: ops.length,
              version_before: cached.version,
              version_after: r.versionAfter,
              tracked: r.serverWillTrack,
              track_mode: args.track,
              track_overridden: r.trackOverridden,
              verification_failed: true,
              silent_no_op: true,
            },
          };
        }

        return {
          content: [{
            type: "text",
            text:
              `Replaced ${replacements} occurrence(s) in '${entity.path}'. Doc version ${cached.version} -> ${r.versionAfter}. ` +
              r.trackingNote + r.concurrentNote + r.verifySkippedNote,
          }],
          structuredContent: {
            path: entity.path,
            doc_id: entity.id,
            replacements,
            ops_applied: ops.length,
            version_before: cached.version,
            version_after: r.versionAfter,
            tracked: r.serverWillTrack,
            track_mode: args.track,
            track_overridden: r.trackOverridden,
            verified: r.v ? r.v.matchesExpected : false,
            had_concurrent_writes_after: r.v?.hadConcurrentWritesAfter ?? false,
            verify_skipped: Boolean(r.verifyError),
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("find_and_replace failed", msg);
        return {
          content: [{ type: "text", text: `Failed to find_and_replace in '${args.path ?? "(root doc)"}': ${msg}` }],
          isError: true,
        };
      }
    }),
  );
}
