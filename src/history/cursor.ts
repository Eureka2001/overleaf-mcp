import { z } from "zod";
import { HistoryVersionSchema } from "../api/historyTypes.js";
import { HistoryError } from "../api/history.js";

const base = { project_id: z.string().min(1) };
export const CursorSchema = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("updates"), before: HistoryVersionSchema }),
  z.object({ ...base, kind: z.literal("labels"), after_version: HistoryVersionSchema, after_id: z.string().min(1) }),
  z.object({ ...base, kind: z.literal("files"), version: HistoryVersionSchema, offset: z.number().int().nonnegative() }),
  z.object({ ...base, kind: z.literal("compare"), from: HistoryVersionSchema, to: HistoryVersionSchema, offset: z.number().int().nonnegative() }),
  z.object({ ...base, kind: z.literal("diff"), from: HistoryVersionSchema, to: HistoryVersionSchema, path: z.string().min(1),
    hunk: z.number().int().nonnegative(), line: z.number().int().nonnegative(), column: z.number().int().nonnegative(), context_lines: z.number().int().min(0).max(10) }),
]);
export type HistoryCursor = z.infer<typeof CursorSchema>;

export function encodeCursor(cursor: HistoryCursor): string {
  return "h1." + Buffer.from(JSON.stringify(cursor)).toString("base64url");
}
export function decodeCursor(value: string | undefined, projectId: string, kind: HistoryCursor["kind"]): HistoryCursor | undefined {
  if (value === undefined) return undefined;
  try {
    if (!/^h1\.[\w-]+$/.test(value) || value.length > 4096) throw new Error();
    const cursor = CursorSchema.parse(JSON.parse(Buffer.from(value.slice(3), "base64url").toString("utf8")));
    if (cursor.project_id !== projectId || cursor.kind !== kind) throw new Error();
    return cursor;
  } catch { throw new HistoryError("INVALID_CURSOR", "Cursor is invalid or belongs to another project/tool/mode."); }
}

export function fitPage<T>(items: T[], limit: number, offset = 0, maxChars = 20_000): T[] {
  if (offset > items.length) throw new HistoryError("INVALID_CURSOR", "Cursor is outside this result set.");
  const page: T[] = [];
  let size = 2;
  for (const item of items.slice(offset, offset + limit)) {
    const cost = JSON.stringify(item).length + 1;
    if (size + cost > maxChars) break;
    page.push(item);
    size += cost;
  }
  if (!page.length && offset < items.length) throw new HistoryError("RESPONSE_TOO_LARGE", "One history metadata entry exceeds the output limit.");
  return page;
}
