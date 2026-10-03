import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";

import { aggregateResults, DiagnosticError, failureResult, withDeadline, type DiagnosticResult } from "../../src/diagnostics/model.js";
import { DiagnosticRedactor } from "../../src/diagnostics/redact.js";
import { formatReport } from "../../src/diagnostics/format.js";
import { runDiagnostics, type DiagnosticOptions } from "../../src/diagnostics/run.js";
import { checkCompileResponse, checkProjectTree } from "../../src/diagnostics/contracts.js";
import { getClientMetadata } from "../../src/diagnostics/client.js";
import { parseDiagnosticArgs } from "../../src/diagnose.js";
import { OverleafApiError, OverleafAuthError, OverleafProtocolError } from "../../src/api/errors.js";

const projectId = "a".repeat(24);
const docId = "b".repeat(24);
const folderId = "c".repeat(24);
const COOKIE_SECRET = "diagnostic-cookie-secret-123";
const CSRF_SECRET = "diagnostic-csrf-secret-456";
const SID_SECRET = "diagnostic-session-secret-789";
const LB_SECRET = "diagnostic-loadbalancer-secret-000";
const result = (status: DiagnosticResult["status"]): DiagnosticResult => ({ id: "test", area: "test", status, summary: "test" });

describe("diagnostic aggregation and coverage", () => {
  for (const [statuses, overall] of [
    [["pass", "pass"], "passed"], [["pass", "skip"], "partial"], [["pass", "partial"], "partial"],
    [["pass", "warn"], "warning"], [["pass", "warn", "partial"], "warning"],
    [["pass", "fail"], "failed"], [["fail", "fail", "warn"], "failed"], [[], "partial"],
  ] as [DiagnosticResult["status"][], string][]) it(`${statuses.join("+") || "empty"} -> ${overall}`, () => {
    const report = aggregateResults(statuses.map(result));
    assert.equal(report.overall, overall);
    assert.equal(Object.values(report.counts).reduce((a, b) => a + b, 0), statuses.length);
    assert.equal(report.counts.fail, statuses.filter((s) => s === "fail").length);
  });
});

describe("unified secret redaction in human and JSON reports", () => {
  it("removes labeled, nested, echoed, escaped and URL-encoded credentials", () => {
    const redactor = new DiagnosticRedactor();
    const known = "known-secret/a+b=xyz";
    redactor.addCookie(`overleaf_session2=${known}; GCLB=${LB_SECRET}`);
    redactor.addCookie("cookie_consent=1; preference=true; overleaf_session2=another-auth-secret-123");
    redactor.add(CSRF_SECRET);
    const secrets = ["fresh-cookie-123", "fresh-csrf-123", "fresh-auth-123", "fresh-token-123", "fresh-secret-123", "fresh-pass-123"];
    const body = JSON.stringify({ cookie: secrets[0], "x-csrf-token": secrets[1], authorization: `Bearer ${secrets[2]}`, upload_token: secrets[3], clientSecret: secrets[4], password: secrets[5] });
    const report = aggregateResults([{ ...result("fail"), expected: CSRF_SECRET,
      summary: `Echo ${known} and ${encodeURIComponent(known)} and ${LB_SECRET}`,
      observed: body,
      details: ["Cookie: overleaf_session2=fresh-header-123; GCLB=another-cookie-123", "Authorization: Basic basic-secret-123", "csrf=fresh-unquoted-123", "token='fresh-singlequoted-123'", "https://username:user-password-123@host/project?token=link-secret-123&signature=signed-secret-123", `wss://host/socket.io/1/websocket/${SID_SECRET}`],
    }]);
    const nested = redactor.value({ response: { csrf: "nested-secret-123", authorization: "nested-auth-123", cookie: "nested-cookie-123", token: "nested-token-123" } });
    assert.deepEqual(Object.values(nested.response), Array(4).fill("[REDACTED]"));
    for (const json of [false, true]) {
      const output = formatReport(report, json, redactor);
      for (const secret of [...secrets, known, encodeURIComponent(known), CSRF_SECRET, LB_SECRET, SID_SECRET, "fresh-header-123", "another-cookie-123", "basic-secret-123", "fresh-unquoted-123", "fresh-singlequoted-123", "user-password-123", "link-secret-123", "signed-secret-123"]) assert.ok(!output.includes(secret), `leaked ${secret} (json=${json})`);
      assert.ok(output.includes("[REDACTED]"));
      if (json) assert.doesNotThrow(() => JSON.parse(output));
    }
  });

  it("removes terminal control characters from server messages", () => {
    assert.equal(new DiagnosticRedactor().text("bad\x1b[2J\x00message"), "bad[2Jmessage");
  });

  it("keeps machine fields, IDs, timestamps and versions intact with short preference cookies", () => {
    const redactor = new DiagnosticRedactor();
    redactor.addCookie("consent=1; cookie_consent=1; preferences=true; overleaf_session2=secret-session-value-123");
    const report = aggregateResults([{ ...result("pass"), summary: "Node.js 24.11.1; v1; document ID 123456" }]);
    assert.deepEqual(redactor.value(report), report);
    assert.equal(JSON.parse(formatReport(report, true, redactor)).generatedAt, report.generatedAt);
    assert.equal(redactor.text("Cookie: preferences=true; consent=1"), "Cookie: [REDACTED]");
  });

  it("redacts embedded response JSON with secret objects/arrays and hidden HTML tokens", () => {
    const report = aggregateResults([{ ...result("fail"), observed: 'HTTP 400: {"cookie":{"value":"nested-server-cookie-123"},"csrf":["nested-server-csrf-123"],"authorization":{"scheme":"Bearer","value":"nested-server-auth-123"},"token":12345,"error":"Unrecognized key: meta.tc"}',
      details: ['<meta name="ol-csrfToken" content="hidden-html-token-123">', "session_id=unknown-session-value-123"],
    }]);
    for (const json of [false, true]) {
      const output = formatReport(report, json);
      for (const secret of ["nested-server-cookie-123", "nested-server-csrf-123", "nested-server-auth-123", "12345", "hidden-html-token-123", "unknown-session-value-123"]) assert.ok(!output.includes(secret));
      assert.ok(output.includes("Unrecognized key: meta.tc"), "preserve the useful server rejection");
    }
  });
});

describe("deadline and error classification", () => {
  for (const error of [new OverleafAuthError("HTTP 403 on request"), new OverleafApiError(403, "Forbidden")]) {
    it(`classifies unvalidated 403 as authentication (${error.name})`, () => {
      const failure = failureResult({ id: "compile.response", area: "Compilation", category: "COMPILE_API" }, error);
      assert.equal(failure.category, "AUTHENTICATION");
      assert.match(failure.recommendation!.join(" "), /login/);
    });
    it(`keeps authenticated 403 in the endpoint category (${error.name})`, () => {
      const failure = failureResult({ id: "compile.response", area: "Compilation", category: "COMPILE_API" }, error, { sessionValidated: true });
      assert.equal(failure.category, "COMPILE_API");
      assert.match(failure.observed!, /403 after authenticated session/);
      assert.match(failure.recommendation!.join(" "), /CSRF semantics, project permissions, endpoint policy, or protocol drift/);
      assert.doesNotMatch(failure.recommendation!.join(" "), /\blogin\b/i);
    });
  }

  for (const message of ["HTTP 401 on request", "redirected to /login — session expired", "invalid session", "invalid session (HTTP 403)"]) {
    it(`preserves explicit authentication evidence after session validation: ${message}`, () => {
      const failure = failureResult({ id: "compile.response", area: "Compilation", category: "COMPILE_API" }, new OverleafAuthError(message), { sessionValidated: true });
      assert.equal(failure.category, "AUTHENTICATION");
    });
  }

  it("bounds a non-returning operation and sends cancellation", async () => {
    let aborted = false;
    const started = Date.now();
    await assert.rejects(withDeadline(async (signal) => {
      signal.addEventListener("abort", () => { aborted = true; });
      return new Promise<never>(() => {});
    }, 20, "SOCKET_EVENT"), (error: unknown) => {
      const failure = failureResult({ id: "socket.joinProject", area: "Realtime" }, error);
      assert.equal(failure.category, "SOCKET_EVENT");
      assert.equal(failure.kind, "timeout");
      assert.equal(failure.observed, "timeout after 20ms");
      return true;
    });
    assert.equal(aborted, true);
    assert.ok(Date.now() - started < 1000);
  });

  it("keeps version conflicts separate from malformed socket ACKs", () => {
    const failure = failureResult({ id: "ot.write", area: "OT", category: "OT_PROTOCOL" }, new OverleafProtocolError("applyOtUpdate", "rejection", "current version", "stale version"));
    assert.equal(failure.category, "VERSION_CONFLICT");
  });

  it("rejects a compile success response missing outputFiles, not a known LaTeX failure status", () => {
    assert.throws(() => checkCompileResponse({ status: "success" }), (error: unknown) => error instanceof DiagnosticError && error.category === "COMPILE_API");
    assert.equal(checkCompileResponse({ status: "failure" }).status, "failure");
  });
});

describe("project root folder contract", () => {
  const root = { _id: folderId, name: "root", docs: [], fileRefs: [], folders: [] };
  it("accepts a valid empty project with one root folder", () => {
    assert.deepEqual(checkProjectTree({ _id: projectId, name: "Empty", rootFolder: [root] }).rootFolder, [root]);
  });
  for (const tree of [{ rootFolder: [] }, { rootFolder: [root, root] }, { rootFolder: [{ ...root, docs: {} }] }, { renamedRootFolder: [root] }]) {
    it(`rejects missing, empty, multiple or drifted root structure: ${JSON.stringify(tree)}`, () => {
      assert.throws(() => checkProjectTree({ _id: projectId, name: "Drift", ...tree }), (error: unknown) => {
        assert.ok(error instanceof DiagnosticError);
        assert.equal(error.category, "SOCKET_PROTOCOL");
        assert.match(error.expected, /exactly one/);
        assert.match(error.observed, /rootFolder/);
        return true;
      });
    });
  }
});

describe("diagnostic client metadata", () => {
  it("reports package version and the package checkout's Git revision", () => {
    const metadata = getClientMetadata();
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    assert.equal(metadata.version, pkg.version);
    const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8", timeout: 1000, windowsHide: true });
    assert.equal(metadata.revision, git.status === 0 ? git.stdout.trim() : null);
    assert.deepEqual(aggregateResults([]).client, metadata);
    assert.deepEqual(JSON.parse(formatReport(aggregateResults([]), true)).client, metadata);
  });

  it("tolerates absent metadata, installed packages outside Git and failed revision lookup", () => {
    const dir = mkdtempSync(join(tmpdir(), "overleaf-diagnostic-client-"));
    const root = pathToFileURL(dir + "/");
    try {
      assert.deepEqual(getClientMetadata(root), { version: null, revision: null });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "test-version" }));
      assert.deepEqual(getClientMetadata(root), { version: "test-version", revision: null });
      // An invalid .git file forces a lookup failure even if a parent is a repo.
      writeFileSync(join(dir, ".git"), "gitdir: ./missing-git-directory\n");
      assert.deepEqual(getClientMetadata(root), { version: "test-version", revision: null });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("does not use the caller or an unrelated ancestor repository for an installed package", () => {
    const dir = mkdtempSync(join(tmpdir(), "overleaf-diagnostic-installed-"));
    try {
      // Point an ancestor at a real checkout; the package itself has no .git.
      writeFileSync(join(dir, ".git"), `gitdir: ${fileURLToPath(new URL("../../.git", import.meta.url)).replaceAll("\\", "/")}\n`);
      const installed = join(dir, "installed");
      mkdirSync(installed);
      writeFileSync(join(installed, "package.json"), JSON.stringify({ version: "installed-version" }));
      assert.deepEqual(getClientMetadata(pathToFileURL(installed + "/")), { version: "installed-version", revision: null });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

interface FixtureOptions {
  authStatus?: number;
  loginHTML?: boolean;
  missingUser?: boolean;
  missingCsrf?: boolean;
  projects?: unknown;
  legacyProjects?: boolean;
  handshake?: string;
  handshakeStatus?: number;
  omitJoin?: boolean;
  fallbackJoin?: boolean;
  badJoin?: boolean;
  badDoc?: boolean;
  omitDoc?: boolean;
  closeBeforeJoin?: boolean;
  connectionRejected?: string;
  type7?: string;
  malformedAck?: boolean;
  missingRoot?: boolean;
  emptyDocs?: boolean;
  rootFolder?: unknown;
  compile?: unknown;
  log?: string;
  ranges?: unknown;
  threads?: unknown;
  optionsStatus?: number;
  delayPath?: string;
  asset?: boolean;
  forbiddenPath?: string;
  downstreamStatus?: number;
}

async function fixture(options: FixtureOptions = {}) {
  const text = "\\documentclass{article}\nPrivate thesis text 😊";
  const project = {
    _id: projectId, name: "Private project", rootDoc_id: options.missingRoot ? undefined : docId,
    rootFolder: options.rootFolder ?? [{ _id: folderId, name: "root", docs: options.emptyDocs ? [] : [{ _id: docId, name: "main.tex" }], folders: [], fileRefs: options.asset ? [{ _id: "d".repeat(24), name: "figure.png" }] : [] }],
    track_changes_state: true,
  };
  const threads = { thread: { messages: [{ id: "message", content: "Private comment", timestamp: 123 }], resolved: false } };
  const ranges = [{ id: docId, ranges: { changes: [{ id: "our-existing-change", op: { p: 0, i: "Private insertion" }, metadata: { user_id: "user", ts: "2026-10-02" } }], comments: [] } }];
  const before = structuredClone({ text, project, threads, ranges });
  const requests: { method: string; path: string; body: string }[] = [];
  const events: string[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    for await (const part of req) body += part;
    const path = new URL(req.url!, "http://local").pathname;
    requests.push({ method: req.method!, path, body });
    if (path === options.delayPath) return; // intentionally never returns
    const json = (data: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (path === options.forbiddenPath) { json({ error: "Forbidden" }, options.downstreamStatus ?? 403); return; }
    if (path === "/project") {
      if (options.authStatus) { res.writeHead(options.authStatus, { location: "/login?token=fresh-login-token-123" }); res.end("rejected"); return; }
      if (options.loginHTML) { res.end('<form action="/login"></form>'); return; }
      res.end(`${options.missingUser ? "" : '<meta name="ol-user_id" content="user">'}${options.missingCsrf ? "" : `<meta name="ol-csrfToken" content="${CSRF_SECRET}">`}`);
    } else if (path === "/api/project" || path === "/user/projects") {
      if (options.legacyProjects && path === "/api/project") json({}, 404);
      else json(options.projects ?? { projects: [{ id: projectId, name: project.name }] });
    } else if (path === "/socket.io/1/") {
      res.writeHead(options.handshakeStatus ?? 200, { "set-cookie": `GCLB=${LB_SECRET}; Path=/` });
      res.end(options.handshake ?? `${SID_SECRET}:60:60:websocket`);
    } else if (path === `/project/${projectId}/ranges`) json(options.ranges ?? ranges);
    else if (path === `/project/${projectId}/threads`) json(options.threads ?? threads);
    else if (path === `/project/${projectId}/compile`) json(options.compile ?? { status: "success", outputFiles: [{ path: "output.pdf", url: "/output.pdf" }, { path: "output.log", url: "/output.log" }], clsiServerId: "worker", compileGroup: "group" });
    else if (path === "/output.log") res.end(options.log ?? "Output written on output.pdf\n! Undefined control sequence.\n");
    else if (path === `/project/${projectId}/file/${"d".repeat(24)}`) res.end(Buffer.from([0, 1, 2, 3]));
    else if (path === `/Project/${projectId}/upload` && req.method === "OPTIONS") { res.writeHead(options.optionsStatus ?? 204, { allow: "POST" }); res.end(); }
    else json({ error: "unexpected request" }, 500);
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) => {
    assert.ok(req.headers.cookie?.includes(COOKIE_SECRET));
    assert.ok(req.headers.cookie?.includes(LB_SECRET), "upgrade must preserve GCLB affinity");
    const sendJoin = () => ws.send(`5:::{"name":"joinProjectResponse","args":${JSON.stringify([options.badJoin ? { renamed_project: project } : { project, protocolVersion: 2, permissionsLevel: "readAndWrite" }])}}`);
    ws.send("1::");
    if (options.closeBeforeJoin) { ws.close(1011, "upstream unavailable"); return; }
    if (options.connectionRejected) { ws.send(`5:::{"name":"connectionRejected","args":[{"message":${JSON.stringify(options.connectionRejected)}}]}`); return; }
    if (options.type7) { ws.send(`7:::${options.type7}`); return; }
    if (!options.omitJoin && !options.fallbackJoin) sendJoin();
    ws.on("message", (data) => {
      const match = data.toString().match(/^5:(\d+)\+::(.*)$/);
      if (!match) return;
      const event = JSON.parse(match[2]);
      events.push(event.name);
      assert.ok(["joinDoc", "joinProject"].includes(event.name), `unsafe event ${event.name}`);
      if (event.name === "joinProject" && options.fallbackJoin) ws.send(`6:::${match[1]}+${JSON.stringify([null, project, "readAndWrite", 1])}`);
      if (event.name === "joinDoc" && !options.omitDoc) {
        const ack = options.malformedAck ? { renamed_ack: [] } : [null, ...(options.badDoc ? [{ lines: [text] }, "42"] : [[Buffer.from(text, "utf8").toString("latin1")], 42, [], { changes: [] }])];
        ws.send(`6:::${match[1]}+${JSON.stringify(ack)}`);
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  const config = { baseUrl: `http://127.0.0.1:${address.port}`, csrfOverride: undefined, browserPath: undefined, insecure: false };
  const run = (extra: DiagnosticOptions = {}) => runDiagnostics({ config, timeoutMs: 600, compileTimeoutMs: 600, ...extra }, {
    cookiePath: () => fileURLToPath(import.meta.url),
    loadSession: async () => ({ cookie: `overleaf_session2=${COOKIE_SECRET}`, savedAt: Date.now() }),
  });
  return { run, requests, events, project, text, threads, ranges, before, cleanup: async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}

describe("diagnostics against production transports and a simulated Overleaf service", () => {
  for (const [path, id, category] of [
    ["/api/project", "http.projects", "HTTP_ENDPOINT"],
    ["/socket.io/1/", "socket.handshake", "SOCKET_HANDSHAKE"],
    [`/project/${projectId}/compile`, "compile.response", "COMPILE_API"],
    [`/project/${projectId}/threads`, "comments.threads", "COMMENTS"],
    [`/project/${projectId}/ranges`, "review.ranges", "TRACK_CHANGES"],
    [`/Project/${projectId}/upload`, "upload.endpoint", "UPLOAD_API"],
    [`/project/${projectId}/file/${"d".repeat(24)}`, "http.fileDownload", "HTTP_ENDPOINT"],
  ]) it(`classifies authenticated downstream 403 for ${id} as ${category}`, async () => {
    const f = await fixture({ forbiddenPath: path, asset: true });
    try {
      const report = await f.run();
      assert.equal(report.results.find((r) => r.id === "auth.session")?.status, "pass");
      const failure = report.results.find((r) => r.id === id)!;
      assert.equal(failure.status, "fail");
      assert.equal(failure.category, category);
      assert.match(failure.observed!, /403 after authenticated session/);
      assert.match(failure.recommendation!.join(" "), /CSRF semantics, project permissions, endpoint policy, or protocol drift/);
      assert.doesNotMatch(failure.recommendation!.join(" "), /\blogin\b/i);
    } finally { await f.cleanup(); }
  });

  it("retains authentication classification for a downstream HTTP 401", async () => {
    const f = await fixture({ forbiddenPath: `/project/${projectId}/compile`, downstreamStatus: 401 });
    try {
      const report = await f.run();
      assert.equal(report.results.find((r) => r.id === "auth.session")?.status, "pass");
      assert.equal(report.results.find((r) => r.id === "compile.response")?.category, "AUTHENTICATION");
    } finally { await f.cleanup(); }
  });

  for (const [threads, status, count] of [
    [{}, "partial", 0],
    [{ thread: { messages: [] } }, "partial", 0],
    [{ thread: { messages: [{ content: "Private comment", timestamp: 123 }] } }, "pass", 1],
    [{ empty: { messages: [] }, populated: { messages: [{ content: "Private comment", timestamp: 123 }] } }, "pass", 1],
    [{ thread: { messages: [{ content: "Private comment" }] } }, "fail", 0],
  ] as [unknown, string, number][]) it(`comments coverage is ${status} with ${JSON.stringify(threads)}`, async () => {
    const f = await fixture({ threads });
    try {
      const report = await f.run({ compile: false });
      const entry = report.results.find((r) => r.id === "comments.threads")!;
      assert.equal(entry.status, status);
      if (status === "partial") assert.match(entry.summary, /message schema NOT VERIFIED/);
      if (status === "pass") assert.match(entry.summary, new RegExp(`${count} messages`));
      if (status === "fail") assert.equal(entry.category, "COMMENTS");
      assert.ok(!formatReport(report, true).includes("Private comment"));
    } finally { await f.cleanup(); }
  });

  it("reports empty rootFolder as explicit project-tree schema failure", async () => {
    const f = await fixture({ rootFolder: [] });
    try {
      const report = await f.run();
      const failure = report.results.find((r) => r.id === "socket.projectTree")!;
      assert.equal(failure.status, "fail");
      assert.equal(failure.category, "SOCKET_PROTOCOL");
      assert.equal(failure.kind, "schema");
      assert.match(failure.expected!, /exactly one/);
      assert.match(failure.observed!, /rootFolder/);
      assert.equal(report.overall, "failed");
      for (const id of ["socket.joinDoc", "compile.response", "upload.endpoint"]) assert.equal(report.results.find((r) => r.id === id)?.status, "skip");
    } finally { await f.cleanup(); }
  });

  it("reads an existing asset without storing or uploading it", async () => {
    const f = await fixture({ asset: true });
    try {
      const report = await f.run({ compile: false });
      assert.equal(report.results.find((r) => r.id === "http.fileDownload")?.status, "pass");
      assert.equal(report.counts.fail, 0);
    } finally { await f.cleanup(); }
  });

  for (const [path, id, category] of [
    ["/project", "auth.session", "NETWORK"],
    ["/socket.io/1/", "socket.handshake", "SOCKET_HANDSHAKE"],
    [`/project/${projectId}/compile`, "compile.response", "COMPILE_API"],
    [`/Project/${projectId}/upload`, "upload.endpoint", "UPLOAD_API"],
  ]) it(`bounds non-returning HTTP ${id}`, async () => {
    const f = await fixture({ delayPath: path });
    try {
      const report = await f.run({ timeoutMs: 100, compileTimeoutMs: 100 });
      const failure = report.results.find((r) => r.id === id)!;
      assert.equal(failure.status, "fail");
      assert.equal(failure.category, category);
      assert.equal(failure.kind, "timeout");
      assert.match(failure.observed!, /100ms/);
    } finally { await f.cleanup(); }
  });

  it("safe mode reads without OT/review/asset writes and separates LaTeX errors from API success", async () => {
    const f = await fixture();
    try {
      const report = await f.run();
      assert.equal(report.counts.fail, 0, JSON.stringify(report));
      assert.equal(report.results.find((r) => r.id === "compile.response")?.status, "pass");
      assert.equal(report.results.find((r) => r.id === "compile.log")?.status, "warn");
      assert.match(report.results.find((r) => r.id === "compile.log")!.summary, /LaTeX error/);
      assert.equal(report.results.find((r) => r.id === "ot.contract")?.status, "partial");
      for (const id of ["ot.write", "review.write", "upload.write"]) assert.equal(report.results.find((r) => r.id === id)?.status, "skip");
      assert.equal(report.results.find((r) => r.id === "upload.endpoint")?.status, "partial");
      assert.equal(report.results.find((r) => r.id === "socket.documentVersion")?.status, "pass");
      assert.deepEqual(f.events, ["joinDoc"], "auto-join must not send repeated joinProject");
      assert.deepEqual(f.requests.filter((r) => r.method === "POST").map((r) => r.path), ["/api/project", `/project/${projectId}/compile`]);
      assert.ok(!f.requests.some((r) => ["DELETE", "PUT", "PATCH"].includes(r.method)));
      const compileBody = JSON.parse(f.requests.find((r) => r.path.endsWith("/compile"))!.body);
      assert.equal(compileBody.rootResourcePath, "main.tex");
      assert.equal(compileBody._csrf, CSRF_SECRET);
      assert.deepEqual({ text: f.text, project: f.project, threads: f.threads, ranges: f.ranges }, f.before);
      for (const json of [false, true]) {
        const output = formatReport(report, json);
        for (const secret of [COOKIE_SECRET, CSRF_SECRET, SID_SECRET, LB_SECRET, "Private thesis text", "Private comment", "Private insertion"]) assert.ok(!output.includes(secret), `report leaked ${secret}`);
      }
    } finally { await f.cleanup(); }
  });

  for (const status of [302, 401, 403]) it(`auth HTTP ${status} is AUTHENTICATION and blocks downstream calls`, async () => {
    const f = await fixture({ authStatus: status });
    try {
      const report = await f.run();
      assert.equal(report.results.find((r) => r.id === "auth.session")?.category, "AUTHENTICATION");
      assert.equal(report.counts.fail, 1);
      assert.deepEqual(f.requests.map((r) => r.path), ["/project"]);
      assert.ok(!formatReport(report, true).includes("fresh-login-token-123"));
    } finally { await f.cleanup(); }
  });

  for (const options of [{ loginHTML: true }, { missingCsrf: true }, { missingUser: true }]) it(`distinguishes login markup from missing meta tags: ${JSON.stringify(options)}`, async () => {
    const f = await fixture(options);
    try {
      const report = await f.run();
      assert.equal(report.results.find((r) => r.status === "fail")?.category, options.loginHTML ? "AUTHENTICATION" : "HTTP_SCHEMA");
      assert.equal(f.requests.length, 1);
    } finally { await f.cleanup(); }
  });

  for (const [options, id, category] of [
    [{ projects: { renamed_projects: [] } }, "http.projects", "HTTP_SCHEMA"],
    [{ handshake: '{"sid":"modern-socket"}' }, "socket.handshake", "SOCKET_HANDSHAKE"],
    [{ handshakeStatus: 502 }, "socket.handshake", "SOCKET_HANDSHAKE"],
    [{ badJoin: true }, "socket.joinProject", "SOCKET_PROTOCOL"],
    [{ badDoc: true }, "socket.joinDoc", "SOCKET_PROTOCOL"],
    [{ malformedAck: true }, "socket.joinDoc", "SOCKET_PROTOCOL"],
    [{ compile: { status: "success" } }, "compile.response", "COMPILE_API"],
    [{ ranges: { docs: [] } }, "review.ranges", "TRACK_CHANGES"],
    [{ threads: { thread: { messages: "changed" } } }, "comments.threads", "COMMENTS"],
  ] as [FixtureOptions, string, string][]) it(`reports actionable ${id} drift (${category})`, async () => {
    const f = await fixture(options);
    try {
      const report = await f.run();
      const failure = report.results.find((r) => r.id === id)!;
      assert.equal(failure.status, "fail", JSON.stringify(report));
      assert.equal(failure.category, category);
      assert.ok(failure.expected);
      assert.ok(failure.observed);
      assert.ok(failure.relevantFiles?.length);
      assert.ok(failure.recommendation?.length);
      if (options.badJoin) assert.equal(report.results.find((r) => r.id === "comments.threads")?.status, "pass", "independent HTTP check should still run");
    } finally { await f.cleanup(); }
  });

  for (const [options, id] of [[{ omitJoin: true }, "socket.joinProject"], [{ omitDoc: true }, "socket.joinDoc"]] as [FixtureOptions, string][]) it(`times out ${id} and closes the socket`, async () => {
    const f = await fixture(options);
    try {
      const started = Date.now();
      const report = await f.run({ timeoutMs: 100, compile: false });
      const failure = report.results.find((r) => r.id === id)!;
      assert.equal(failure.status, "fail");
      assert.equal(failure.category, "SOCKET_EVENT");
      assert.equal(failure.kind, "timeout");
      assert.match(failure.observed!, /100ms/);
      assert.ok(Date.now() - started < 2000);
    } finally { await f.cleanup(); }
  });

  it("supports legacy listing and fallback joinProject while bounding timers", async () => {
    const f = await fixture({ legacyProjects: true, fallbackJoin: true, log: "Output written on output.pdf" });
    try {
      const report = await f.run();
      assert.equal(report.counts.fail, 0, JSON.stringify(report));
      assert.equal(report.results.find((r) => r.id === "compile.log")?.status, "pass");
      assert.deepEqual(f.events, ["joinProject", "joinDoc"]);
      assert.ok(f.requests.some((r) => r.method === "GET" && r.path === "/user/projects"));
    } finally { await f.cleanup(); }
  });

  for (const [options, category] of [
    [{ closeBeforeJoin: true }, "SOCKET_TRANSPORT"],
    [{ connectionRejected: "invalid session" }, "AUTHENTICATION"],
    [{ connectionRejected: "service unavailable" }, "SOCKET_EVENT"],
    [{ type7: "invalid session" }, "AUTHENTICATION"],
    [{ type7: "protocol mismatch" }, "SOCKET_EVENT"],
  ] as [FixtureOptions, string][]) it(`early realtime rejection is classified ${category}`, async () => {
    const f = await fixture(options);
    try {
      const report = await f.run({ compile: false });
      const failure = report.results.find((r) => r.status === "fail")!;
      assert.equal(failure.category, category);
      assert.notEqual(failure.kind, "timeout");
    } finally { await f.cleanup(); }
  });

  for (const options of [{ projects: { projects: [] } }, { emptyDocs: true, missingRoot: true }, { missingRoot: true }, { threads: {}, ranges: [], optionsStatus: 404 }]) it(`honestly reports unavailable coverage ${JSON.stringify(options)}`, async () => {
    const f = await fixture(options);
    try {
      const report = await f.run();
      assert.equal(report.counts.fail, 0, JSON.stringify(report));
      if (options.projects) {
        assert.equal(report.results.find((r) => r.id === "socket.handshake")?.status, "skip");
        assert.ok(!f.requests.some((r) => r.path.includes("socket.io")));
      }
      if (options.emptyDocs) {
        assert.equal(report.results.find((r) => r.id === "socket.joinDoc")?.status, "skip");
        assert.equal(report.results.find((r) => r.id === "socket.projectTree")?.status, "pass");
        assert.match(report.results.find((r) => r.id === "socket.projectTree")!.summary, /0 documents, 0 assets/);
      }
      if (options.missingRoot) assert.equal(report.results.find((r) => r.id === "compile.response")?.status, "skip");
      if (options.threads) for (const id of ["comments.threads", "review.ranges", "upload.endpoint"]) assert.equal(report.results.find((r) => r.id === id)?.status, "partial");
    } finally { await f.cleanup(); }
  });

  it("--no-compile sends no build request; an unknown selected project fails without probing it", async () => {
    const f = await fixture();
    try {
      const safe = await f.run({ compile: false });
      assert.equal(safe.results.find((r) => r.id === "compile.response")?.status, "skip");
      assert.ok(!f.requests.some((r) => r.path.endsWith("/compile")));
      const report = await f.run({ projectId: "d".repeat(24) });
      assert.equal(report.results.find((r) => r.id === "http.projectSelection")?.status, "fail");
      assert.equal(report.results.find((r) => r.id === "socket.handshake")?.status, "skip");
    } finally { await f.cleanup(); }
  });

  it("does not claim a clean compile when HTTP 200 log text is empty or unrecognized", async () => {
    for (const log of ["", "unexpected upstream payload"]) {
      const f = await fixture({ log });
      try {
        const report = await f.run();
        assert.equal(report.results.find((r) => r.id === "compile.response")?.status, "pass");
        assert.equal(report.results.find((r) => r.id === "compile.log")?.status, "partial");
      } finally { await f.cleanup(); }
    }
  });
});

describe("CLI and credential-free failure paths", () => {
  it("keeps the documented npm diagnose entrypoint", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    assert.equal(pkg.scripts.diagnose, "node dist/diagnose.js");
  });

  it("validates flags and rejects unsupported write modes", () => {
    assert.equal(parseDiagnosticArgs(["--json", "--no-compile", "--project", projectId, "--timeout-ms", "200"]).timeoutMs, 200);
    for (const args of [["--full"], ["--write"], ["--project"], ["--timeout-ms", "0"], ["--compile-timeout-ms", "999999999"], ["--timeout-ms", "NaN"]]) assert.throws(() => parseDiagnosticArgs(args));
  });

  it("produces one JSON document and exit 2 on usage errors without starting MCP/browser", () => {
    const child = spawnSync(process.execPath, ["--import", "tsx", "src/diagnose.ts", "--json", "--write"], { encoding: "utf8", timeout: 5000 });
    assert.equal(child.status, 2, child.stderr);
    assert.equal(child.stderr, "");
    const report = JSON.parse(child.stdout);
    assert.equal(report.overall, "failed");
    assert.equal(report.results[0].category, "LOCAL_ENV");
  });

  it("missing credentials cause a single auth failure without browser launch", async () => {
    let loads = 0;
    const report = await runDiagnostics({ compile: false }, { cookiePath: () => fileURLToPath(import.meta.url), loadSession: async () => { loads++; return null; } });
    assert.equal(loads, 1);
    assert.equal(report.counts.fail, 1);
    assert.equal(report.results.find((r) => r.id === "env.session")?.category, "AUTHENTICATION");
    assert.equal(report.results.find((r) => r.id === "auth.session")?.status, "skip");
  });
});
