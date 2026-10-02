import { lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve } from "node:path";

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { expectOk, olGet } from "../api/http.js";
import { getActiveProject } from "../session/activeProject.js";
import { buildOutputUrl } from "./compile.js";
import { logger } from "../util/logger.js";

const Schema = z.object({
  output_path: z
    .string()
    .min(1)
    .describe("Absolute local path on the MCP server's computer to save the PDF. Must end in .pdf. Parent directories are created if needed."),
  overwrite: z
    .boolean()
    .default(false)
    .describe("Allow replacing an existing file. Defaults to false so existing PDFs are preserved."),
});

export function validatePdfPath(outputPath: string): string {
  if (!isAbsolute(outputPath)) {
    throw new Error("output_path must be an absolute local path on the MCP server's computer.");
  }
  if (extname(outputPath).toLowerCase() !== ".pdf") {
    throw new Error("output_path must end in .pdf.");
  }
  return resolve(outputPath);
}

export async function checkPdfDestination(outputPath: string, overwrite = false): Promise<string> {
  const destination = validatePdfPath(outputPath);
  if (overwrite) return destination;
  try {
    await lstat(destination);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return destination;
    throw err;
  }
  throw Object.assign(new Error("Destination already exists."), { code: "EEXIST" });
}

// Validate the body before touching the destination so an unexpected HTML
// response cannot replace a user's existing PDF.
export async function savePdfResponse(
  response: Response,
  outputPath: string,
  overwrite = false,
): Promise<number> {
  const destination = validatePdfPath(outputPath);
  await expectOk(response, "GET compiled output.pdf");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("The download response is not a PDF. Re-run compile and try again; no file was written.");
  }
  await mkdir(dirname(destination), { recursive: true });
  // Exclusive creation protects against another caller racing an exists check.
  await writeFile(destination, bytes, { flag: overwrite ? "w" : "wx" });
  return bytes.length;
}

export function registerDownloadPdf(server: McpServer): void {
  server.registerTool(
    "download_pdf",
    {
      title: "Download the last compiled PDF",
      description:
        "Downloads output.pdf from the most recent compile of the open project in this MCP session, " +
        "using the existing authenticated Overleaf connection, and saves it to an absolute local output_path. " +
        "Call open_project, then compile (with root_doc if needed), then download_pdf in the same session. " +
        "This does not recompile: edits made after that compile are not included. A partial PDF from a compile with LaTeX errors can also be downloaded; check compile.built_cleanly first. " +
        "Checks the PDF signature, creates parent directories, and refuses to overwrite existing files unless overwrite is true. " +
        "If cached build output has expired, re-run compile before downloading.",
      inputSchema: Schema.shape,
    },
    async (args) => {
      const ap = getActiveProject();
      if (!ap) {
        return { content: [{ type: "text", text: "No project is open. Call open_project first." }], isError: true };
      }
      const last = ap.lastCompile;
      if (!last) {
        return { content: [{ type: "text", text: "No compile has been run for the open project in this session. Call compile first." }], isError: true };
      }
      const pdf = last.outputFiles?.find((file) => file.path === "output.pdf");
      if (!pdf) {
        return { content: [{ type: "text", text: "The last compile produced no output.pdf. Check compile/read_log and compile again." }], isError: true };
      }
      try {
        // Refuse existing destinations before downloading a potentially large
        // paper; savePdfResponse still uses exclusive creation to prevent races.
        const outputPath = await checkPdfDestination(args.output_path, args.overwrite);
        const response = await olGet(buildOutputUrl(pdf, last));
        const bytes = await savePdfResponse(response, outputPath, args.overwrite);
        return {
          content: [{ type: "text", text: `Saved compiled PDF to ${outputPath} (${bytes} bytes).` }],
          structuredContent: {
            project_id: ap.projectId,
            project_name: ap.name,
            output_path: outputPath,
            bytes,
            mime_type: "application/pdf",
            compile_status: last.status ?? "unknown",
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const text = (err as NodeJS.ErrnoException)?.code === "EEXIST"
          ? "Destination already exists. Choose another output_path or explicitly set overwrite: true."
          : `PDF download failed: ${msg}`;
        logger.error("download_pdf failed", msg);
        return { content: [{ type: "text", text }], isError: true };
      }
    },
  );
}
