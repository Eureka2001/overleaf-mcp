import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { HistoryClient, readHistoryBody } from "../../src/api/history.js";
import { OverleafAuthError } from "../../src/api/errors.js";
import { olGet } from "../../src/api/http.js";
import { CompareVersionsSchema, createHistoryHandlers, ListHistoryFilesSchema, ReadHistoryFileSchema, registerHistory } from "../../src/tools/history.js";
import { clearDocCache, ensureDocLoaded, updateDoc } from "../../src/session/docCache.js";
import type { ActiveProject } from "../../src/session/activeProject.js";
import { encodeCursor } from "../../src/history/cursor.js";
import { formatHistoryDiff, sliceHistoryText, snapshotDiff } from "../../src/history/diff.js";
import { HistoryVersionSchema, type HistoryFile } from "../../src/api/historyTypes.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const PROJECT = "a".repeat(24);
const NOW = Date.UTC(2026, 9, 5, 4);
const meta = { users: [{ id: "author", first_name: "Test", last_name: "Author" }, null], start_ts: NOW - 1000, end_ts: NOW };
const oldMeta = { ...meta, start_ts: NOW - 3 * 86_400_000, end_ts: NOW - 3 * 86_400_000 + 1000 };
const unchangedStart = Array.from({ length: 50 }, (_, i) => `UNCHANGED_HEADER_${i}\n`).join("");
const unchangedEnd = Array.from({ length: 50 }, (_, i) => `UNCHANGED_FOOTER_${i}\n`).join("");
const oldMain = unchangedStart + "Old modified paragraph.\n" + unchangedEnd;
const newMain = unchangedStart + "New modified paragraph.\n" + unchangedEnd;
const specialPath = "chapters/中文 & # % intro.tex";

function project(versioning: boolean | undefined = true): ActiveProject {
  return { projectId: PROJECT, name: "fixture", trackChangesOnForMe: true,
    project: { _id: PROJECT, rootFolder: [], features: versioning === undefined ? undefined : { versioning } },
    entities: [{ id: "live-doc", path: "current.tex", name: "current.tex", kind: "doc", parentFolderId: "root" }],
    rootDocId: "live-doc", rootDocPath: "current.tex", lastCompile: { status: "success", outputFiles: [] } };
}
const oldTree: HistoryFile[] = [
  { pathname: "main.tex", editable: true }, { pathname: "chapters/old.tex", editable: true },
  { pathname: "removed.tex", editable: true }, { pathname: "image.pdf", editable: false },
  { pathname: "empty.tex", editable: true }, { pathname: specialPath, editable: true },
];
const newTree: HistoryFile[] = [
  { pathname: "main.tex", editable: true }, { pathname: "chapters/new.tex", editable: true },
  { pathname: "added.tex", editable: true }, { pathname: "image.pdf", editable: false },
  { pathname: "empty.tex", editable: true }, { pathname: specialPath, editable: true },
];
const rangeTree: HistoryFile[] = [
  { pathname: "main.tex", operation: "edited" },
  { pathname: "chapters/old.tex", newPathname: "chapters/new.tex", operation: "renamed", editable: true },
  { pathname: "removed.tex", operation: "removed", deletedAtV: 4, editable: true },
  { pathname: "added.tex", operation: "added", editable: true },
  { pathname: "image.pdf", operation: "edited", editable: false },
  { pathname: "empty.tex", editable: true }, { pathname: specialPath, editable: true },
];

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { clearDocCache(); await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

interface FixtureOptions {
  versioning?: boolean;
  missingFeature?: boolean;
  updates?: unknown[];
  labels?: unknown[];
  snapshots?: Map<string, string>;
  rangeTree?: HistoryFile[];
  intercept?: (url: URL, req: IncomingMessage, res: ServerResponse) => boolean;
  onRequest?: (url: URL) => void;
  timeoutMs?: number;
  maxJsonBytes?: number;
}
async function fixture(options: FixtureOptions = {}) {
  const requests: { method: string; url: URL; cookie: string | undefined }[] = [];
  const snapshots = options.snapshots ?? new Map([
    ["3:main.tex", oldMain], ["6:main.tex", newMain], ["3:chapters/old.tex", "Old title\n"], ["6:chapters/new.tex", "New title\n"],
    ["3:removed.tex", "Deleted TeX body\n"], ["6:added.tex", "Added TeX body\n"],
    ["3:empty.tex", ""], ["6:empty.tex", ""], ["3:" + specialPath, "\\section{旧版}\n"], ["6:" + specialPath, "\\section{新版}\n"],
  ]);
  const updates = options.updates ?? Array.from({ length: 6 }, (_, i) => ({ fromV: 5 - i, toV: 6 - i, meta: i === 0 ? meta : oldMeta,
    labels: [], pathnames: ["main.tex"], project_ops: [] }));
  const labels = options.labels ?? [
    { id: "label-a", version: 2, comment: "Submitted", created_at: new Date(NOW - 10_000).toISOString(), user_display_name: "Test Author", user_id: "author" },
    { id: "label-b", version: 2, comment: "Another name", created_at: new Date(NOW).toISOString(), user_display_name: "Test Author", user_id: "author" },
  ];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://fixture");
    requests.push({ method: req.method!, url, cookie: req.headers.cookie });
    options.onRequest?.(url);
    if (options.intercept?.(url, req, res)) return;
    const send = (body: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const endpoint = url.pathname.replace(`/project/${PROJECT}/`, "");
    if (req.method !== "GET") { send({ unexpected_write: true }, 405); return; }
    if (endpoint === "updates") {
      const before = url.searchParams.has("before") ? Number(url.searchParams.get("before")) : Infinity;
      send({ updates: (updates as any[]).filter((entry) => entry.toV <= before), nextBeforeTimestamp: null });
    } else if (endpoint === "labels") send(labels);
    else if (endpoint === "filetree/diff") {
      const from = Number(url.searchParams.get("from")), to = Number(url.searchParams.get("to"));
      send({ diff: from === to ? from === 6 ? newTree : oldTree : options.rangeTree ?? rangeTree });
    } else if (endpoint === "diff") {
      const from = Number(url.searchParams.get("from")), to = Number(url.searchParams.get("to")), path = url.searchParams.get("pathname")!;
      if (path === "image.pdf") { send({ diff: { binary: true } }); return; }
      if (from === to) {
        const value = snapshots.get(`${from}:${path}`) ?? (from === 2 ? snapshots.get(`3:${path}`) : undefined);
        send({ diff: value === undefined ? [] : [{ u: value }] });
      } else if (path === "main.tex") send({ diff: [{ u: unchangedStart }, { d: "Old modified paragraph.\n", meta },
        { i: "New modified paragraph.\n", meta }, { u: unchangedEnd }] });
      else if (path === "chapters/old.tex") send({ diff: [{ d: "Old title\n", meta }, { i: "New title\n", meta }] });
      else send({ diff: [] });
    } else send({ unknown_endpoint: true }, 404);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((err) => err ? reject(err) : resolve()); }));
  const address = server.address() as { port: number };
  const context = { identity: { baseUrl: `http://127.0.0.1:${address.port}`, cookie: "session=fixture-only", csrf: "fixture-csrf", userId: "fixture-user", userEmail: "" } };
  const client = new HistoryClient(PROJECT, { context, timeoutMs: options.timeoutMs, maxJsonBytes: options.maxJsonBytes });
  const ap = project(options.missingFeature ? undefined : options.versioning ?? true);
  if (options.missingFeature) delete ap.project.features;
  let active: ActiveProject | null = ap;
  const handlers = createHistoryHandlers({ getProject: () => active, createClient: () => client, now: () => NOW });
  return { requests, client, context, handlers, ap, switchProject: (next: ActiveProject | null) => { active = next; } };
}
function payload(result: Awaited<ReturnType<ReturnType<typeof createHistoryHandlers>["list_history"]>>): any {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return result.structuredContent;
}
function errorCode(result: Awaited<ReturnType<ReturnType<typeof createHistoryHandlers>["list_history"]>>): string {
  assert.equal(result.isError, true);
  return (result.structuredContent.error as { code: string }).code;
}

async function mcpFixture(options: FixtureOptions = {}) {
  const f = await fixture(options);
  const server = new McpServer({ name: "history-fixture", version: "1.0" });
  // Use production registrations and SDK validation with the local HTTP fixture.
  registerHistory({
    registerTool(name: keyof typeof f.handlers, config: Parameters<McpServer["registerTool"]>[1]) {
      return server.registerTool(name, config, f.handlers[name]);
    },
  } as unknown as McpServer);
  const client = new Client({ name: "history-test", version: "1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanups.push(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.ok(result.structuredContent);
    return result.structuredContent as Record<string, any>;
  };
  return { ...f, client, call };
}

describe("history version inputs through MCP", () => {
  const versionSchemas = [ListHistoryFilesSchema.shape.history_version,
    ReadHistoryFileSchema.shape.history_version, CompareVersionsSchema.shape.to_version];
  const invalidVersions = ["", " ", " 6", "6 ", "6\n", "-1", "+6", "6.0", "6.5", "6e0", "0x6",
    "Infinity", "NaN", "LATEST", "9007199254740992", "9".repeat(400), -1, 6.5, Infinity, NaN,
    Number.MAX_SAFE_INTEGER + 1, true, null, {}, []];

  it("normalizes decimal strings and preserves safe integer boundaries", () => {
    for (const schema of versionSchemas) {
      for (const version of [0, 6, Number.MAX_SAFE_INTEGER]) {
        assert.equal(schema.parse(version), version);
        assert.equal(schema.parse(String(version)), version);
      }
      assert.equal(schema.parse("0006"), 6);
      assert.equal(schema.parse("latest"), "latest");
      for (const value of invalidVersions) assert.equal(schema.safeParse(value).success, false, String(value));
    }
    assert.equal(CompareVersionsSchema.parse({ from_version: 3 }).to_version, "latest");
    assert.equal(HistoryVersionSchema.safeParse("6").success, false, "API response versions remain numeric");
    assert.equal(CompareVersionsSchema.safeParse({ from_version: "3", to_version: 6 }).success, false);
  });

  it("advertises numeric, latest and decimal-string inputs in tools/list", async () => {
    const f = await mcpFixture();
    const { tools } = await f.client.listTools();
    for (const [name, field] of [["list_history_files", "history_version"],
      ["read_history_file", "history_version"], ["compare_versions", "to_version"]]) {
      const schema = tools.find((tool) => tool.name === name)!.inputSchema.properties![field] as { anyOf: Record<string, unknown>[] };
      assert.ok(schema.anyOf.some((branch) => branch.type === "integer"));
      assert.ok(schema.anyOf.some((branch) => branch.const === "latest"));
      assert.ok(schema.anyOf.some((branch) => branch.type === "string" && branch.pattern === "^\\d+$"));
    }
    assert.equal(f.requests.length, 0);
  });

  it("reads and compares numeric and stringified versions after SDK validation", async () => {
    const f = await mcpFixture();
    for (const version of [6, "6", "latest"]) {
      const files = await f.call("list_history_files", { history_version: version });
      assert.equal(files.history_version, 6);
      const read = await f.call("read_history_file", { history_version: version, path: "main.tex" });
      assert.equal(read.history_version, 6);
      assert.equal(read.text, newMain);
      const diff = await f.call("compare_versions", { from_version: 3, to_version: version, path: "main.tex", context_lines: 0 });
      assert.equal(diff.to_version, 6);
      assert.equal(diff.content_changed, true);
      assert.ok(diff.hunks.length);
    }
    const old = await f.call("read_history_file", { history_version: "3", path: "main.tex", start_line: 51, end_line: 51 });
    assert.equal(old.history_version, 3);
    assert.ok(old.text.includes("Old modified paragraph."));
    assert.equal((await f.call("compare_versions", { from_version: 3 })).to_version, 6);
    assert.ok(f.requests.every((request) => request.method === "GET"));
  });

  it("uses normalized versions when validating and resuming fixed-version cursors", async () => {
    const f = await mcpFixture();
    const files = await f.call("list_history_files", { history_version: "6", limit: 1 });
    const nextFiles = await f.call("list_history_files", { history_version: 6, limit: 1, cursor: files.next_cursor });
    assert.equal(nextFiles.history_version, 6);
    assert.notDeepEqual(nextFiles.files, files.files);
    const diff = await f.call("compare_versions", { from_version: 3, to_version: 6, limit: 1 });
    const nextDiff = await f.call("compare_versions", { from_version: 3, to_version: "6", limit: 1, cursor: diff.next_cursor });
    assert.equal(nextDiff.to_version, 6);
    assert.notDeepEqual(nextDiff.files, diff.files);
    const wrongVersion = await f.client.callTool({ name: "list_history_files",
      arguments: { history_version: "3", cursor: files.next_cursor } });
    assert.equal((wrongVersion.structuredContent?.error as { code: string }).code, "INVALID_CURSOR");
  });

  it("rejects invalid version inputs before sending HTTP requests", async () => {
    const f = await mcpFixture();
    for (const value of invalidVersions.filter((version) => typeof version !== "number" || Number.isFinite(version))) {
      for (const [name, args] of [["list_history_files", { history_version: value }],
        ["read_history_file", { history_version: value, path: "main.tex" }],
        ["compare_versions", { from_version: 3, to_version: value }]] as const) {
        const result = await f.client.callTool({ name, arguments: args });
        assert.equal(result.isError, true);
        assert.ok(JSON.stringify(result.content).includes("Input validation error"));
      }
    }
    assert.equal(f.requests.length, 0);
  });

  it("applies history access restrictions after normalizing a string version", async () => {
    const f = await mcpFixture({ versioning: false });
    const result = await f.client.callTool({ name: "read_history_file", arguments: { history_version: "3", path: "main.tex" } });
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent?.error as { code: string }).code, "HISTORY_ACCESS_LIMITED");
    assert.equal(f.requests.some((request) => request.url.pathname.endsWith("/diff")), false);
  });
});

describe("history pagination and versions", () => {
  it("repaginates an oversized API page without skipping updates", async () => {
    const f = await fixture();
    const versions: number[] = [];
    let cursor: string | null = null;
    do {
      const page = payload(await f.handlers.list_history({ limit: 2, ...(cursor ? { cursor } : {}) }));
      versions.push(...page.updates.map((update: any) => update.to_version));
      cursor = page.next_cursor;
    } while (cursor);
    assert.deepEqual(versions, [6, 5, 4, 3, 2, 1]);
    assert.deepEqual(f.requests.filter((r) => r.url.pathname.endsWith("updates") && r.url.searchParams.has("before")).map((r) => r.url.searchParams.get("before")), ["4", "2"]);
  });
  it("lists multiple labels at one version without skipping either", async () => {
    const f = await fixture();
    const first = payload(await f.handlers.list_history({ mode: "labels", limit: 1 }));
    const second = payload(await f.handlers.list_history({ mode: "labels", limit: 1, cursor: first.next_cursor }));
    assert.deepEqual([first.labels[0].label_id, second.labels[0].label_id], ["label-a", "label-b"]);
    assert.equal(second.next_cursor, null);
    assert.equal(first.labels[0].history_version, 2);
  });
  it("pins latest across historical file pagination and rejects other projects/modes", async () => {
    const f = await fixture();
    const first = payload(await f.handlers.list_history_files({ history_version: "latest", limit: 1 }));
    const next = payload(await f.handlers.list_history_files({ history_version: "latest", limit: 1, cursor: first.next_cursor }));
    assert.equal(next.history_version, 6);
    assert.equal(errorCode(await f.handlers.list_history({ cursor: first.next_cursor })), "INVALID_CURSOR");
    assert.equal(errorCode(await f.handlers.list_history_files({ history_version: 3, cursor: first.next_cursor })), "INVALID_CURSOR");
    assert.equal(errorCode(await f.handlers.list_history({ cursor: encodeCursor({ kind: "updates", project_id: "other", before: 3 }) })), "INVALID_CURSOR");
  });
  it("keeps a cursor's fixed snapshot when latest advances between calls", async () => {
    let advanced = false;
    const f = await fixture({ intercept(url, _req, res) {
      if (!advanced || !url.pathname.endsWith("updates")) return false;
      res.end(JSON.stringify({ updates: [{ fromV: 6, toV: 7, meta, labels: [], pathnames: [], project_ops: [] }], nextBeforeTimestamp: null }));
      return true;
    } });
    const first = payload(await f.handlers.list_history_files({ history_version: "latest", limit: 1 }));
    advanced = true;
    const next = payload(await f.handlers.list_history_files({ history_version: "latest", limit: 1, cursor: first.next_cursor }));
    assert.equal(next.history_version, 6);
    assert.ok(f.requests.filter((r) => r.url.pathname.endsWith("filetree/diff")).every((r) => r.url.searchParams.get("from") === "6"));
  });
  it("budgets metadata pages and flags omitted collections without corrupting paths", async () => {
    const paths = Array.from({ length: 80 }, (_, i) => `${i}/` + "章节".repeat(200) + ".tex");
    const updates = Array.from({ length: 10 }, (_, i) => ({ fromV: 9 - i, toV: 10 - i, meta, labels: [], pathnames: paths, project_ops: [] }));
    const f = await fixture({ updates });
    const first = payload(await f.handlers.list_history({ limit: 100 }));
    assert.equal(first.truncated, true);
    assert.ok(first.updates.every((update: any) => update.paths_truncated && update.paths.every((path: string) => paths.includes(path))));
    assert.ok(JSON.stringify(first.updates).length <= 20_000);
    assert.ok(first.next_cursor);
  });
  it("rejects malformed or nonadvancing cursors and missing response fields", async () => {
    const f = await fixture({ intercept(url, _req, res) {
      if (!url.pathname.endsWith("updates")) return false;
      res.end(JSON.stringify({ updates: [{ fromV: 5, toV: 6, meta, labels: [], pathnames: [], project_ops: [] }], nextBeforeTimestamp: 6 })); return true;
    } });
    assert.equal(errorCode(await f.handlers.list_history({})), "HISTORY_PROTOCOL_ERROR");
    assert.equal(errorCode(await f.handlers.list_history({ cursor: "h1.not-json" })), "INVALID_CURSOR");
    const broken = await fixture({ intercept(url, _req, res) { if (!url.pathname.endsWith("updates")) return false; res.end('{}'); return true; } });
    assert.equal(errorCode(await broken.handlers.list_history({})), "HISTORY_PROTOCOL_ERROR");
  });
  it("reports empty/legacy history without inventing version zero", async () => {
    const f = await fixture({ updates: [] });
    const listed = payload(await f.handlers.list_history({}));
    assert.equal(listed.history_available, false);
    assert.equal(errorCode(await f.handlers.read_history_file({ history_version: "latest", path: "main.tex" })), "HISTORY_UNAVAILABLE");
  });
});

describe("historical TeX source and cache isolation", () => {
  it("reads an old/deleted file and preserves current tree, compile and edit baseline", async () => {
    const f = await fixture();
    updateDoc("live-doc", "Pinned live text", 42);
    const before = structuredClone(f.ap);
    const read = payload(await f.handlers.read_history_file({ history_version: 3, path: "removed.tex" }));
    assert.equal(read.text, "Deleted TeX body\n");
    assert.equal(read.history_version, 3);
    assert.equal(read.version, undefined);
    assert.deepEqual(await ensureDocLoaded("live-doc"), { docId: "live-doc", text: "Pinned live text", version: 42 });
    assert.deepEqual(f.ap, before);
    await f.handlers.compare_versions({ from_version: 3, to_version: 6, path: "main.tex" });
    await f.handlers.list_history_files({ history_version: 3 });
    assert.deepEqual(await ensureDocLoaded("live-doc"), { docId: "live-doc", text: "Pinned live text", version: 42 });
    assert.deepEqual(f.ap, before);
    assert.ok(f.requests.every((request) => request.method === "GET" && /\/(updates|labels|diff|filetree\/diff)$/.test(request.url.pathname)));
    assert.ok(f.requests.every((request) => request.cookie === "session=fixture-only"));
  });
  it("encodes Unicode, spaces, ampersands, hashes and percent signs as one pathname", async () => {
    const f = await fixture();
    const read = payload(await f.handlers.read_history_file({ history_version: 3, path: specialPath }));
    assert.equal(read.text, "\\section{旧版}\n");
    assert.equal(f.requests.find((r) => r.url.pathname === `/project/${PROJECT}/diff`)!.url.searchParams.get("pathname"), specialPath);
    assert.equal(f.requests.find((r) => r.url.pathname === `/project/${PROJECT}/diff`)!.url.hash, "");
  });
  it("distinguishes empty text, missing files and binary assets", async () => {
    const f = await fixture();
    assert.equal(payload(await f.handlers.read_history_file({ history_version: 3, path: "empty.tex" })).text, "");
    assert.equal(errorCode(await f.handlers.read_history_file({ history_version: 6, path: "removed.tex" })), "HISTORY_PATH_NOT_FOUND");
    assert.equal(errorCode(await f.handlers.read_history_file({ history_version: 3, path: "image.pdf" })), "BINARY_HISTORY_FILE");
    assert.equal(errorCode(await f.handlers.read_history_file({ history_version: 3, path: "../main.tex" })), "INVALID_PATH");
  });
  it("continues a long Unicode paragraph without skipping or splitting a surrogate pair", async () => {
    const text = "😀中\\".repeat(1000) + "\nEnd";
    let line = 1, column = 1, rebuilt = "";
    while (true) {
      const slice = sliceHistoryText(text, line, undefined, column, 1001);
      rebuilt += slice.text;
      assert.ok(!/[\uD800-\uDBFF]$/.test(slice.text));
      if (!slice.truncated) break;
      line = slice.next_start_line!; column = slice.next_start_column!;
    }
    assert.equal(rebuilt, text);
    assert.equal(sliceHistoryText("a\nb\nc", 2, 2, 1, 1000).text, "b\n");
    assert.throws(() => sliceHistoryText("a", 2, undefined, 1, 1000), /range/);
  });
  it("fails cleanly if the active project changes while retaining captured request identity", async () => {
    let f: Awaited<ReturnType<typeof fixture>>;
    f = await fixture({ onRequest() { if (f) f.switchProject({ ...f.ap, projectId: "other" }); } });
    assert.equal(errorCode(await f.handlers.read_history_file({ history_version: 3, path: "main.tex" })), "PROJECT_CHANGED");
    assert.ok(f.requests.every((r) => r.url.pathname.startsWith(`/project/${PROJECT}/`)));
  });
});

describe("compact history comparison", () => {
  it("returns only changed-file metadata until a specific file is requested", async () => {
    const f = await fixture();
    const overview = payload(await f.handlers.compare_versions({ from_version: 3, to_version: 6 }));
    assert.equal(overview.changed_files, 5);
    assert.equal(overview.files.some((file: any) => file.comparison_path === "empty.tex"), false);
    assert.deepEqual(overview.counts, { added: 1, removed: 1, edited: 2, renamed: 1 });
    assert.equal(f.requests.some((r) => r.url.pathname === `/project/${PROJECT}/diff`), false);
    assert.equal(JSON.stringify(overview).includes("UNCHANGED_HEADER"), false);
  });
  it("shows modified paragraphs with accurate line numbers and limited context", async () => {
    const f = await fixture();
    const result = await f.handlers.compare_versions({ from_version: 3, to_version: 6, path: "main.tex", context_lines: 2 });
    const diff = payload(result);
    assert.equal(diff.hunks.length, 1);
    assert.equal(diff.hunks[0].old_start, 49);
    assert.equal(diff.hunks[0].new_start, 49);
    assert.equal(diff.hunks[0].lines.filter((line: any) => line.kind === "context").length, 4);
    assert.equal(diff.hunks[0].lines.find((line: any) => line.kind === "delete").old_line, 51);
    assert.equal(diff.hunks[0].lines.find((line: any) => line.kind === "insert").new_line, 51);
    assert.equal(diff.attribution_available, true);
    assert.ok(result.content[0].text.includes("-Old modified paragraph."));
    assert.ok(result.content[0].text.includes("+New modified paragraph."));
    assert.equal(JSON.stringify(result).includes("UNCHANGED_HEADER_0\\n"), false);
    assert.equal(JSON.stringify(result).includes("UNCHANGED_FOOTER_49"), false);
  });
  it("separates distant changes into hunks and preserves endpoint line numbering", () => {
    const middle = Array.from({ length: 30 }, (_, i) => `middle ${i}\n`).join("");
    const before = "old one\n" + middle + "old two\n";
    const after = "new one\nextra\n" + middle + "new two\n";
    const view = formatHistoryDiff(snapshotDiff(before, after), 1, 20_000);
    assert.equal(view.hunks.length, 2);
    assert.equal(view.hunks[0].old_start, 1);
    assert.equal(view.hunks[1].old_start, 31);
    assert.equal(view.hunks[1].new_start, 32);
    assert.equal(view.hunks[1].lines.find((line) => line.kind === "delete")!.old_line, 32);
    assert.equal(view.hunks[1].lines.find((line) => line.kind === "insert")!.new_line, 33);
  });
  it("handles whole-file additions, deletions and renamed-plus-edited text", async () => {
    const f = await fixture();
    const added = payload(await f.handlers.compare_versions({ from_version: 3, to_version: 6, path: "added.tex", context_lines: 0 }));
    assert.equal(added.from_exists, false);
    assert.equal(added.hunks[0].lines[0].kind, "insert");
    assert.equal(added.hunks[0].lines[0].text, "Added TeX body\n");
    const removed = payload(await f.handlers.compare_versions({ from_version: 3, to_version: 6, path: "removed.tex" }));
    assert.equal(removed.to_exists, false);
    assert.equal(removed.hunks[0].lines[0].kind, "delete");
    const renamed = payload(await f.handlers.compare_versions({ from_version: 3, to_version: 6, path: "chapters/new.tex" }));
    assert.equal(renamed.comparison_path, "chapters/old.tex");
    assert.equal(renamed.from_path, "chapters/old.tex");
    assert.equal(renamed.to_path, "chapters/new.tex");
    assert.equal(renamed.content_changed, true);
    const binary = payload(await f.handlers.compare_versions({ from_version: 3, to_version: 6, path: "image.pdf" }));
    assert.equal(binary.binary, true); assert.deepEqual(binary.hunks, []);
  });
  it("keeps binary comparisons metadata-only when editable is omitted", async () => {
    const f = await fixture({ intercept(url, _req, res) {
      if (!url.pathname.endsWith("filetree/diff")) return false;
      const from = Number(url.searchParams.get("from")), to = Number(url.searchParams.get("to"));
      const tree = from === to ? from === 6 ? newTree : oldTree : rangeTree;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ diff: tree.map(({ editable: _editable, ...file }) => file) }));
      return true;
    } });
    const binary = payload(await f.handlers.compare_versions({ from_version: 3, to_version: 6, path: "image.pdf" }));
    assert.equal(binary.binary, true);
    assert.equal(binary.editable, false);
    assert.deepEqual(binary.hunks, []);
    assert.equal(binary.next_cursor, null);
    assert.equal(errorCode(await f.handlers.read_history_file({ history_version: 3, path: "image.pdf" })), "BINARY_HISTORY_FILE");
  });
  it("reports an unchanged file/equal versions without expanding its body", async () => {
    const f = await fixture();
    assert.equal(payload(await f.handlers.compare_versions({ from_version: 6, to_version: 6 })).changed_files, 0);
    const diff = payload(await f.handlers.compare_versions({ from_version: 6, to_version: 6, path: "main.tex" }));
    assert.equal(diff.content_changed, false); assert.deepEqual(diff.hunks, []);
    assert.equal(errorCode(await f.handlers.compare_versions({ from_version: 6, to_version: 3 })), "INVALID_VERSION_RANGE");
  });
  it("continues a truncated diff with exact fragments and no leaked unchanged body", () => {
    const old = "😀旧".repeat(1600) + "\n", now = "😀新".repeat(1600) + "\n";
    const chunks = snapshotDiff(old, now);
    let next: any, deleted = "", inserted = "", pages = 0;
    do {
      const view = formatHistoryDiff(chunks, 0, 1000, next);
      assert.ok(view.hunks.length > 0);
      for (const hunk of view.hunks) for (const line of hunk.lines) {
        if (line.kind === "delete") deleted += line.text;
        if (line.kind === "insert") inserted += line.text;
      }
      next = view.next;
      assert.ok(++pages < 100);
    } while (next);
    assert.equal(deleted, old); assert.equal(inserted, now);
  });
  it("binds diff cursors to arguments and pins latest to an actual history version", async () => {
    const long = "x".repeat(10_000) + "\n";
    const f = await fixture({ snapshots: new Map([["3:removed.tex", long]]) });
    const first = payload(await f.handlers.compare_versions({ from_version: 3, path: "removed.tex", max_chars: 1000 }));
    assert.equal(first.to_version, 6); assert.equal(first.truncated, true);
    const next = payload(await f.handlers.compare_versions({ from_version: 3, path: "removed.tex", max_chars: 1000, cursor: first.next_cursor }));
    assert.ok(next.hunks[0].lines[0].start_column > 1);
    assert.equal(errorCode(await f.handlers.compare_versions({ from_version: 3, path: "removed.tex", context_lines: 1, cursor: first.next_cursor })), "INVALID_CURSOR");
  });
  it("falls back to two same-path snapshots for a too-wide range, without invented authors", async () => {
    const f = await fixture({ intercept(url, _req, res) {
      if (!url.pathname.endsWith("filetree/diff") || url.searchParams.get("from") === url.searchParams.get("to")) return false;
      res.writeHead(400); res.end("Diff spans too many chunks"); return true;
    } });
    assert.equal(errorCode(await f.handlers.compare_versions({ from_version: 3, to_version: 6 })), "RANGE_TOO_LARGE");
    const diff = payload(await f.handlers.compare_versions({ from_version: 3, to_version: 6, path: "main.tex" }));
    assert.equal(diff.diff_source, "snapshot_fallback"); assert.equal(diff.attribution_available, false);
    assert.equal(diff.content_changed, true);
    assert.equal(errorCode(await f.handlers.compare_versions({ from_version: 3, to_version: 6, path: "removed.tex" })), "RANGE_TOO_LARGE");
  });
  it("also falls back if only the text-diff endpoint rejects a wide interval", async () => {
    const f = await fixture({ intercept(url, _req, res) {
      if (url.pathname !== `/project/${PROJECT}/diff` || url.searchParams.get("from") === url.searchParams.get("to")) return false;
      res.writeHead(400); res.end("Diff spans too many chunks"); return true;
    } });
    const diff = payload(await f.handlers.compare_versions({ from_version: 3, to_version: 6, path: "main.tex" }));
    assert.equal(diff.diff_source, "snapshot_fallback"); assert.equal(diff.file_identity_verified, false);
    assert.equal(diff.attribution_available, false);
    assert.equal(errorCode(await f.handlers.compare_versions({ from_version: 3, to_version: 6, path: "chapters/old.tex" })), "RANGE_TOO_LARGE");
  });
  it("refuses an ambiguous reused pathname and reports transient files without fabricating text", async () => {
    const f = await fixture({ rangeTree: [
      { pathname: "main.tex", operation: "removed", editable: true }, { pathname: "main.tex", operation: "added", editable: true },
      { pathname: "transient.tex", operation: "removed", editable: true },
    ] });
    assert.equal(errorCode(await f.handlers.compare_versions({ from_version: 3, to_version: 6, path: "main.tex" })), "AMBIGUOUS_HISTORY_PATH");
    const transient = payload(await f.handlers.compare_versions({ from_version: 3, to_version: 6, path: "transient.tex" }));
    assert.equal(transient.from_exists, false); assert.equal(transient.to_exists, false);
    assert.equal(transient.content_changed, false); assert.deepEqual(transient.hunks, []);
  });
  it("refuses inconsistent native diffs rather than showing misleading source", async () => {
    const f = await fixture({ intercept(url, _req, res) {
      if (!url.pathname.endsWith("/diff") || url.pathname.endsWith("filetree/diff") || url.searchParams.get("from") === url.searchParams.get("to")) return false;
      res.end(JSON.stringify({ diff: [{ d: "wrong old" }, { i: "wrong new" }] })); return true;
    } });
    assert.equal(errorCode(await f.handlers.compare_versions({ from_version: 3, to_version: 6, path: "main.tex" })), "HISTORY_INCONSISTENT_DIFF");
  });
});

describe("history access and transport boundaries", () => {
  it("enforces recent and labeled versions even when HTTP endpoints are permissive", async () => {
    const f = await fixture({ versioning: false });
    const listed = payload(await f.handlers.list_history({}));
    assert.equal(listed.count, 1); assert.equal(listed.access_limit_reached, true);
    assert.equal(errorCode(await f.handlers.read_history_file({ history_version: 3, path: "main.tex" })), "HISTORY_ACCESS_LIMITED");
    assert.equal(f.requests.some((r) => r.url.searchParams.get("from") === "3"), false);
    assert.equal(payload(await f.handlers.read_history_file({ history_version: 2, path: "main.tex" })).history_version, 2);
    assert.equal(payload(await f.handlers.read_history_file({ history_version: "latest", path: "main.tex" })).text, newMain);
    assert.equal(payload(await f.handlers.compare_versions({ from_version: 5, to_version: 6 })).from_version, 5);
  });
  it("preserves unknown entitlement and permits only confirmed recent/labeled snapshots", async () => {
    const f = await fixture({ missingFeature: true });
    assert.equal(payload(await f.handlers.list_history({})).history_access, "unknown");
    assert.equal(errorCode(await f.handlers.read_history_file({ history_version: 3, path: "main.tex" })), "HISTORY_ACCESS_LIMITED");
  });
  it("does not classify history 403 as expired auth or expose the server body", async () => {
    const f = await fixture({ intercept(url, _req, res) {
      if (!url.pathname.endsWith("labels")) return false;
      res.writeHead(403); res.end("private body csrf=secret-dont-print"); return true;
    } });
    const result = await f.handlers.list_history({ mode: "labels" });
    assert.equal(errorCode(result), "HISTORY_FORBIDDEN");
    assert.equal(JSON.stringify(result).includes("secret-dont-print"), false);
    assert.equal(f.requests.length, 1);
    const raw = await olGet(`project/${PROJECT}/labels`, {}, { ...f.context, forbiddenIsPermission: true });
    assert.equal(raw.status, 403); await raw.body?.cancel();
    await assert.rejects(olGet(`project/${PROJECT}/labels`, {}, f.context), OverleafAuthError);
  });
  for (const status of [401, 404, 429, 500]) it(`reports HTTP ${status} without exposing response data`, async () => {
    const f = await fixture({ intercept(_url, _req, res) { res.writeHead(status); res.end("cookie=secret response text"); return true; } });
    const result = await f.handlers.list_history({});
    assert.equal(errorCode(result), status === 401 ? "AUTHENTICATION_REQUIRED" : status === 404 ? "HISTORY_NOT_FOUND" : status === 429 ? "RATE_LIMITED" : "HISTORY_HTTP_ERROR");
    assert.equal(JSON.stringify(result).includes("secret response"), false);
  });
  it("bounds response bodies and covers timeouts including body reads", async () => {
    const f = await fixture({ maxJsonBytes: 32 });
    assert.equal(errorCode(await f.handlers.list_history({})), "RESPONSE_TOO_LARGE");
    await assert.rejects(readHistoryBody(new Response("x".repeat(100)), 50), /size limit/);
    const slow = await fixture({ timeoutMs: 40, intercept(_url, _req, res) {
      res.writeHead(200, { "content-type": "application/json" }); res.write('{"updates":'); return true;
    } });
    assert.equal(errorCode(await slow.handlers.list_history({})), "HISTORY_TIMEOUT");
  });
  it("rejects oversized source separately from JSON and rejects invalid UTF-8", async () => {
    const f = await fixture({ snapshots: new Map([["3:main.tex", "中".repeat(800_000)]]) });
    assert.equal(errorCode(await f.handlers.read_history_file({ history_version: 3, path: "main.tex" })), "TEXT_TOO_LARGE");
    await assert.rejects(readHistoryBody(new Response(new Uint8Array([0xff, 0xfe])), 100), /valid UTF-8/);
  });
  it("rejects mixed chunk variants and invalid JSON with a redacted protocol error", async () => {
    const f = await fixture({ intercept(url, _req, res) {
      if (!url.pathname.endsWith("/diff") || url.pathname.endsWith("filetree/diff")) return false;
      res.end(JSON.stringify({ diff: [{ u: "secret-old", i: "secret-new" }] })); return true;
    } });
    const result = await f.handlers.read_history_file({ history_version: 3, path: "main.tex" });
    assert.equal(errorCode(result), "HISTORY_PROTOCOL_ERROR");
    assert.equal(JSON.stringify(result).includes("secret-old"), false);
    const malformed = await fixture({ intercept(_url, _req, res) { res.end("<html>private</html>"); return true; } });
    assert.equal(errorCode(await malformed.handlers.list_history({})), "PROTOCOL_ERROR");
  });
  it("registers four read-only tools with existing naming and argument conventions", () => {
    const registrations: any[] = [];
    registerHistory({ registerTool(...args: any[]) { registrations.push(args); } } as unknown as McpServer);
    assert.deepEqual(registrations.map((tool) => tool[0]), ["list_history", "list_history_files", "read_history_file", "compare_versions"]);
    assert.ok(registrations.every((tool) => tool[1].annotations.readOnlyHint === true));
    assert.ok(registrations.find((tool) => tool[0] === "read_history_file")[1].inputSchema.path);
  });
  it("requires an open project before any history request", async () => {
    const handlers = createHistoryHandlers({ getProject: () => null });
    assert.equal(errorCode(await handlers.list_history({})), "NO_PROJECT");
  });
});
