import DiffMatchPatch from "diff-match-patch";
import type { HistoryChunk, HistoryMeta } from "../api/historyTypes.js";
import { HistoryError } from "../api/history.js";
import { authors, reconstructDiff } from "./session.js";

export function snapshotDiff(before: string, after: string): HistoryChunk[] {
  const dmp = new DiffMatchPatch.diff_match_patch();
  dmp.Diff_Timeout = 1;
  const diffs = dmp.diff_main(before, after);
  dmp.diff_cleanupSemantic(diffs);
  return diffs.map(([kind, text]) => kind === -1 ? { d: text } : kind === 1 ? { i: text } : { u: text });
}

export function safePrefix(text: string, count: number): string {
  let end = Math.min(count, text.length);
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return text.slice(0, end);
}

interface DiffLine {
  kind: "context" | "insert" | "delete";
  text: string;
  old_line: number | null;
  new_line: number | null;
  old_offset: number;
  new_offset: number;
  old_anchor: number;
  new_anchor: number;
}
interface MetaSpan { side: "old" | "new"; start: number; end: number; meta: HistoryMeta }
interface Hunk { lines: DiffLine[]; old_start: number; new_start: number; old_lines: number; new_lines: number; metas: HistoryMeta[] }
export interface DiffPosition { hunk: number; line: number; column: number }

function lineDiff(before: string, after: string): DiffLine[] {
  const dmp = new DiffMatchPatch.diff_match_patch();
  dmp.Diff_Timeout = 1;
  const encoded = dmp.diff_linesToChars_(before, after);
  const diffs = dmp.diff_main(encoded.chars1, encoded.chars2, false);
  dmp.diff_charsToLines_(diffs, encoded.lineArray);
  let oldLine = 1, newLine = 1, oldOffset = 0, newOffset = 0;
  const lines: DiffLine[] = [];
  for (const [op, text] of diffs) {
    for (const part of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      lines.push({ kind: op === 0 ? "context" : op === -1 ? "delete" : "insert", text: part,
        old_line: op === 1 ? null : oldLine, new_line: op === -1 ? null : newLine, old_offset: oldOffset, new_offset: newOffset,
        old_anchor: oldLine, new_anchor: newLine });
      if (op !== 1) { oldLine++; oldOffset += part.length; }
      if (op !== -1) { newLine++; newOffset += part.length; }
    }
  }
  return lines;
}

function metadata(chunks: HistoryChunk[]): MetaSpan[] {
  const spans: MetaSpan[] = [];
  let oldOffset = 0, newOffset = 0;
  for (const chunk of chunks) {
    if (chunk.d !== undefined) {
      if (chunk.meta) spans.push({ side: "old", start: oldOffset, end: oldOffset + chunk.d.length, meta: chunk.meta });
      oldOffset += chunk.d.length;
    } else if (chunk.i !== undefined) {
      if (chunk.meta) spans.push({ side: "new", start: newOffset, end: newOffset + chunk.i.length, meta: chunk.meta });
      newOffset += chunk.i.length;
    } else { oldOffset += chunk.u!.length; newOffset += chunk.u!.length; }
  }
  return spans;
}

function buildHunks(lines: DiffLine[], context: number, spans: MetaSpan[]): Hunk[] {
  const ranges: [number, number][] = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].kind === "context") continue;
    let start = index, end = index;
    for (let count = 0; start > 0 && count < context; count++) {
      if (lines[start - 1].kind !== "context") break;
      start--;
    }
    for (let count = 0; end + 1 < lines.length && count < context; count++) {
      if (lines[end + 1].kind !== "context") break;
      end++;
    }
    const previous = ranges.at(-1);
    if (previous && start <= previous[1] + 1) previous[1] = Math.max(previous[1], end);
    else ranges.push([start, end]);
  }
  const oldSpans = spans.filter((span) => span.side === "old");
  const newSpans = spans.filter((span) => span.side === "new");
  let oldIndex = 0, newIndex = 0;
  return ranges.map(([start, end]) => {
    const selected = lines.slice(start, end + 1);
    const metas = new Set<HistoryMeta>();
    for (const line of selected) {
      if (line.kind === "context") continue;
      const isOld = line.kind === "delete";
      const source = isOld ? oldSpans : newSpans;
      const offset = isOld ? line.old_offset : line.new_offset;
      let index = isOld ? oldIndex : newIndex;
      while (index < source.length && source[index].end <= offset) index++;
      if (isOld) oldIndex = index; else newIndex = index;
      for (let i = index; i < source.length && source[i].start < offset + line.text.length; i++) metas.add(source[i].meta);
    }
    return { lines: selected, old_start: lines[start].old_anchor,
      new_start: lines[start].new_anchor,
      old_lines: selected.filter((line) => line.kind !== "insert").length,
      new_lines: selected.filter((line) => line.kind !== "delete").length, metas: [...metas] };
  });
}

export function formatHistoryDiff(chunks: HistoryChunk[], contextLines: number, maxChars: number, position: DiffPosition = { hunk: 0, line: 0, column: 0 }) {
  const { before, after } = reconstructDiff(chunks);
  const fullHunks = buildHunks(lineDiff(before, after), contextLines, metadata(chunks));
  if (position.hunk > fullHunks.length || (position.hunk === fullHunks.length && (position.line || position.column))) {
    throw new HistoryError("INVALID_CURSOR", "Diff cursor is outside this comparison.");
  }
  const hunks: { old_start: number; new_start: number; old_lines: number; new_lines: number; partial: boolean;
    authors: ReturnType<typeof authors>; start_time?: string; end_time?: string;
    lines: { kind: DiffLine["kind"]; text: string; old_line: number | null; new_line: number | null; start_column: number; truncated: boolean }[] }[] = [];
  let remaining = maxChars;
  let next: DiffPosition | undefined;
  outer: for (let hi = position.hunk; hi < fullHunks.length; hi++) {
    const hunk = fullHunks[hi];
    const startLine = hi === position.hunk ? position.line : 0;
    const startColumn = hi === position.hunk ? position.column : 0;
    if (startLine >= hunk.lines.length || startColumn >= hunk.lines[startLine].text.length) throw new HistoryError("INVALID_CURSOR", "Diff cursor is outside this hunk.");
    const contributorMap = new Map<string, ReturnType<typeof authors>[number]>();
    for (const meta of hunk.metas) for (const author of authors(meta.users)) contributorMap.set(JSON.stringify(author), author);
    const shown: typeof hunks[number] = { old_start: hunk.old_start, new_start: hunk.new_start, old_lines: hunk.old_lines, new_lines: hunk.new_lines,
      partial: startLine > 0 || startColumn > 0, authors: [...contributorMap.values()].slice(0, 10), lines: [],
      ...(hunk.metas.length ? { start_time: new Date(hunk.metas.reduce((min, meta) => Math.min(min, meta.start_ts), Infinity)).toISOString(),
        end_time: new Date(hunk.metas.reduce((max, meta) => Math.max(max, meta.end_ts), 0)).toISOString() } : {}) };
    const overhead = JSON.stringify({ ...shown, lines: undefined }).length + 80;
    if (remaining < overhead + 180) { next = { hunk: hi, line: startLine, column: startColumn }; break; }
    remaining -= overhead;
    for (let li = startLine; li < hunk.lines.length; li++) {
      const line = hunk.lines[li];
      const column = li === startLine ? startColumn : 0;
      const source = line.text.slice(column);
      // Include JSON escaping and per-line fields in the budget, not just text.
      let text = safePrefix(source, Math.max(0, remaining - 140));
      const makeLine = () => ({ kind: line.kind, text, old_line: line.old_line, new_line: line.new_line,
        start_column: column + 1, truncated: column > 0 || text.length < source.length });
      while (text && JSON.stringify(makeLine()).length + 2 > remaining) text = safePrefix(text, Math.floor(text.length * 0.8));
      if (!text) {
        next = { hunk: hi, line: li, column };
        shown.partial = true;
        if (shown.lines.length) hunks.push(shown);
        break outer;
      }
      const entry = makeLine();
      shown.lines.push(entry);
      remaining -= JSON.stringify(entry).length + 2;
      if (text.length < source.length) {
        shown.partial = true;
        next = { hunk: hi, line: li, column: column + text.length };
        hunks.push(shown);
        break outer;
      }
    }
    hunks.push(shown);
  }
  return { hunks, total_hunks: fullHunks.length, returned_hunks: hunks.length, truncated: next !== undefined, next,
    inserted_chars: chunks.reduce((count, chunk) => count + (chunk.i?.length ?? 0), 0),
    deleted_chars: chunks.reduce((count, chunk) => count + (chunk.d?.length ?? 0), 0),
    content_changed: before !== after };
}

export function renderHistoryDiff(hunks: ReturnType<typeof formatHistoryDiff>["hunks"]): string {
  return hunks.map((hunk) => `@@ -${hunk.old_start},${hunk.old_lines} +${hunk.new_start},${hunk.new_lines} @@${hunk.partial ? " (partial)" : ""}\n` +
    hunk.lines.map((line) => (line.kind === "insert" ? "+" : line.kind === "delete" ? "-" : " ") +
      (line.start_column > 1 ? "…" : "") + line.text.replace(/\n$/, "") + (line.truncated ? "…" : "")).join("\n")).join("\n\n");
}

export function sliceHistoryText(text: string, startLine: number, endLine: number | undefined, startColumn: number, maxChars: number) {
  const lines = text.split("\n");
  if (startLine > lines.length || (endLine !== undefined && endLine < startLine) || startColumn > lines[startLine - 1].length + 1) {
    throw new HistoryError("INVALID_LINE_RANGE", "Use a valid one-based line/column range within this historical text.");
  }
  let offset = 0;
  for (let i = 0; i < startLine - 1; i++) offset += lines[i].length + 1;
  offset += startColumn - 1;
  let endOffset = text.length;
  if (endLine !== undefined && endLine < lines.length) {
    endOffset = 0;
    for (let i = 0; i < endLine; i++) endOffset += lines[i].length + 1;
  }
  const shown = safePrefix(text.slice(offset, endOffset), maxChars);
  const consumed = offset + shown.length;
  let nextLine = startLine, nextColumn = startColumn;
  for (const char of shown) {
    if (char === "\n") { nextLine++; nextColumn = 1; }
    else nextColumn += char.length;
  }
  return { text: shown, line_count: lines.length, byte_count: Buffer.byteLength(text, "utf8"),
    start_line: startLine, start_column: startColumn, end_line: nextLine,
    truncated: consumed < endOffset, more_after_range: endOffset < text.length,
    ...(consumed < endOffset ? { next_start_line: nextLine, next_start_column: nextColumn } : {}) };
}
