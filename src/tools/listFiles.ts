import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { resolveActiveProject } from "../session/activeProject.js";

const Schema = z.object({
  project_id: z.string().min(8).optional().describe(
    "Overleaf project id from list_projects or open_project. Pass this on every call when MCP sessions may change; opens the requested project if it is not already active.",
  ),
  kind: z
    .enum(["all", "doc", "file", "folder"])
    .default("all")
    .describe("Filter by entity kind. 'doc' = editable .tex/.md files, 'file' = binary assets (images, PDFs), 'folder' = directories."),
  path_contains: z.string().optional().describe("Case-insensitive substring filter on the project-relative path."),
});

export function registerListFiles(server: McpServer): void {
  server.registerTool(
    "list_files",
    {
      title: "List files in the open Overleaf project",
      description:
        "Returns the file tree of the currently open project as a flat list of project-relative paths. " +
        "Uses the cached file tree when the requested project is already active; otherwise project_id opens it first. " +
        "Each entity has a path (e.g. 'chapters/intro.tex'), an id, and a kind ('doc' | 'file' | 'folder').",
      inputSchema: Schema.shape,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => {
      let ap;
      try {
        ap = await resolveActiveProject(args.project_id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to open requested project: ${message}` }], isError: true };
      }
      if (!ap) {
        return {
          content: [{ type: "text", text: "No project is open in this session. Pass project_id from list_projects or open_project, or call open_project in the same session." }],
          isError: true,
        };
      }
      let entities = ap.entities;
      if (args.kind !== "all") entities = entities.filter((e) => e.kind === args.kind);
      if (args.path_contains) {
        const needle = args.path_contains.toLowerCase();
        entities = entities.filter((e) => e.path.toLowerCase().includes(needle));
      }
      entities = [...entities].sort((a, b) => a.path.localeCompare(b.path));
      const lines = entities.map((e) => `${e.kind.padEnd(6)} ${e.path}`);
      const text = lines.length === 0 ? "(no entities matched)" : lines.join("\n");
      return {
        content: [{ type: "text", text }],
        structuredContent: { project_id: ap.projectId, count: entities.length, entities },
      };
    },
  );
}
