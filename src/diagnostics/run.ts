import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname } from "node:path";
import { cookieFilePath, loadStored, type StoredCookie } from "../auth/cookieStore.js";
import { loadConfig, type Config } from "../config.js";
import { asJson, expectOk, olGet, olOptions, type HttpContext } from "../api/http.js";
import { OverleafAuthError } from "../api/errors.js";
import { OverleafSocket, parseJoinDocResponse, type JoinDocResult } from "../api/socket.js";
import { flattenTree, type FlatEntity, type ProjectEntity } from "../api/projectTypes.js";
import { extractMeta, type Identity } from "../session/identity.js";
import { fetchProjects } from "../tools/listProjects.js";
import { buildOutputUrl, requestCompile, summarizeErrors } from "../tools/compile.js";
import { assetMime, parseUploadResponse, uploadForm } from "../tools/uploadFile.js";
import { textToOps } from "../ot/diff.js";
import { buildOtUpdate } from "../ot/editPipeline.js";
import { checkCompileResponse, checkProjectTree, checkRanges, checkThreads } from "./contracts.js";
import { aggregateResults, DiagnosticError, failureResult, withDeadline, type DiagnosticCategory, type DiagnosticReport, type DiagnosticResult } from "./model.js";
import { DiagnosticRedactor } from "./redact.js";

export interface DiagnosticOptions {
  projectId?: string;
  timeoutMs?: number;
  compileTimeoutMs?: number;
  compile?: boolean;
  config?: Config;
}

// Local seams keep tests independent of real credentials. Network probes still
// consume the production HTTP/socket implementations (tested with a fake server).
export interface DiagnosticDependencies {
  cookiePath(): string;
  loadSession(baseUrl: string): Promise<StoredCookie | null>;
}
type Spec = Pick<DiagnosticResult, "id" | "area" | "category" | "expected" | "relevantFiles" | "recommendation">;
type Outcome<T> = { value: T; status?: DiagnosticResult["status"]; summary: string; details?: string[]; observed?: string };

const GUIDE: Record<string, { relevantFiles: string[]; recommendation: string[] }> = {
  Environment: { relevantFiles: ["src/config.ts", "src/auth/cookieStore.ts", "package.json"], recommendation: ["Check Node >=20, build with npm run build, inspect config/session file access and OL_BASE_URL."] },
  Authentication: { relevantFiles: ["src/session/identity.ts", "src/auth/browserLogin.ts", "src/api/http.ts"], recommendation: ["Compare GET /project in the logged-in browser: login redirect vs ol-user_id/ol-csrfToken meta tags.", "See AGENTS.md: Diagnostics and protocol drift / AUTHENTICATION and HTTP_SCHEMA."] },
  "HTTP API": { relevantFiles: ["src/tools/listProjects.ts", "src/api/http.ts", "src/api/types.ts"], recommendation: ["Capture the Web Editor dashboard POST /api/project (legacy GET /user/projects); compare Projects controller/router in Overleaf OSS.", "See AGENTS.md: Diagnostics and protocol drift / HTTP_ENDPOINT and HTTP_SCHEMA."] },
  Realtime: { relevantFiles: ["src/api/socket.ts", "src/api/projectTypes.ts", "src/session/activeProject.ts", "src/tools/readFile.ts"], recommendation: ["Inspect Web Editor handshake /socket.io/1 and WebSocket 0.9 envelopes, joinProjectResponse or fallback joinProject, then joinDoc ACK.", "Compare Overleaf services/real-time/app/js/Router.js and WebsocketController.js; never switch to the cookie-dropping socket.io fork.", "See AGENTS.md: Diagnostics and protocol drift / SOCKET_*."] },
  OT: { relevantFiles: ["src/api/socket.ts", "src/ot/diff.ts", "src/ot/editPipeline.ts", "src/ot/verify.ts", "src/tools/editFile.ts"], recommendation: ["Capture applyOtUpdate(docId, {doc,op,v,meta?:{tc}}) on an isolated test document; inspect current Web client share-js-doc.ts and document-updater.", "Verify fresh joinDoc text/version after ACK, including concurrent writers; an ACK alone does not prove the edit landed.", "See AGENTS.md: Diagnostics and protocol drift / OT_PROTOCOL and VERSION_CONFLICT."] },
  Review: { relevantFiles: ["src/tools/trackedChanges.ts", "src/ot/trackedChanges.ts", "src/tools/comments.ts", "src/api/commentTypes.ts"], recommendation: ["Compare live GET /ranges and /threads with ranges-tracker and the Web Editor's applyOtUpdate meta.tc.", "On an isolated test document, create a tracked insertion, confirm its own change ID, undo only that change and verify cleanup.", "See AGENTS.md: Diagnostics and protocol drift / TRACK_CHANGES and COMMENTS."] },
  Compilation: { relevantFiles: ["src/tools/compile.ts", "src/api/compileTypes.ts"], recommendation: ["Compare Web Editor POST /project/:id/compile: rootResourcePath must be a string. Inspect Compile router/controller and outputFiles routing.", "Fetch output.log with clsiserverid/compileGroup; status success can include LaTeX errors.", "See AGENTS.md: Diagnostics and protocol drift / COMPILE_API."] },
  Assets: { relevantFiles: ["src/tools/uploadFile.ts", "src/api/http.ts"], recommendation: ["Inspect Web Editor multipart POST /Project/:id/upload?folder_id=... (capital P), name/qqfile fields and X-Csrf-Token.", "OPTIONS is only capability evidence; verify a unique tiny asset's bytes and delete only that asset in a dedicated test project.", "See AGENTS.md: Diagnostics and protocol drift / UPLOAD_API."] },
};

export async function runDiagnostics(options: DiagnosticOptions = {}, dependencies: DiagnosticDependencies = {
  cookiePath: cookieFilePath, loadSession: (url) => loadStored(url, true),
}): Promise<DiagnosticReport> {
  const results: DiagnosticResult[] = [];
  const redactor = new DiagnosticRedactor();
  const config = options.config ?? loadConfig();
  redactor.add(config.csrfOverride);
  const timeout = options.timeoutMs ?? 10_000;
  const compileTimeout = options.compileTimeoutMs ?? 60_000;
  const spec = (id: string, area: string, category: DiagnosticCategory, expected: string): Spec => ({ id, area, category, expected, ...GUIDE[area] });
  const add = (result: DiagnosticResult) => {
    const safe = redactor.value(result);
    if (safe.observed) safe.observed = safe.observed.slice(0, 1600);
    results.push(safe);
  };
  const skip = (s: Spec, reason: string) => add({ ...s, status: "skip", summary: reason });
  const check = async <T>(s: Spec, operation: (signal: AbortSignal) => Promise<Outcome<T>>, limit = timeout): Promise<T | undefined> => {
    const started = Date.now();
    try {
      const timeoutCategory = s.id.startsWith("auth.") || s.id.startsWith("http.") ? "NETWORK" : s.category ?? "UNKNOWN";
      const outcome = await withDeadline(operation, limit, timeoutCategory);
      add({ ...s, status: outcome.status ?? "pass", summary: outcome.summary, details: outcome.details, observed: outcome.observed, durationMs: Date.now() - started });
      return outcome.value;
    } catch (error) {
      add({ ...failureResult(s, error), durationMs: Date.now() - started });
      return undefined;
    }
  };

  const nodeOK = await check(spec("env.node", "Environment", "LOCAL_ENV", "Node.js >=20"), async () => {
    if (Number(process.versions.node.split(".")[0]) < 20) throw new DiagnosticError("LOCAL_ENV", "Node.js >=20", process.versions.node, "version");
    return { value: true, summary: `Node.js ${process.versions.node}` };
  });
  await check(spec("env.build", "Environment", "LOCAL_ENV", "compiled diagnostics entrypoint loads"), async () => ({
    value: true, status: import.meta.url.endsWith(".js") ? "pass" : "partial",
    summary: import.meta.url.endsWith(".js") ? "Compiled entrypoint and imports loaded (does not rebuild or check freshness)" : "Running source; build not verified",
  }));
  const urlOK = await check(spec("env.config", "Environment", "LOCAL_ENV", "OL_BASE_URL: http(s) URL without embedded credentials, query or fragment"), async () => {
    const url = new URL(config.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new DiagnosticError("LOCAL_ENV", "plain http(s) base URL", "OL_BASE_URL has an unsupported scheme or embedded credentials/query/fragment", "configuration");
    return { value: true, summary: `Configured host: ${url.host}` };
  });
  await check(spec("env.configDirectory", "Environment", "LOCAL_ENV", "readable configuration directory"), async () => {
    try { await access(dirname(dependencies.cookiePath()), constants.R_OK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { value: false, status: "warn", summary: "Configuration directory absent; run node dist/index.js login" };
      throw error;
    }
    return { value: true, summary: "Configuration directory readable (no write probe)" };
  });
  const sessionSpec = spec("env.session", "Environment", "LOCAL_ENV", "stored cookie for configured host");
  const stored = urlOK ? await check(sessionSpec, async () => {
    const stored = await dependencies.loadSession(config.baseUrl);
    if (!stored?.cookie?.trim()) throw new DiagnosticError("AUTHENTICATION", "saved session cookie", "No stored session; run node dist/index.js login", "missing session");
    redactor.addCookie(stored.cookie);
    return { value: stored, summary: "Stored Overleaf session present; credential omitted" };
  }) : (skip(sessionSpec, "Blocked by invalid configuration"), undefined);
  const identity: Identity = { baseUrl: config.baseUrl, cookie: stored?.cookie ?? "", csrf: "", userId: "", userEmail: "" };
  const context = (signal: AbortSignal): HttpContext => ({ identity, signal });
  const sessionCheck = spec("auth.session", "Authentication", "HTTP_SCHEMA", "GET /project accepted; ol-user_id meta tag present");
  const html = stored && nodeOK && urlOK ? await check(sessionCheck, async (signal) => {
    const res = await olGet("project", {}, context(signal));
    await expectOk(res, "GET /project");
    const html = await res.text();
    if (/<form\b[^>]*action=["'][^"']*\/login/i.test(html) || /<meta\b[^>]*name=["']ol-login/i.test(html)) throw new OverleafAuthError("GET /project returned a login page (HTTP 200)");
    const userId = extractMeta(html, "ol-user_id");
    if (!userId) throw new DiagnosticError("HTTP_SCHEMA", "ol-user_id meta tag", "HTTP accepted but identity meta tag absent; inspect page for login/challenge vs markup drift");
    identity.userId = userId;
    return { value: html, summary: "Saved session accepted; identity markup recognized" };
  }) : (skip(sessionCheck, "Blocked by environment or missing session"), undefined);
  const csrfSpec = spec("auth.csrf", "Authentication", "HTTP_SCHEMA", "ol-csrfToken discovery or explicit OL_CSRF");
  let csrfReady = false;
  if (html !== undefined) csrfReady = Boolean(await check(csrfSpec, async () => {
    const discovered = extractMeta(html, "ol-csrfToken");
    redactor.add(discovered);
    identity.csrf = config.csrfOverride ?? discovered ?? "";
    if (!identity.csrf) throw new DiagnosticError("HTTP_SCHEMA", "ol-csrfToken meta tag", "Authenticated page missing CSRF token (OL_CSRF also absent)");
    return { value: true, status: config.csrfOverride ? "partial" : "pass", summary: config.csrfOverride ? "Using OL_CSRF override; automatic discovery not verified" : "CSRF token discovered; value omitted" };
  }));
  else skip(csrfSpec, "Blocked by auth.session");

  const listSpec = spec("http.projects", "HTTP API", "HTTP_SCHEMA", "dashboard {projects: array}; legacy endpoint only on 404/405");
  const projects = html !== undefined && csrfReady ? await check(listSpec, async (signal) => {
    const projects = await fetchProjects(context(signal));
    return { value: projects, summary: `Project listing schema recognized (${projects.length} projects)` };
  }) : (skip(listSpec, "Blocked by authentication/CSRF"), undefined);
  const selectionSpec = spec("http.projectSelection", "HTTP API", "HTTP_ENDPOINT", "requested or first active project in listing");
  let projectId: string | undefined;
  let projectReason = "Blocked by http.projects";
  if (projects) {
    const candidate = options.projectId ? projects.find((p) => p.id === options.projectId && !p.trashed) : projects.find((p) => !p.archived && !p.trashed);
    if (!candidate && options.projectId) add(failureResult(selectionSpec, new DiagnosticError("HTTP_ENDPOINT", "--project ID in account listing", "Requested project not found or is trashed", "selection")));
    else if (!candidate) { projectReason = "No active project available"; skip(selectionSpec, projectReason); }
    else { projectId = candidate.id; projectReason = "Blocked by realtime project join"; add({ ...selectionSpec, status: "pass", summary: `Selected project ID ${projectId}; name and account details omitted` }); }
  } else skip(selectionSpec, projectReason);

  let socket: OverleafSocket | undefined;
  let project: ProjectEntity | undefined;
  let entities: FlatEntity[] | undefined;
  let doc: JoinDocResult | undefined;
  let docId: string | undefined;
  const handshakeSpec = spec("socket.handshake", "Realtime", "SOCKET_HANDSHAKE", "Socket.IO 0.9 handshake with websocket transport");
  const transportSpec = spec("socket.transport", "Realtime", "SOCKET_TRANSPORT", "WebSocket upgrade accepted");
  const joinSpec = spec("socket.joinProject", "Realtime", "SOCKET_EVENT", "joinProjectResponse or explicit joinProject ACK containing project");
  try {
    if (projectId) {
      socket = new OverleafSocket(projectId, identity, true);
      let currentSpec = handshakeSpec;
      const started = Date.now();
      try {
        await withDeadline((signal) => socket!.connect(timeout, { signal, onStage: (stage) => {
          if (stage === "handshake") { add({ ...handshakeSpec, status: "pass", summary: "Socket.IO 0.9 handshake recognized" }); currentSpec = transportSpec; }
          else { add({ ...transportSpec, status: "pass", summary: "WebSocket transport connected" }); currentSpec = joinSpec; }
        } }), timeout + 100, "SOCKET_EVENT");
        project = socket.joinedProject ?? undefined;
        add({ ...joinSpec, status: "pass", summary: "Realtime project metadata received and identity matched", durationMs: Date.now() - started });
      } catch (error) {
        socket.disconnect();
        add({ ...failureResult(currentSpec, error), durationMs: Date.now() - started });
      }
      for (const s of [handshakeSpec, transportSpec, joinSpec]) if (!results.some((r) => r.id === s.id)) skip(s, "Blocked by preceding realtime stage");
    } else for (const s of [handshakeSpec, transportSpec, joinSpec]) skip(s, projectReason);
    const treeSpec = spec("socket.projectTree", "Realtime", "SOCKET_PROTOCOL", "joinProject project.rootFolder and document/file entities");
    if (project) entities = await check(treeSpec, async () => {
      project = checkProjectTree(project);
      const flat = project.rootFolder[0] ? flattenTree(project.rootFolder[0]) : [];
      return { value: flat, summary: `Project tree schema recognized (${flat.filter((e) => e.kind === "doc").length} documents, ${flat.filter((e) => e.kind === "file").length} assets)` };
    });
    else skip(treeSpec, projectReason);
    const fileSpec: Spec = { ...spec("http.fileDownload", "HTTP API", "HTTP_ENDPOINT", "GET /project/:id/file/:fileId can read an existing asset"),
      relevantFiles: ["src/tools/readFile.ts", "src/api/http.ts"],
      recommendation: ["Compare the Web Editor's binary GET /project/:id/file/:fileId, status and redirects; inspect the matching web file-download route/controller.", "See AGENTS.md: Diagnostics and protocol drift / HTTP_ENDPOINT."] };
    const file = entities?.find((e) => e.kind === "file");
    if (projectId && file) await check(fileSpec, async (signal) => {
      const res = await olGet(`project/${projectId}/file/${file.id}`, { Range: "bytes=0-1023" }, context(signal));
      await expectOk(res, "GET existing asset");
      const reader = res.body?.getReader();
      try {
        const sample = await reader?.read();
        return { value: true, summary: `Existing asset endpoint accepted; sampled ${sample?.value?.length ?? 0} bytes (body omitted)` };
      } finally { await reader?.cancel(); }
    }); else skip(fileSpec, entities ? "No existing asset available" : "Blocked by project tree");
    const discoverySpec = spec("socket.documentDiscovery", "Realtime", "SOCKET_PROTOCOL", "root doc or an editable document in project tree");
    if (entities) {
      docId = (entities.find((e) => e.kind === "doc" && e.id === project?.rootDoc_id) ?? entities.find((e) => e.kind === "doc"))?.id;
      if (docId) add({ ...discoverySpec, status: "pass", summary: `Discovered document ID ${docId}; contents omitted` });
      else skip(discoverySpec, "No editable document available");
    } else skip(discoverySpec, "Blocked by project tree");
    const docSpec = spec("socket.joinDoc", "Realtime", "SOCKET_EVENT", "joinDoc(docId,{encodeRanges:true}) ACK with lines and version");
    if (docId && socket) doc = await check(docSpec, async () => {
      const value = parseJoinDocResponse(await socket!.emit("joinDoc", [docId, { encodeRanges: true }], timeout));
      return { value, summary: "joinDoc ACK shape recognized; packed UTF-8 decoded" };
    });
    else skip(docSpec, entities ? "No editable document available" : "Blocked by project tree");
    for (const [id, expected, summary] of [
      ["socket.documentVersion", "nonnegative integer version", `Current document version: ${doc?.version}`],
      ["socket.documentContents", "decoded string[] document lines", `Document contents read (${doc?.docLines.length ?? 0} lines); text omitted`],
    ]) {
      const s = spec(id, "Realtime", "SOCKET_PROTOCOL", expected);
      if (doc) add({ ...s, status: "pass", summary }); else skip(s, "Blocked by socket.joinDoc");
    }

    const otSpec = spec("ot.contract", "OT", "OT_PROTOCOL", "applyOtUpdate(docId,{doc,op:[{p,i|d}],v,meta?:{tc}}); ACK [null,...], post-edit version >=v+1");
    if (doc && docId) await check(otSpec, async () => {
      // Use synthetic text, never send a no-op or user content to applyOtUpdate.
      const ops = textToOps("α\nold", "α\nnew");
      let actual = "α\nold";
      for (const op of ops) {
        if (!Number.isSafeInteger(op.p) || op.p < 0 || (op.i !== undefined) === (op.d !== undefined)) throw new DiagnosticError("OT_PROTOCOL", "ShareJS p/i/d operations", "invalid locally constructed operation");
        if (op.d !== undefined && actual.slice(op.p, op.p + op.d.length) !== op.d) throw new DiagnosticError("OT_PROTOCOL", "matching deleted text", "local OT deletion mismatch");
        actual = actual.slice(0, op.p) + (op.i ?? "") + actual.slice(op.p + (op.d?.length ?? 0));
      }
      if (actual !== "α\nnew") throw new DiagnosticError("OT_PROTOCOL", "synthetic diff round trip", "local operation round trip failed");
      const update = buildOtUpdate(docId!, ops, doc!.version, true);
      if (update.doc !== docId || update.v !== doc!.version || update.op !== ops) throw new DiagnosticError("OT_PROTOCOL", "update contains supplied doc/op/v", "shared OT builder changed its payload contract");
      if (!update.meta || !/^[a-f\d]{18}$/.test(update.meta.tc) || Object.keys(update.meta).join(",") !== "tc") throw new DiagnosticError("TRACK_CHANGES", "meta contains only tc: 18 hex chars", "invalid local tracked-change seed/schema");
      return { value: true, status: "partial", summary: "Live version and local OT construction verified; server write/ACK/version increment NOT VERIFIED" };
    });
    else skip(otSpec, "Blocked by socket.joinDoc");
    skip(spec("ot.write", "OT", "OT_PROTOCOL", "real applyOtUpdate ACK and fresh text/version verification"), "Safe mode: write probe skipped, including no-op writes");

    const rangesSpec = spec("review.ranges", "Review", "TRACK_CHANGES", "GET /project/:id/ranges tracked changes and comment anchors");
    if (projectId && html !== undefined) await check(rangesSpec, async (signal) => {
      const ranges = checkRanges(await asJson(await olGet(`project/${projectId}/ranges`, {}, context(signal))));
      const count = ranges.reduce((n, r) => n + (r.ranges?.changes?.length ?? 0), 0);
      return { value: ranges, status: count ? "pass" : "partial", summary: count ? `Live tracked-change schema recognized (${count} changes); text omitted` : "Ranges endpoint recognized; no tracked changes to verify entry schema" };
    }); else skip(rangesSpec, projectReason);
    const trackingSpec = spec("review.tracking", "Review", "TRACK_CHANGES", "track_changes_state: boolean or user-to-boolean map; meta.tc server behavior");
    if (project) await check(trackingSpec, async () => {
      const state = project!.track_changes_state ?? project!.trackChangesState;
      if (state != null && typeof state !== "boolean" && (typeof state !== "object" || Array.isArray(state) || Object.values(state).some((v) => typeof v !== "boolean"))) throw new DiagnosticError("TRACK_CHANGES", trackingSpec.expected!, "unrecognized track_changes_state value types");
      return { value: true, status: "partial", summary: state == null ? "Tracking state absent; meta.tc and server-forced tracking NOT VERIFIED" : "Tracking state shape recognized; meta.tc and server-forced tracking NOT VERIFIED" };
    }); else skip(trackingSpec, projectReason);
    skip(spec("review.write", "Review", "TRACK_CHANGES", "tracked insertion verified then own change reverted; comment lifecycle"), "Safe mode: tracked/comment writes and accept/reject skipped");
    const threadsSpec = spec("comments.threads", "Review", "COMMENTS", "GET /project/:id/threads thread-to-messages map");
    if (projectId && html !== undefined) await check(threadsSpec, async (signal) => {
      const threads = checkThreads(await asJson(await olGet(`project/${projectId}/threads`, {}, context(signal))));
      const count = Object.keys(threads).length;
      return { value: threads, status: count ? "pass" : "partial", summary: count ? `Comments endpoint and thread schema recognized (${count} threads); messages omitted` : "Comments endpoint returned empty map; populated message schema NOT VERIFIED" };
    }); else skip(threadsSpec, projectReason);

    const compileSpec = spec("compile.response", "Compilation", "COMPILE_API", "POST compile accepts concrete rootResourcePath and returns recognized status/outputFiles");
    const rootPath = entities?.find((e) => e.kind === "doc" && e.id === project?.rootDoc_id)?.path;
    const compile = projectId && rootPath && csrfReady && options.compile !== false ? await check(compileSpec, async (signal) => {
      const result = checkCompileResponse(await requestCompile(projectId!, rootPath, false, false, context(signal)));
      return { value: result, summary: `Compile endpoint and response schema recognized; status=${result.status}` };
    }, compileTimeout) : (skip(compileSpec, options.compile === false ? "--no-compile: compile request skipped" : !rootPath ? "No configured root document available (or project tree blocked)" : "Blocked by authentication/CSRF"), undefined);
    const logSpec = spec("compile.log", "Compilation", "COMPILE_API", "output.log reachable with clsiserverid/compileGroup; parse ! error lines");
    const logFile = compile?.outputFiles?.find((f) => f.path === "output.log");
    if (compile && logFile) await check(logSpec, async (signal) => {
      const res = await olGet(buildOutputUrl(logFile, compile), {}, context(signal));
      await expectOk(res, "GET output.log");
      const log = await res.text();
      if (/^\s*(?:<!doctype html|<html)/i.test(log)) throw new DiagnosticError("COMPILE_API", "text output.log", "HTML returned instead of compile log");
      if (!log.trim()) return { value: true, status: "partial", summary: "Empty compile log; LaTeX error status NOT VERIFIED" };
      if (!/^This is (?:pdfTeX|XeTeX|Lua(?:HB)?TeX|e-TeX|TeX)|Output written on|^! /m.test(log)) return { value: true, status: "partial", summary: "Log fetched but TeX markers unrecognized; clean-build status NOT VERIFIED" };
      const summary = summarizeErrors(log);
      const pdf = compile.outputFiles?.some((f) => f.path === "output.pdf");
      return { value: true, status: summary.error_count || !pdf || compile.status !== "success" ? "warn" : "pass", summary: summary.error_count ? `Compile API works; project has ${summary.error_count} LaTeX error(s), ${summary.warnings} warning(s). This is a project build issue.` : !pdf || compile.status !== "success" ? `Log parsing works; project did not build successfully (status=${compile.status}, PDF=${Boolean(pdf)})` : `PDF produced; log contains zero LaTeX errors (${summary.warnings} warnings)` };
    }); else if (compile) add({ ...logSpec, status: "partial", summary: `Compile response recognized but no output.log (status=${compile.status}); project error status NOT VERIFIED` });
    else skip(logSpec, "Compile not run or response incompatible");

    const formSpec = spec("upload.contract", "Assets", "UPLOAD_API", "multipart name + qqfile; response {success:true,entity_id,entity_type:file}");
    await check(formSpec, async () => {
      const bytes = Buffer.from([0, 1, 2]);
      const form = uploadForm(bytes, "diagnostic.png", assetMime("diagnostic.png"));
      const blob = form.get("qqfile") as Blob;
      if (form.get("name") !== "diagnostic.png" || !Buffer.from(await blob.arrayBuffer()).equals(bytes)) throw new DiagnosticError("UPLOAD_API", formSpec.expected!, "local multipart contract mismatch");
      parseUploadResponse({ success: true, entity_id: "a".repeat(24), entity_type: "file" });
      return { value: true, status: "partial", summary: "Local multipart construction/response parser recognized; live required fields and upload response NOT VERIFIED" };
    });
    const uploadSpec = spec("upload.endpoint", "Assets", "UPLOAD_API", "OPTIONS /Project/:id/upload?folder_id=... may advertise POST; actual upload not performed");
    const folderId = project?.rootFolder?.[0]?._id;
    if (projectId && entities && folderId && html !== undefined) await check(uploadSpec, async (signal) => {
      const res = await olOptions(`Project/${projectId}/upload?${new URLSearchParams({ folder_id: folderId })}`, context(signal));
      const allow = res.headers.get("allow") ?? "";
      // Generic OPTIONS and missing OPTIONS routes cannot prove whether the
      // multipart POST route exists. Always partial, even if POST is allowed.
      if (!res.ok && res.status !== 404 && res.status !== 405) await expectOk(res, "OPTIONS upload capability");
      await res.body?.cancel();
      return { value: true, status: "partial", summary: /\bPOST\b/i.test(allow) ? "Upload route advertises POST; multipart handling and permission NOT VERIFIED" : "Upload endpoint cannot be confirmed with safe OPTIONS; actual POST NOT VERIFIED", observed: `OPTIONS HTTP ${res.status}; Allow=${allow || "absent"}` };
    }); else skip(uploadSpec, "No valid project root folder or authentication available");
    skip(spec("upload.write", "Assets", "UPLOAD_API", "upload unique asset, verify downloaded bytes, delete and confirm cleanup"), "Safe mode: asset upload/delete skipped");
  } finally { socket?.disconnect(); }
  return redactor.value(aggregateResults(results));
}
