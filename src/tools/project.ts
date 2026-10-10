// Shared project selection for every project-scoped tool: the optional
// `project_id` argument, the read/write targeting rule (see ProjectSelector),
// and echoing which project a call acted on.

import { z } from "zod";

import { projectSelector, type ActiveProject, type ProjectAccess } from "../session/activeProject.js";

export const projectIdArg = z
  .string()
  .min(8)
  .optional()
  .describe(
    "Overleaf project id from list_projects or open_project. Opens the project if it is not already active. " +
      "Pass it on every call when MCP sessions may change between calls. " +
      "Writes without it only go to the project last confirmed by open_project or by a write naming it.",
  );

export type ToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

// One socket and one doc cache serve the whole process, so a call that switches
// projects mid-flight would pull them out from under another call's joinDoc /
// applyOtUpdate. Project-scoped calls (and open_project) therefore run one at a
// time; MCP clients may issue tool calls in parallel.
let queue: Promise<unknown> = Promise.resolve();

export function withProjectLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Wrap a tool handler so it runs against the resolved project. Results carry
 * `project_id` / `project_name`, and a note when the call switched projects.
 */
export function projectTool<A extends { project_id?: string }>(
  access: ProjectAccess,
  handler: (args: A, ap: ActiveProject) => Promise<ToolResponse>,
): (args: A) => Promise<ToolResponse> {
  return (args) => withProjectLock(async () => {
    let resolution;
    try {
      resolution = await projectSelector.resolve(args.project_id, access);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Failed to open requested project: ${message}` }], isError: true };
    }
    if (!resolution.ok) return { content: [{ type: "text", text: resolution.error }], isError: true };
    const { ap, switchedFrom } = resolution;
    const res = await handler(args, ap);
    const content = switchedFrom
      ? [{ type: "text" as const, text: `Note: switched active project from "${switchedFrom.name}" to "${ap.name}" (${ap.projectId}).` }, ...res.content]
      : res.content;
    return {
      ...res,
      content,
      ...(res.structuredContent && {
        structuredContent: { project_id: ap.projectId, project_name: ap.name, ...res.structuredContent },
      }),
    };
  });
}
