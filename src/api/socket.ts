// Minimal Socket.IO 0.9 client tailored for Overleaf.
//
// Overleaf's bundled `socket.io-client@0.9.17-overleaf-N` fork accepts an
// `extraHeaders` option but never forwards it to either transport — XMLHttpRequest
// forbids the `Cookie` header and the WebSocket transport calls
// `new WebSocket(url)` with no header argument. That makes the fork unusable
// against overleaf.com from a server-side caller. We instead speak the wire
// protocol ourselves: handshake via `fetch` (cookies propagate naturally),
// upgrade via `ws@8` (which supports a `headers` option).
//
// Protocol reference: https://github.com/learnboost/socket.io-spec (v0.9.x)
// Frame format: `<type>:<id>:<endpoint>:<data>`
//   0 disconnect | 1 connect | 2 heartbeat | 3 message | 4 json
//   5 event { name, args } | 6 ack `:::<id>+<json>` | 7 error
//
// We only implement the subset Overleaf actually emits.

import WebSocket from "ws";

import { describeShape, OverleafApiError, OverleafAuthError, OverleafProtocolError } from "./errors.js";
import { getIdentity, type Identity } from "../session/identity.js";
import { withAuthRetry } from "../session/recovery.js";
import type { ProjectEntity } from "./projectTypes.js";
import { logger } from "../util/logger.js";

export interface OtUpdate {
  doc: string;
  op?: Array<{ p: number; i?: string; d?: string; u?: boolean }>;
  v: number;
  lastV?: number;
  hash?: string;
  // Only `tc` may be client-supplied. The real-time service sets
  // `meta.source` / `meta.user_id` / `meta.tsRT` itself and its zod schema
  // rejects the update outright if we send them ("Unrecognized keys").
  meta?: { tc: string };
}

export interface JoinDocResult {
  docLines: string[];
  version: number;
  updates: unknown[];
  ranges: unknown;
}

type EventListener = (args: unknown[]) => void;

interface PendingAck {
  event: string;
  resolve: (data: unknown[]) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

function decodePackedUtf8(line: string): string {
  return Buffer.from(line, "latin1").toString("utf8");
}

function mergeSetCookies(existing: string, responseHeaders: Headers): string {
  // Use undici's getSetCookie when available (Node 22+); fall back to parsing
  // the raw header for Node 20.
  const headersAny = responseHeaders as Headers & { getSetCookie?: () => string[] };
  const raw: string[] = headersAny.getSetCookie?.() ?? [];
  if (!raw.length) {
    const single = responseHeaders.get("set-cookie");
    if (single) raw.push(single);
  }
  const existingNames = new Set(existing.split(";").map((p) => p.split("=")[0].trim().toLowerCase()));
  const adds: string[] = [];
  for (const sc of raw) {
    const first = sc.split(";")[0].trim();
    const name = first.split("=")[0].trim().toLowerCase();
    if (!name || existingNames.has(name)) continue;
    adds.push(first);
    existingNames.add(name);
  }
  if (!adds.length) return existing;
  return `${existing}; ${adds.join("; ")}`;
}

export class OverleafSocket {
  private ws: WebSocket | null = null;
  private nextAckId = 1;
  private pending = new Map<number, PendingAck>();
  private listeners = new Map<string, EventListener[]>();
  private heartbeatInterval: number = 60_000;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private connectionFailure: ((error: Error) => void) | null = null;
  private readonly log: typeof logger;
  joinedProject: ProjectEntity | null = null;
  publicId: string | null = null;
  permissionsLevel: string | null = null;
  protocolVersion: number | null = null;

  constructor(public readonly projectId: string, public readonly identity: Identity, quiet = false) {
    this.log = quiet ? { debug() {}, info() {}, warn() {}, error() {} } : logger;
  }

  async connect(timeoutMs = 15_000, options: {
    signal?: AbortSignal;
    onStage?: (stage: "handshake" | "transport") => void;
  } = {}): Promise<void> {
    let stage = "socket.handshake";
    const controller = new AbortController();
    const timedOut = () => new OverleafProtocolError(stage, "timeout", "completion before deadline", "timeout after " + timeoutMs + "ms");
    const deadline = setTimeout(() => controller.abort(timedOut()), timeoutMs);
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    let fallback: NodeJS.Timeout | undefined;
    let joined: EventListener | undefined;
    let cancelled: (() => void) | undefined;
    try {
      const base = this.identity.baseUrl;
      const hsRes = await fetch(base + "/socket.io/1/?projectId=" + encodeURIComponent(this.projectId) + "&t=" + Date.now(), {
        method: "GET", redirect: "manual", signal: controller.signal,
        headers: { Cookie: this.identity.cookie, Origin: new URL(base).origin, Connection: "keep-alive" },
      });
      const location = hsRes.headers.get("location") ?? "";
      if (hsRes.status === 401 || hsRes.status === 403 || (hsRes.status >= 300 && hsRes.status < 400 && /\/login(\?|$|\/)/i.test(location))) {
        throw new OverleafAuthError("Socket.IO handshake rejected session: HTTP " + hsRes.status);
      }
      if (hsRes.status !== 200) throw new OverleafApiError(hsRes.status, await hsRes.text(), "Socket.IO handshake");
      const hsBody = await hsRes.text();
      const [sid, heartbeat, closeTimeout, transports, ...extra] = hsBody.trim().split(":");
      if (!sid || !/^[\w-]+$/.test(sid) || !/^\d+$/.test(heartbeat ?? "") || !/^\d+$/.test(closeTimeout ?? "") || !transports?.split(",").includes("websocket") || extra.length) {
        throw new OverleafProtocolError(stage, "protocol", "sid:heartbeat:closeTimeout:transports including websocket (Socket.IO 0.9)", "unrecognized handshake envelope (" + hsBody.length + " characters)");
      }
      this.heartbeatInterval = Math.max(15_000, (Number(heartbeat) || 60) * 1000 - 5_000);
      options.onStage?.("handshake");
      stage = "socket.transport";
      // SaaS requires the handshake's GCLB cookie to pin the upgrade backend.
      const upgradeCookie = mergeSetCookies(this.identity.cookie, hsRes.headers);
      const ws = new WebSocket(base.replace(/^http/, "ws") + "/socket.io/1/websocket/" + sid, {
        headers: { Cookie: upgradeCookie, Origin: new URL(base).origin }, handshakeTimeout: timeoutMs,
      });
      this.ws = ws;
      await new Promise<void>((resolve, reject) => {
        this.connectionFailure = reject;
        cancelled = () => reject(controller.signal.reason ?? timedOut());
        controller.signal.addEventListener("abort", cancelled, { once: true });
        if (controller.signal.aborted) { cancelled(); return; }
        const accept = (project: unknown, permission?: unknown, protocol?: unknown) => {
          try {
            this.joinedProject = parseJoinedProject(project, this.projectId);
            if (permission != null && typeof permission !== "string") throw new OverleafProtocolError("socket.joinProject", "schema", "permissionsLevel: string", describeShape(permission));
            if (protocol != null && !Number.isSafeInteger(protocol)) throw new OverleafProtocolError("socket.joinProject", "schema", "protocolVersion: integer", describeShape(protocol));
            this.permissionsLevel = typeof permission === "string" ? permission : null;
            this.protocolVersion = typeof protocol === "number" ? protocol : null;
            resolve();
          } catch (error) { reject(error); }
        };
        joined = (args) => {
          const payload = args[0];
          if (!payload || typeof payload !== "object" || Array.isArray(payload) || !("project" in payload)) {
            reject(new OverleafProtocolError("socket.joinProject", "schema", "joinProjectResponse({ project, permissionsLevel?, protocolVersion? })", describeShape(payload)));
            return;
          }
          const p = payload as Record<string, unknown>;
          this.publicId = typeof p.publicId === "string" ? p.publicId : null;
          accept(p.project, p.permissionsLevel, p.protocolVersion);
        };
        this.once("joinProjectResponse", joined);
        ws.once("open", () => {
          this.log.info("socket.io transport connected");
          this.startHeartbeats();
          options.onStage?.("transport");
          stage = "socket.joinProject";
          fallback = setTimeout(() => {
            if (this.closed || this.joinedProject || controller.signal.aborted) return;
            // The connection deadline owns cancellation, including this ACK.
            this.emit("joinProject", [{ project_id: this.projectId }], timeoutMs)
              .then((ret) => {
                const tuple = Array.isArray(ret) ? ret : [ret];
                accept(tuple[0], tuple[1], tuple[2]);
              }).catch(reject);
          }, Math.min(3_000, timeoutMs / 2));
        });
        ws.on("error", (error) => {
          const failure = new OverleafProtocolError(stage, "transport", "open WebSocket transport", error.message);
          reject(failure);
          this.rejectPending(failure);
        });
        ws.on("message", (data) => this.handleFrame(data.toString("utf8")));
        ws.once("close", (code, reason) => {
          this.stopHeartbeats();
          this.closed = true;
          const failure = new OverleafProtocolError(stage, "transport", "open socket", "socket closed (" + code + ") " + reason.toString());
          reject(failure);
          this.rejectPending(failure);
        });
      });
    } catch (error) {
      this.disconnect();
      if (controller.signal.aborted) throw controller.signal.reason ?? timedOut();
      throw error;
    } finally {
      clearTimeout(deadline);
      clearTimeout(fallback);
      if (joined) this.off("joinProjectResponse", joined);
      if (cancelled) controller.signal.removeEventListener("abort", cancelled);
      options.signal?.removeEventListener("abort", abort);
      this.connectionFailure = null;
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private protocolFailure(error: Error): void {
    this.connectionFailure?.(error);
    this.rejectPending(error);
    this.disconnect();
  }

  private startHeartbeats(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try { this.ws.send("2::"); } catch { /* ignore */ }
      }
    }, this.heartbeatInterval);
  }
  private stopHeartbeats(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private handleFrame(frame: string): void {
    if (!frame) return;
    // Parse `<type>:<id>:<endpoint>:<data>`. Data may contain colons, so split
    // only on the first three.
    const m = frame.match(/^(\d+):([^:]*):([^:]*):?([\s\S]*)$/);
    if (!m) {
      this.protocolFailure(new OverleafProtocolError("socket.frame", "protocol", "Socket.IO 0.9 type:id:endpoint:data", "unparseable frame (" + frame.length + " characters)"));
      return;
    }
    const type = m[1];
    const id = m[2];
    const data = m[4];
    switch (type) {
      case "0": // disconnect
        this.log.warn("server sent disconnect frame");
        try { this.ws?.close(); } catch { /* ignore */ }
        return;
      case "1": // connect ack — usually with empty endpoint
        return;
      case "2": // heartbeat from server, echo back
        try { this.ws?.send("2::"); } catch { /* ignore */ }
        return;
      case "5": {
        // Event: `5:<id>[+]::{"name":"event","args":[...]}`
        let obj: { name?: string; args?: unknown[] } = {};
        try { obj = JSON.parse(data); } catch {
          this.protocolFailure(new OverleafProtocolError("socket.frame", "protocol", "event JSON { name, args }", "invalid JSON"));
          return;
        }
        if (!obj || typeof obj.name !== "string" || (obj.args !== undefined && !Array.isArray(obj.args))) {
          this.protocolFailure(new OverleafProtocolError("socket.frame", "schema", "event JSON { name: string, args: array }", describeShape(obj)));
          return;
        }
        const name = obj.name;
        if (!name) return;
        const args = obj.args ?? [];
        if (name === "connectionRejected") {
          const reason = JSON.stringify(args);
          this.protocolFailure(/invalid session|not authenticated|unauthorized/i.test(reason)
            ? new OverleafAuthError("connectionRejected: " + reason)
            : new OverleafProtocolError("socket.joinProject", "rejection", "accepted connection", reason));
          return;
        }
        const ls = this.listeners.get(name);
        if (ls) for (const l of ls) try { l(args); } catch (e) { this.log.error(`listener for ${name} threw`, e); }
        // Track-changes / reciveNewDoc / etc may also acknowledge with msg id;
        // we ignore that for now since Overleaf doesn't appear to expect a
        // response from us for server-emitted events.
        return;
      }
      case "6": {
        // ACK: `6:::<id>[+<data_json>]`. Note: the "id" field above will be
        // empty for an ack frame; the ack id is at the start of `data`.
        const plus = data.indexOf("+");
        const ackIdStr = plus >= 0 ? data.slice(0, plus) : data;
        const ackDataRaw = plus >= 0 ? data.slice(plus + 1) : "";
        const ackId = Number(ackIdStr);
        const pending = this.pending.get(ackId);
        if (!pending) return;
        this.pending.delete(ackId);
        clearTimeout(pending.timer);
        let arr: unknown[] = [];
        if (ackDataRaw) {
          try { arr = JSON.parse(ackDataRaw); } catch {
            pending.reject(new OverleafProtocolError(pending.event, "protocol", "ACK [error, ...result]", "invalid ACK JSON"));
            return;
          }
          if (!Array.isArray(arr)) {
            pending.reject(new OverleafProtocolError(pending.event, "schema", "ACK [error, ...result]", describeShape(arr)));
            return;
          }
        }
        // Overleaf's ack convention: first element is the error (null on
        // success); remaining elements are the result.
        const err = arr[0];
        if (err) {
          const reason = typeof err === "string" ? err : JSON.stringify(err);
          pending.reject(/invalid session|not authorized|unauthorized/i.test(reason)
            ? new OverleafAuthError(reason)
            : new OverleafProtocolError(pending.event, "rejection", "ACK [null, ...result]", reason));
        }
        else pending.resolve(arr.slice(1));
        return;
      }
      case "7": {
        // Only explicit authentication evidence permits cookie recovery.
        // Unknown protocol errors must not erase credentials or open Chrome.
        this.log.error("server error frame", data);
        const error = /invalid session|not authorized|unauthorized/i.test(data)
          ? new OverleafAuthError(`server error frame: ${data}`)
          : new OverleafProtocolError("socket.frame", "rejection", "accepted Socket.IO session", data);
        this.protocolFailure(error);
        return;
      }
      default:
        return;
    }
  }

  on(event: string, listener: EventListener): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
  }
  once(event: string, listener: EventListener): void {
    const wrap: EventListener = (args) => {
      this.off(event, wrap);
      listener(args);
    };
    this.on(event, wrap);
  }
  off(event: string, listener: EventListener): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    const i = arr.indexOf(listener);
    if (i >= 0) arr.splice(i, 1);
  }

  async emit<T = unknown>(name: string, args: unknown[] = [], timeoutMs = 15_000): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new OverleafApiError(0, "", "socket not open");
    }
    const ackId = this.nextAckId++;
    const frame = `5:${ackId}+::${JSON.stringify({ name, args })}`;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(ackId);
        reject(new OverleafProtocolError(name, "timeout", "event ACK before deadline", `event '${name}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(ackId, {
        event: name,
        resolve: (data) => resolve((data.length <= 1 ? data[0] : data) as T),
        reject,
        timer,
      });
      try { this.ws!.send(frame); } catch (e) {
        clearTimeout(timer);
        this.pending.delete(ackId);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  isOpen(): boolean {
    return !this.closed && this.ws?.readyState === WebSocket.OPEN;
  }

  disconnect(): void {
    this.stopHeartbeats();
    this.closed = true;
    const error = new OverleafProtocolError("socket.transport", "transport", "open socket", "socket closed by client");
    this.connectionFailure?.(error);
    this.rejectPending(error);
    if (this.ws) {
      try { this.ws.terminate(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.closed = true;
  }
}

let active: OverleafSocket | null = null;

export async function ensureSocketForProject(projectId: string): Promise<{
  socket: OverleafSocket;
  publicId?: string;
  joinedProject?: ProjectEntity;
}> {
  return withAuthRetry(async () => {
    if (active && active.projectId === projectId && active.isOpen()) {
      return { socket: active, publicId: active.publicId ?? undefined, joinedProject: active.joinedProject ?? undefined };
    }
    if (active) {
      logger.info(`switching project: ${active.projectId} -> ${projectId}`);
      active.disconnect();
      active = null;
    }
    const identity = await getIdentity();
    const s = new OverleafSocket(projectId, identity);
    await s.connect();
    active = s;
    return { socket: s, publicId: s.publicId ?? undefined, joinedProject: s.joinedProject ?? undefined };
  });
}

export function getActiveSocket(): OverleafSocket | null {
  return active;
}

// SaaS sends structure in joinProjectResponse when a socket connects, but no
// longer acknowledges a repeated joinProject on that socket. A short-lived
// second connection fetches fresh structure without disturbing joined docs or
// clearing the edit baselines on the persistent connection.
export async function fetchProjectSnapshot(projectId: string): Promise<ProjectEntity> {
  return withAuthRetry(async () => {
    const snapshot = new OverleafSocket(projectId, await getIdentity());
    try {
      await snapshot.connect();
      if (!snapshot.joinedProject) throw new OverleafApiError(0, "", "joinProject did not return a project entity");
      return snapshot.joinedProject;
    } finally {
      snapshot.disconnect();
    }
  });
}

// Snapshot the active project, run an emit, and if it fails because the
// socket got torn down (auth-shaped error or "socket closed"), evict the
// cookie if needed, re-establish the socket on the same project, and retry
// the emit exactly once. Callers should pass a prep step (e.g. re-join the
// doc) if the operation requires per-doc state that the new socket lacks.
async function withReconnectingSocket<T>(
  op: () => Promise<T>,
  prep?: () => Promise<void>,
): Promise<T> {
  const projectId = active?.projectId;
  try {
    return await op();
  } catch (err) {
    if (!projectId) throw err;
    const isAuth = err instanceof OverleafAuthError;
    const isClosed = err instanceof Error && /socket closed|socket not open/i.test(err.message);
    if (!isAuth && !isClosed) throw err;
    logger.info(`socket op failed (${(err as Error).message}); reconnecting to project ${projectId}`);
    if (active) {
      try { active.disconnect(); } catch { /* ignore */ }
      active = null;
    }
    // The fresh socket won't have any docs joined, so any cached doc text +
    // version is referring to the old session — clear it so the next caller
    // (or the prep step below) re-fetches from the server.
    const { clearDocCache } = await import("../session/docCache.js");
    clearDocCache();
    if (isAuth) {
      const { evictAndRediscover } = await import("../auth/discover.js");
      const { loadConfig } = await import("../config.js");
      const { clearIdentity } = await import("../session/identity.js");
      clearIdentity();
      await evictAndRediscover(loadConfig().baseUrl);
    }
    await ensureSocketForProject(projectId);
    if (prep) await prep();
    return await op();
  }
}

export async function joinDoc(docId: string): Promise<JoinDocResult> {
  return withReconnectingSocket(async () => {
    if (!active) throw new OverleafApiError(0, "", "no active project — call open_project first");
    // The ack returns `[docLinesAscii, version, updates, ranges]`.
    const ret = await active.emit<[string[], number, unknown[], unknown] | unknown>(
      "joinDoc",
      [docId, { encodeRanges: true }],
    );
    return parseJoinDocResponse(ret);
  });
}

export function parseJoinedProject(value: unknown, projectId: string): ProjectEntity {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("_id" in value) || value._id !== projectId || !("name" in value) || typeof value.name !== "string") {
    throw new OverleafProtocolError("socket.joinProject", "schema", "project { _id: requested projectId, name: string, rootFolder: Folder[] }", describeShape(value));
  }
  return value as ProjectEntity;
}

export function parseJoinDocResponse(value: unknown): JoinDocResult {
  const expected = "joinDoc ACK [null, string[] packed UTF-8 lines, nonnegative integer version, updates?, ranges?]";
  if (!Array.isArray(value) || !Array.isArray(value[0]) || !value[0].every((line: unknown) => typeof line === "string") || !Number.isSafeInteger(value[1]) || value[1] < 0 || (value[2] != null && !Array.isArray(value[2]))) {
    throw new OverleafProtocolError("socket.joinDoc", "schema", expected, describeShape(value));
  }
  return { docLines: value[0].map(decodePackedUtf8), version: value[1], updates: value[2] ?? [], ranges: value[3] };
}

export async function leaveDoc(docId: string): Promise<void> {
  // Best-effort; if the socket is gone, the doc is already implicitly left.
  if (!active) return;
  await active.emit("leaveDoc", [docId]).catch(() => undefined);
}

export async function applyOtUpdate(docId: string, update: OtUpdate): Promise<void> {
  await withReconnectingSocket(
    async () => {
      if (!active) throw new OverleafApiError(0, "", "no active project — call open_project first");
      await active.emit("applyOtUpdate", [docId, update]);
    },
    // After a reconnect, the fresh socket has no docs joined. Re-join so the
    // retried applyOtUpdate hits a socket that knows about this doc. Note:
    // joinDoc returns the current version, but our `update.v` was computed
    // against the pre-reconnect version. The server's OT layer either accepts
    // (if the version matches) or rejects with a version-conflict, which we
    // propagate to the caller — same as if the original emit had failed.
    async () => { await joinDoc(docId); },
  );
}

export function disconnectActive(): void {
  if (active) {
    active.disconnect();
    active = null;
  }
}
