import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, posix } from "node:path";

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { asJson, expectOk, olDelete, olGet, olPostJson, olPostMultipart } from "../api/http.js";
import { getActiveProject, refreshProjectTree, type ActiveProject } from "../session/activeProject.js";
import { logger } from "../util/logger.js";

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const ASSET_MIMES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".tif": "image/tiff", ".tiff": "image/tiff", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".eps": "application/postscript", ".ps": "application/postscript",
  ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2",
};

const Schema = z.object({
  local_path: z.string().min(1).describe("Absolute local path on the MCP server's computer to an image, PDF, vector graphic or font asset (up to 50 MiB). Text documents are not supported; use tracked edit_file/find_and_replace for those."),
  project_path: z.string().min(1).optional().describe("Project-relative destination including the filename, e.g. 'img/error-analysis.pdf'. Defaults to the local basename at project root. Use forward slashes; parent folders must already exist."),
  overwrite: z.boolean().default(false).describe("Explicitly allow replacing an existing binary asset. Defaults to false; a temporary upload plus conflict-checked rename prevents overwriting a file created concurrently."),
});

export function assetMime(name: string): string {
  const mime = ASSET_MIMES[extname(name).toLowerCase()];
  if (!mime) throw new Error("Only image, PDF, vector graphic and font assets can be uploaded. Edit text documents through the tracked editing tools.");
  return mime;
}

export async function readLocalAsset(localPath: string): Promise<Buffer> {
  if (!isAbsolute(localPath)) throw new Error("local_path must be an absolute local path on the MCP server's computer.");
  assetMime(localPath);
  const info = await stat(localPath);
  if (!info.isFile()) throw new Error("local_path must point to a regular file.");
  if (info.size === 0 || info.size > MAX_UPLOAD_BYTES) throw new Error("The asset must be nonempty and at most 50 MiB.");
  const bytes = await readFile(localPath);
  if (bytes.length === 0 || bytes.length > MAX_UPLOAD_BYTES) throw new Error("The asset must be nonempty and at most 50 MiB.");
  return bytes;
}

export function resolveUploadTarget(ap: ActiveProject, path: string, overwrite: boolean) {
  if (path.startsWith("/") || path.includes("\\") || path.endsWith("/")) {
    throw new Error("project_path must be a project-relative filename using forward slashes.");
  }
  const segments = path.split("/");
  if (segments.some((part) => !part || part === "." || part === ".." || part !== part.trim() ||
    /[\x00-\x1f\x7f:*?"<>|]/.test(part))) throw new Error("project_path contains an invalid path component.");
  const name = segments[segments.length - 1];
  if (name.length >= 150) throw new Error("The destination filename must be shorter than 150 characters.");
  const mime = assetMime(name);
  const folderPath = segments.slice(0, -1).join("/");
  const root = ap.project.rootFolder[0];
  const folder = folderPath ? ap.entities.find((entity) => entity.kind === "folder" && entity.path === folderPath) : undefined;
  const folderId = folderPath ? folder?.id : root?._id;
  if (!folderId) throw new Error(`Destination folder '${folderPath || "/"}' was not found. Use list_files and choose an existing folder.`);
  // Overleaf reserves duplicate names without regard to case.
  const existing = ap.entities.find((entity) => entity.parentFolderId === folderId && entity.name.toLowerCase() === name.toLowerCase());
  if (existing && existing.kind !== "file") throw new Error("The destination is an editable document or folder. Upload cannot replace it; use tracked editing for text.");
  if (existing && !overwrite) throw new Error("Destination already exists. Choose another project_path or explicitly set overwrite: true for a binary asset.");
  if (existing && existing.name !== name) throw new Error(`The destination differs only in case from '${existing.path}'. Use its exact path to overwrite it.`);
  return { path, name, folderId, mime, existing };
}

export function uploadForm(bytes: Buffer, name: string, mime: string): FormData {
  const form = new FormData();
  form.append("name", name);
  form.append("qqfile", new Blob([new Uint8Array(bytes)], { type: mime }), name);
  return form;
}

export function parseUploadResponse(value: unknown): { id: string } {
  const parsed = z.object({ success: z.literal(true), entity_id: z.string().regex(/^[a-f\d]{24}$/i), entity_type: z.literal("file") }).safeParse(value);
  if (!parsed.success) {
    const reason = value && typeof value === "object" && "error" in value ? String(value.error) : "invalid response or non-asset entity";
    throw new Error(`Overleaf did not confirm a binary upload: ${reason}.`);
  }
  return { id: parsed.data.entity_id };
}

export interface UploadTransport {
  refresh(): Promise<void>;
  upload(folderId: string, name: string, bytes: Buffer, mime: string): Promise<unknown>;
  rename(id: string, name: string): Promise<void>;
  download(id: string): Promise<Buffer>;
  remove(id: string): Promise<void>;
}

function transportFor(ap: ActiveProject): UploadTransport {
  const base = `project/${ap.projectId}`;
  return {
    refresh: () => refreshProjectTree(ap),
    upload: async (folderId, name, bytes, mime) => asJson(await olPostMultipart(
      `Project/${ap.projectId}/upload?${new URLSearchParams({ folder_id: folderId })}`, uploadForm(bytes, name, mime),
    ), "POST asset upload"),
    rename: async (id, name) => { await expectOk(await olPostJson(`${base}/file/${id}/rename`, { name }), "POST rename uploaded asset"); },
    download: async (id) => {
      const response = await olGet(`${base}/file/${id}`);
      await expectOk(response, "GET uploaded asset for byte verification");
      return Buffer.from(await response.arrayBuffer());
    },
    remove: async (id) => { await expectOk(await olDelete(`${base}/file/${id}`), "DELETE own temporary upload"); },
  };
}

export async function uploadAsset(
  ap: ActiveProject, bytes: Buffer, path: string, overwrite: boolean,
  transport: UploadTransport = transportFor(ap),
) {
  if (bytes.length === 0 || bytes.length > MAX_UPLOAD_BYTES) throw new Error("The asset must be nonempty and at most 50 MiB.");
  await transport.refresh();
  const target = resolveUploadTarget(ap, path, overwrite);
  const temporaryName = `mcp-upload-${randomUUID()}${extname(target.name)}`;
  const uploadName = overwrite ? target.name : temporaryName;
  let uploadedId: string | undefined;
  const summary = () => ({
    project_id: ap.projectId, project_name: ap.name, path: target.path,
    file_id: uploadedId!, kind: "file", mime_type: target.mime, bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    overwritten: Boolean(target.existing), verified: true,
  });
  try {
    const response = await transport.upload(target.folderId, uploadName, bytes, target.mime);
    uploadedId = parseUploadResponse(response).id;
    const remote = await transport.download(uploadedId);
    if (!remote.equals(bytes)) throw new Error("Uploaded bytes do not match the local asset.");
    if (!overwrite) await transport.rename(uploadedId, target.name);
    await transport.refresh();
    if (!ap.entities.some((entity) => entity.kind === "file" && entity.id === uploadedId && entity.path === target.path)) {
      throw new Error("The uploaded file was not found at the requested path after refreshing the project tree.");
    }
    return summary();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    let cleanupNote = "";
    try {
      await transport.refresh();
      const final = ap.entities.find((entity) => entity.kind === "file" && entity.id === uploadedId && entity.path === target.path);
      // A lost HTTP acknowledgement can occur after a successful rename.
      // Confirm the final bytes before reporting that operation as successful.
      if (final && (await transport.download(final.id)).equals(bytes)) return summary();
      if (!overwrite) {
        const ownTemporary = ap.entities.find((entity) => entity.kind === "file" && entity.name === temporaryName &&
          entity.parentFolderId === target.folderId && (!uploadedId || entity.id === uploadedId));
        if (ownTemporary) {
          await transport.remove(ownTemporary.id);
          await transport.refresh();
          cleanupNote = " The temporary asset was removed; the destination was not overwritten.";
        } else if (final) {
          cleanupNote = ` An asset remains at '${target.path}'; inspect it before retrying.`;
        }
      } else {
        cleanupNote = ` Upload may have changed '${target.path}'; inspect it before retrying.`;
      }
    } catch (cleanupError) {
      cleanupNote = ` Could not confirm or clean up the upload (${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}). ` +
        `Inspect '${overwrite ? target.path : posix.join(posix.dirname(target.path), temporaryName)}' before retrying.`;
    }
    throw new Error(`${message}${cleanupNote}`);
  }
}

export function registerUploadFile(server: McpServer): void {
  server.registerTool("upload_file", {
    title: "Upload a binary asset to Overleaf",
    description: "Uploads an image, vector graphic, PDF or font asset from an absolute local_path into the open project. " +
      "Text document uploads are prohibited so they cannot bypass tracked edits. Parent folders must already exist. " +
      "Default overwrite:false uses a unique temporary asset plus conflict-checked rename. overwrite:true explicitly allows binary replacement. " +
      "Verifies downloaded remote bytes against the source, refreshes the cached file tree, and removes only its own temporary asset on failure. " +
      "Binary assets do not produce text-review suggestions; use tracked edits to update LaTeX references, then compile.",
    inputSchema: Schema.shape,
  }, async (args) => {
    const ap = getActiveProject();
    if (!ap) return { content: [{ type: "text", text: "No project is open. Call open_project first." }], isError: true };
    try {
      const mime = assetMime(args.local_path);
      const path = args.project_path ?? basename(args.local_path);
      if (assetMime(path) !== mime) throw new Error("The destination must use the same asset type as the local file.");
      const bytes = await readLocalAsset(args.local_path);
      const summary = await uploadAsset(ap, bytes, path, args.overwrite);
      return {
        content: [{ type: "text", text: `${summary.overwritten ? "Replaced" : "Uploaded"} '${summary.path}' (${summary.bytes} bytes); remote bytes verified, file tree refreshed.` }],
        structuredContent: summary,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("upload_file failed", msg);
      return { content: [{ type: "text", text: `Asset upload failed: ${msg}` }], isError: true };
    }
  });
}
