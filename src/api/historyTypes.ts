import { z } from "zod";
import { describeShape, OverleafProtocolError } from "./errors.js";

export const HistoryVersionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PathSchema = z.string().min(1).max(2048);
const UserSchema = z.object({
  id: z.string().max(256).optional(), first_name: z.string().optional(),
  last_name: z.string().optional(), email: z.string().optional(),
});
const MetaSchema = z.object({
  users: z.array(UserSchema.nullable()),
  start_ts: z.number().int().nonnegative().max(8_640_000_000_000_000), end_ts: z.number().int().nonnegative().max(8_640_000_000_000_000),
}).refine((meta) => meta.start_ts <= meta.end_ts);

export const HistoryLabelSchema = z.object({
  id: z.string().min(1).max(256), version: HistoryVersionSchema, comment: z.string(),
  created_at: z.string().optional(), user_id: z.string().optional(),
  user_display_name: z.string().optional(),
});
const ProjectOpSchema = z.object({
  atV: HistoryVersionSchema,
  add: z.object({ pathname: PathSchema }).optional(),
  remove: z.object({ pathname: PathSchema }).optional(),
  rename: z.object({ pathname: PathSchema, newPathname: PathSchema }).optional(),
}).refine((op) => [op.add, op.remove, op.rename].filter(Boolean).length === 1);
export const HistoryUpdateSchema = z.object({
  fromV: HistoryVersionSchema, toV: HistoryVersionSchema,
  meta: MetaSchema, labels: z.array(HistoryLabelSchema),
  pathnames: z.array(PathSchema), project_ops: z.array(ProjectOpSchema),
}).refine((update) => update.fromV < update.toV);
export const HistoryUpdatesSchema = z.object({
  updates: z.array(HistoryUpdateSchema),
  // Despite the wire name, this is a project-version boundary, not a date.
  nextBeforeTimestamp: HistoryVersionSchema.nullish(),
});

export const HistoryFileSchema = z.object({
  pathname: PathSchema,
  operation: z.enum(["added", "edited", "renamed", "removed"]).optional(),
  editable: z.boolean().nullable().optional(),
  newPathname: PathSchema.optional(), oldPathname: PathSchema.optional(),
  deletedAtV: HistoryVersionSchema.optional(),
}).refine((file) => file.operation !== "renamed" || Boolean(file.newPathname));
export const HistoryTreeSchema = z.object({ diff: z.array(HistoryFileSchema) });
export const HistoryChunkSchema = z.object({
  u: z.string().optional(), i: z.string().optional(), d: z.string().optional(),
  meta: MetaSchema.optional(),
}).refine((chunk) => [chunk.u, chunk.i, chunk.d].filter((text) => text !== undefined).length === 1);
export const HistoryDiffSchema = z.object({
  diff: z.union([z.array(HistoryChunkSchema), z.object({ binary: z.literal(true) })]),
});

export type HistoryUpdate = z.infer<typeof HistoryUpdateSchema>;
export type HistoryLabel = z.infer<typeof HistoryLabelSchema>;
export type HistoryFile = z.infer<typeof HistoryFileSchema>;
export type HistoryChunk = z.infer<typeof HistoryChunkSchema>;
export type HistoryMeta = z.infer<typeof MetaSchema>;
export type HistoryUser = z.infer<typeof UserSchema>;

export function parseHistory<T>(schema: z.ZodType<T>, value: unknown, stage: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new OverleafProtocolError(stage, "schema", "valid Overleaf history response", describeShape(value));
  return result.data;
}
