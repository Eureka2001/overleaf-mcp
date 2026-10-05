import { z } from "zod";
import { olGet, type HttpContext } from "./http.js";
import { getIdentity } from "../session/identity.js";
import { withAuthRetry } from "../session/recovery.js";
import { HistoryDiffSchema, HistoryLabelSchema, HistoryTreeSchema, HistoryUpdatesSchema, parseHistory } from "./historyTypes.js";

export class HistoryError extends Error {
  constructor(readonly code: string, message: string, readonly status?: number) {
    super(message);
    this.name = "HistoryError";
  }
}

export interface HistoryClientOptions {
  // Explicit identities are useful for read-only probes and simulated services:
  // they never launch login, evict credentials or affect an active socket.
  context?: HttpContext;
  timeoutMs?: number;
  maxJsonBytes?: number;
}

export async function readHistoryBody(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (declared > maxBytes) {
    await res.body?.cancel();
    throw new HistoryError("RESPONSE_TOO_LARGE", "History response exceeds the network size limit. Narrow the request.");
  }
  if (!res.body) throw new HistoryError("PROTOCOL_ERROR", "History response has no body.");
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new HistoryError("RESPONSE_TOO_LARGE", "History response exceeds the network size limit. Narrow the request.");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new HistoryError("PROTOCOL_ERROR", "History response is not valid UTF-8."); }
}

export class HistoryClient {
  constructor(readonly projectId: string, private readonly options: HistoryClientOptions = {}) {
    if (!/^[\w-]+$/.test(projectId)) throw new HistoryError("INVALID_PROJECT", "Invalid project id.");
  }

  private async get<T>(endpoint: string, schema: z.ZodType<T>, params: Record<string, string> = {}): Promise<T> {
    const query = new URLSearchParams(params).toString();
    const request = async () => {
      const identity = this.options.context?.identity ?? await getIdentity();
      const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 20_000);
      const signal = this.options.context?.signal ? AbortSignal.any([timeout, this.options.context.signal]) : timeout;
      const path = `project/${this.projectId}/${endpoint}${query ? `?${query}` : ""}`;
      try {
        const response = await olGet(path, {}, { identity, signal, forbiddenIsPermission: true });
        if (!response.ok) {
          if (response.status === 400) {
            const text = await readHistoryBody(response, this.options.maxJsonBytes ?? 8 * 1024 * 1024);
            if (text.includes("Diff spans too many chunks")) {
              throw new HistoryError("RANGE_TOO_LARGE", "History comparison spans too many chunks. Narrow the version range or request one file.", 400);
            }
            throw new HistoryError("INVALID_HISTORY_REQUEST", "Overleaf rejected the history version or request.", 400);
          }
          await response.body?.cancel();
          const code = response.status === 403 ? "HISTORY_FORBIDDEN" : response.status === 404 ? "HISTORY_NOT_FOUND" : response.status === 429 ? "RATE_LIMITED" : "HISTORY_HTTP_ERROR";
          throw new HistoryError(code, `History ${endpoint} returned HTTP ${response.status}. ` +
            (response.status === 403 ? "Check project permissions and history access; this does not imply an expired session." :
              response.status === 404 ? "The version/file may not exist, or this deployment may not support project history." : "Try again later."), response.status);
        }
        const raw = await readHistoryBody(response, this.options.maxJsonBytes ?? 8 * 1024 * 1024);
        let value: unknown;
        try { value = JSON.parse(raw); }
        catch { throw new HistoryError("PROTOCOL_ERROR", `History ${endpoint} returned invalid JSON.`); }
        return parseHistory(schema, value, `history.${endpoint}`);
      } catch (err) {
        if (signal.aborted) throw new HistoryError("HISTORY_TIMEOUT", "History request was cancelled or exceeded its deadline.");
        throw err;
      }
    };
    return this.options.context ? request() : withAuthRetry(request);
  }

  updates(minCount = 10, before?: number) {
    return this.get("updates", HistoryUpdatesSchema, { min_count: String(minCount), ...(before === undefined ? {} : { before: String(before) }) });
  }
  labels() { return this.get("labels", z.array(HistoryLabelSchema)); }
  tree(from: number, to: number) { return this.get("filetree/diff", HistoryTreeSchema, { from: String(from), to: String(to) }); }
  diff(from: number, to: number, path: string) { return this.get("diff", HistoryDiffSchema, { from: String(from), to: String(to), pathname: path }); }
}
