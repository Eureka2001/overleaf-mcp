import { z } from "zod";
import { describeShape } from "../api/errors.js";
import type { FolderEntity, ProjectEntity } from "../api/projectTypes.js";
import type { CompileResponse } from "../api/compileTypes.js";
import type { RangesResponse, ThreadsByIdResponse } from "../api/commentTypes.js";
import { DiagnosticError, type DiagnosticCategory } from "./model.js";

function contract<T>(schema: z.ZodType<T>, value: unknown, category: DiagnosticCategory, expected: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const paths = parsed.error.issues.slice(0, 6).map((issue) => `${issue.path.join(".") || "response"}: ${issue.code}`).join("; ");
    throw new DiagnosticError(category, expected, `${describeShape(value)}; ${paths}`);
  }
  return parsed.data;
}

const entity = z.object({ _id: z.string().min(1), name: z.string() }).passthrough();
const folder: z.ZodType<FolderEntity> = z.lazy(() => entity.extend({ docs: z.array(entity), fileRefs: z.array(entity), folders: z.array(folder) }));
export function checkProjectTree(value: unknown): ProjectEntity {
  return contract(z.object({ _id: z.string(), name: z.string(), rootDoc_id: z.string().optional(), rootFolder: z.array(folder).length(1) }).passthrough(), value,
    "SOCKET_PROTOCOL", "project.rootFolder: exactly one folder{_id,name,docs[],fileRefs[],folders[]}; project.rootDoc_id?: string") as ProjectEntity;
}

const metadata = z.object({ user_id: z.string().optional(), ts: z.string().optional() }).passthrough().optional();
const changes = z.array(z.object({
  id: z.string(), op: z.object({ p: z.number().int().nonnegative(), i: z.string().optional(), d: z.string().optional() })
    .refine((op) => (op.i !== undefined) !== (op.d !== undefined)), metadata,
}).passthrough()).optional();
const comments = z.array(z.object({
  id: z.string(), op: z.object({ p: z.number().int().nonnegative(), c: z.string(), t: z.string() }), metadata,
}).passthrough()).optional();

export function checkRanges(value: unknown): RangesResponse {
  return contract(z.array(z.object({ id: z.string(), ranges: z.object({ changes, comments }).passthrough().optional() }).passthrough()), value,
    "TRACK_CHANGES", "[{ id: docId, ranges?: { changes?: [{id,op:{p,i|d},metadata?}], comments?: [{id,op:{p,c,t}}] } }]") as RangesResponse;
}

export function checkThreads(value: unknown): ThreadsByIdResponse {
  return contract(z.record(z.string(), z.object({
    messages: z.array(z.object({ content: z.string(), timestamp: z.number(), id: z.string().optional() }).passthrough()),
    resolved: z.boolean().optional(),
  }).passthrough()), value, "COMMENTS", "{ [threadId]: { messages: [{content:string,timestamp:number}], resolved?:boolean } }") as ThreadsByIdResponse;
}

const COMPILE_STATUSES = ["success", "failure", "error", "timedout", "stopped-on-first-error", "validation-fail", "exception"] as const;
export function checkCompileResponse(value: unknown): CompileResponse {
  return contract(z.object({
    status: z.enum(COMPILE_STATUSES),
    outputFiles: z.array(z.object({ path: z.string().min(1), url: z.string().min(1) }).passthrough()).optional(),
    clsiServerId: z.string().optional(), compileGroup: z.string().optional(),
  }).passthrough().refine((result) => result.status !== "success" || result.outputFiles !== undefined, { path: ["outputFiles"] }), value,
    "COMPILE_API", `compile { status: ${COMPILE_STATUSES.join("|")}, outputFiles: [{path,url}] required on success, clsiServerId?, compileGroup? }`) as CompileResponse;
}
