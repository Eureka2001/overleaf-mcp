// Read-only end-to-end history check. Uses existing versions and source only;
// never creates labels/files, edits TeX, restores history, flushes or compiles.
// Usage: node tests/manual/history-read.mjs <project-id> [from-version] [to-version] [comparison-path]
import assert from "node:assert/strict";
import { spawnMcp } from "./_mcp-client.mjs";
import { loadConfig } from "../../dist/config.js";
import { loadStored } from "../../dist/auth/cookieStore.js";
import { extractMeta } from "../../dist/session/identity.js";

const [projectId, fromArg, toArg, pathArg] = process.argv.slice(2);
if (!projectId || !/^[a-f\d]{24}$/i.test(projectId)) {
  console.error("Usage: node tests/manual/history-read.mjs <24-hex-project-id> [from-version] [to-version] [comparison-path]");
  process.exit(2);
}
const versionArg = (value) => {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("Version arguments must be nonnegative history integers.");
  return Number(value);
};
const fromInput = versionArg(fromArg), toInput = versionArg(toArg);
// Probes should not unexpectedly launch an authentication window.
const config = loadConfig();
const stored = await loadStored(config.baseUrl, true);
assert.ok(stored, "No stored session. Log in explicitly before this read-only check.");
const dashboard = await fetch(config.baseUrl + "/project", { headers: { Cookie: stored.cookie }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
assert.equal(dashboard.status, 200, "Session is unavailable; refresh login explicitly.");
assert.ok(extractMeta(await dashboard.text(), "ol-user_id"), "Stored session is not authenticated.");

const mcp = spawnMcp({ label: "history-read", env: { ...process.env, OL_MCP_LOG_LEVEL: "error" } });
const call = async (name, args) => {
  const result = await mcp.callTool(name, args);
  assert.equal(result.isError, false, `${name} failed: ${result.structured?.error?.code ?? "MCP error"}`);
  assert.ok(result.structured, `${name} did not return structuredContent`);
  return result.structured;
};
try {
  await mcp.init();
  const tools = (await mcp.call("tools/list", {})).result.tools;
  for (const name of ["list_history", "list_history_files", "read_history_file", "compare_versions"]) {
    assert.equal(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint, true);
  }
  await call("open_project", { project_id: projectId });
  const liveTreeBefore = await call("list_files", {});
  const history = await call("list_history", { limit: 2 });
  assert.ok(history.updates.length, "No history entries were available.");
  if (history.next_cursor) {
    const next = await call("list_history", { limit: 2, cursor: history.next_cursor });
    assert.ok(!next.updates.length || next.updates[0].to_version <= history.updates.at(-1).from_version, "History cursor skipped forward/overlapped.");
  }
  const labels = await call("list_history", { mode: "labels" });
  const from = fromInput ?? history.updates[0].from_version;
  const to = toInput ?? history.updates[0].to_version;
  const files = await call("list_history_files", { history_version: to, limit: 500 });
  const overview = await call("compare_versions", { from_version: from, to_version: to });
  const firstTextChange = overview.files.find((file) => file.operation === "edited" && file.editable !== false);
  const path = pathArg ?? firstTextChange?.comparison_path ?? files.files.find((file) => file.editable === true && file.path.endsWith(".tex"))?.path;
  assert.ok(path, "No text path is available. Pass a comparison-path explicitly.");
  const diff = await call("compare_versions", { from_version: from, to_version: to, path, max_chars: 1000 });
  assert.equal(diff.binary, false);
  if (diff.next_cursor) {
    const next = await call("compare_versions", { from_version: from, to_version: to, path, max_chars: 1000, cursor: diff.next_cursor });
    assert.ok(next.hunks.length, "Diff continuation did not advance.");
  }
  const snapshotPath = diff.to_path ?? diff.from_path;
  const snapshotVersion = diff.to_path ? to : from;
  const read = await call("read_history_file", { history_version: snapshotVersion, path: snapshotPath, max_chars: 1000 });
  assert.equal(typeof read.text, "string");
  assert.equal(read.history_version, snapshotVersion);
  if (read.truncated) {
    const next = await call("read_history_file", { history_version: snapshotVersion, path: snapshotPath,
      start_line: read.next_start_line, start_column: read.next_start_column, max_chars: 1000 });
    assert.ok(next.text.length);
  }
  assert.deepEqual(await call("list_files", {}), liveTreeBefore, "History replaced the live project tree.");
  // Emit metadata only: no private source, author emails or credentials.
  console.log(JSON.stringify({ passed: true, tool_count: tools.length, history_access: history.history_access,
    history_entries: history.count, labels: labels.count, from_version: from, to_version: to,
    historical_files: files.total_files, changed_files: overview.changed_files, diff_hunks: diff.total_hunks,
    diff_truncated: diff.truncated, read_chars: read.text.length, read_truncated: read.truncated,
    live_tree_preserved: true, project_writes: 0 }, null, 2));
} finally { mcp.kill(); }
