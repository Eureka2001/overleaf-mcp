import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { projectSelector } from "../session/activeProject.js";
import { logger } from "../util/logger.js";

const Schema = z.object({
  project_id: z
    .string()
    .min(8)
    .describe("The Overleaf project id, from list_projects (a hex string like '61d853bcbf1003100e957034')."),
});

export function registerOpenProject(server: McpServer): void {
  server.registerTool(
    "open_project",
    {
      title: "Open Overleaf project",
      description:
        "Joins the project's real-time Socket.IO session and caches its file tree. " +
        "Must be called before list_files / read_file / edit_file. " +
        "Switching projects automatically closes the previous session.",
      inputSchema: Schema.shape,
    },
    async (args) => {
      try {
        const p = await projectSelector.select(args.project_id);
        const project = p.project;
        const summary = {
          project_id: p.projectId,
          name: p.name,
          root_doc_path: p.rootDocPath,
          root_doc_id: p.rootDocId,
          entity_count: p.entities.length,
          docs: p.entities.filter((e) => e.kind === "doc").length,
          files: p.entities.filter((e) => e.kind === "file").length,
          folders: p.entities.filter((e) => e.kind === "folder").length,
          track_changes_on_for_me: p.trackChangesOnForMe,
          compiler: project.compiler,
          spell_check_language: project.spellCheckLanguage,
          public_access_level: project.publicAccesLevel,
          owner: project.owner ? { email: project.owner.email, name: [project.owner.first_name, project.owner.last_name].filter(Boolean).join(" ") || undefined } : undefined,
          members: (project.members ?? []).map((m) => ({ email: m.email, name: [m.first_name, m.last_name].filter(Boolean).join(" ") || undefined, privileges: m.privileges })),
        };
        return {
          content: [
            {
              type: "text",
              text:
                `Opened "${p.name}" (${summary.docs} docs, ${summary.files} files, ${summary.folders} folders). ` +
                `Track changes ${summary.track_changes_on_for_me ? "is ON" : "is OFF"} for this user. ` +
                `Root doc: ${p.rootDocPath ?? "(unset)"}. ` +
                `Compiler: ${summary.compiler ?? "(default)"}. ` +
                `Use list_files to browse, read_file/edit_file to read+write (path defaults to the root doc).`,
            },
          ],
          structuredContent: summary,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("open_project failed", msg);
        return { content: [{ type: "text", text: `Failed to open project: ${msg}` }], isError: true };
      }
    },
  );
}
