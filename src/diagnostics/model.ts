import { OverleafApiError, OverleafAuthError, OverleafProtocolError } from "../api/errors.js";
import { getClientMetadata, type DiagnosticClient } from "./client.js";

const CLIENT = getClientMetadata();

export type DiagnosticStatus = "pass" | "fail" | "warn" | "skip" | "partial";
export type DiagnosticCategory = "LOCAL_ENV" | "AUTHENTICATION" | "NETWORK" | "HTTP_ENDPOINT" | "HTTP_SCHEMA" |
  "SOCKET_HANDSHAKE" | "SOCKET_TRANSPORT" | "SOCKET_PROTOCOL" | "SOCKET_EVENT" | "OT_PROTOCOL" |
  "VERSION_CONFLICT" | "TRACK_CHANGES" | "COMMENTS" | "COMPILE_API" | "UPLOAD_API" | "UNKNOWN";

export interface DiagnosticResult {
  id: string;
  area: string;
  status: DiagnosticStatus;
  summary: string;
  category?: DiagnosticCategory;
  kind?: string;
  expected?: string;
  observed?: string;
  details?: string[];
  relevantFiles?: string[];
  recommendation?: string[];
  durationMs?: number;
}

export interface DiagnosticReport {
  schemaVersion: 1;
  mode: "safe";
  generatedAt: string;
  client: DiagnosticClient;
  overall: "passed" | "warning" | "partial" | "failed";
  counts: Record<DiagnosticStatus, number>;
  results: DiagnosticResult[];
}

export function aggregateResults(results: DiagnosticResult[]): DiagnosticReport {
  const counts = { pass: 0, fail: 0, warn: 0, skip: 0, partial: 0 };
  for (const result of results) counts[result.status]++;
  return {
    schemaVersion: 1, mode: "safe", generatedAt: new Date().toISOString(), client: { ...CLIENT },
    overall: counts.fail ? "failed" : counts.warn ? "warning" : counts.skip || counts.partial || !results.length ? "partial" : "passed",
    counts, results,
  };
}

export class DiagnosticError extends Error {
  constructor(readonly category: DiagnosticCategory, readonly expected: string, readonly observed: string, readonly kind = "schema") {
    super(observed);
    this.name = "DiagnosticError";
  }
}

export function failureResult(spec: Pick<DiagnosticResult, "id" | "area" | "category" | "expected" | "relevantFiles" | "recommendation">, error: unknown, context: { sessionValidated?: boolean } = {}): DiagnosticResult {
  let category = spec.category ?? "UNKNOWN";
  let kind = "error";
  let expected = spec.expected;
  let observed = error instanceof Error ? error.message : String(error);
  // The runtime wraps HTTP 401/403 alike. Only a bare downstream HTTP 403
  // changes meaning after auth.session PASS; login/invalid-session evidence and
  // HTTP 401 still indicate authentication failures.
  const downstream403 = context.sessionValidated === true && (
    error instanceof OverleafAuthError && /^(?:HTTP 403 on\b|Socket\.IO handshake rejected session: HTTP 403$)/.test(error.message) ||
    error instanceof OverleafApiError && error.status === 403
  );
  if (error instanceof OverleafAuthError) {
    if (!downstream403) category = "AUTHENTICATION";
    kind = "rejection";
  }
  else if (error instanceof DiagnosticError) { ({ category, kind, expected, observed } = error); }
  else if (error instanceof OverleafProtocolError) {
    ({ kind, expected, observed } = error);
    if (kind === "transport" && error.stage.startsWith("socket.")) category = "SOCKET_TRANSPORT";
    else if (error.stage === "socket.handshake") category = "SOCKET_HANDSHAKE";
    else if (error.stage === "socket.transport") category = "SOCKET_TRANSPORT";
    else if (error.stage.startsWith("socket.") || ["joinProject", "joinDoc"].includes(error.stage)) category = kind === "timeout" || kind === "rejection" ? "SOCKET_EVENT" : "SOCKET_PROTOCOL";
    else if (error.stage === "http.projects") category = "HTTP_SCHEMA";
    if (kind === "rejection" && /version|stale/i.test(observed)) category = "VERSION_CONFLICT";
  } else if (error instanceof OverleafApiError) {
    kind = "http";
    observed = `HTTP ${error.status}: ${error.body}`;
    if ((error.status === 401 || error.status === 403) && !downstream403) category = "AUTHENTICATION";
    if (category === "HTTP_SCHEMA") category = "HTTP_ENDPOINT";
  } else if (error instanceof SyntaxError) { kind = "schema"; observed = "response is not valid JSON"; }
  else if (error instanceof TypeError && /fetch|network/i.test(error.message)) {
    category = "NETWORK"; kind = "transport";
    const cause = error.cause as { code?: string; message?: string } | undefined;
    observed += cause?.code ? ` (${cause.code})` : "";
  }
  if (downstream403) {
    if (category === "HTTP_SCHEMA" || category === "AUTHENTICATION") category = "HTTP_ENDPOINT";
    observed = `403 after authenticated session: ${observed}`;
  }
  const recommendation = downstream403
    ? ["403 after authenticated session: check CSRF semantics, project permissions, endpoint policy, or protocol drift; compare this endpoint in the Web Editor.", ...(spec.recommendation ?? [])]
    : category === "AUTHENTICATION"
    ? ["Run node dist/index.js login and retry; 403 can also mean CSRF/permissions, inspect the browser response before assuming schema drift.", "Inspect src/auth/browserLogin.ts and src/session/identity.ts; diagnostics never refreshes or deletes credentials."]
    : category === "NETWORK"
      ? ["Check connectivity, proxy/TLS and OL_BASE_URL; compare the same request in the Web Editor before changing protocol code."]
      : spec.recommendation;
  return { ...spec, status: "fail", summary: `${spec.id}: ${kind} failure`, category, kind, expected, observed, recommendation };
}

// The race bounds even a broken adapter that ignores AbortSignal. Real fetch
// and socket callers also cancel their work, rather than leaving it running.
export async function withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, category: DiagnosticCategory): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new DiagnosticError(category, "completion before deadline", `timeout after ${timeoutMs}ms`, "timeout");
          reject(error);
          controller.abort(error);
        }, timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
