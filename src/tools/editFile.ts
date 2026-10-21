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
    .describe("Project-relative path of the doc to edit, e.g. 'main.tex' or 'chapters/intro.tex'. If omitted, defaults to the project's root doc."),
  new_content: z
    .string()
    .describe("Desired full content of the file. The server computes a diff against the current content and submits the minimal OT operation."),
  expected_version: z
    .number()
    .int()
    .optional()
    .describe("Optional safety check. If provided and the doc's current version differs, the edit is rejected."),
  track: z
    .enum(TRACK_MODES)
    .default("on")
    .describe(
      "Tracked-changes mode. This is a client *request*, not a guarantee — when the project has `track_changes_on_for_me: true` (visible in `open_project`'s response), the server forces tracking regardless of what you pass, and the tool response will report `tracked: true, track_overridden: true`. Don't tell the user 'this will be untracked' without first checking that flag from `open_project`. Modes: 'on' (default) — explicitly request tracking; edit lands as a pending suggestion in Overleaf's Review panel, the agent-collaborator-friendly choice. 'off' — request a direct untracked write (may be overridden as above). 'auto' — track iff the project's tc setting says so.",
    ),
  strict_version: z
    .boolean()
    .default(false)
    .describe(
      "If true, re-fetch the doc version from the server before sending the edit and refuse if the cached baseline is stale. Catches races from parallel agents (each MCP process has its own cache) or a concurrently open Overleaf web editor at the cost of one extra round-trip. Without this, the server's OT transform handles stale-version edits silently, which can land the op in an unexpected location or collapse it to a no-op. Recommended when several agents may be editing the same project.",
    ),
});

export function registerEditFile(server: McpServer): void {
  server.registerTool(
    "edit_file",
    {
      title: "Edit a .tex doc in the open Overleaf project",
      description:
        "Replaces the contents of a doc by computing a minimal diff and submitting it as an OT operation " +
        "over the live Socket.IO connection. The change lands in the web editor in real time. " +
        "By default the edit appears as a pending suggestion in the Review panel (track:'on'); pass track:'off' to write directly. " +
        "If `path` is omitted, defaults to the project's root doc. " +
        "Only .tex / .bib / .md / similar text docs are editable — binary files are not.",
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
        const preEditText = cached.text;
        const ops: ShareJsOp[] = textToOps(cached.text, args.new_content);
        if (ops.length === 0) {
          return {
            content: [{ type: "text", text: "No-op: new_content is identical to the current doc." }],
            structuredContent: { path: entity.path, doc_id: entity.id, version: cached.version, ops_applied: 0 },
          };
        }
        const r = await submitAndVerify({
          ap, entity, cached, preEditText,
          expectedText: args.new_content,
          ops, track: args.track,
        });
        const insertedChars = ops.reduce((n, op) => n + (op.i?.length ?? 0), 0);
        const deletedChars = ops.reduce((n, op) => n + (op.d?.length ?? 0), 0);

        if (r.silentNoOp) {
          return {
            content: [{ type: "text", text:
              `Server acked the OT update for '${entity.path}' but the doc text is unchanged (silent no-op). ` +
              `This usually means a parallel agent or open editor bumped the version between your last read and this edit, and the server's OT transform collapsed your ops. ` +
              `Cache is now synced to the real server state (v${r.versionAfter}). Re-call read_file and retry; consider \`strict_version: true\` to fail fast on stale baselines.`,
            }],
            isError: true,
            structuredContent: {
              path: entity.path,
              doc_id: entity.id,
              ops_applied: ops.length,
              chars_inserted: insertedChars,
              chars_deleted: deletedChars,
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
          content: [
            {
              type: "text",
              text:
                `Applied ${ops.length} op(s) to '${entity.path}' (+${insertedChars} / -${deletedChars} chars). ` +
                `Doc version ${cached.version} -> ${r.versionAfter}. ` +
                r.trackingNote + r.concurrentNote + r.verifySkippedNote,
            },
          ],
          structuredContent: {
            path: entity.path,
            doc_id: entity.id,
            ops_applied: ops.length,
            chars_inserted: insertedChars,
            chars_deleted: deletedChars,
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
        logger.error("edit_file failed", msg);
        return { content: [{ type: "text", text: `Failed to edit '${args.path}': ${msg}` }], isError: true };
      }
    }),
  );
}
