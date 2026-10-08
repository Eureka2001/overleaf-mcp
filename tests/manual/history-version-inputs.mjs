// Read-only regression check for MCP clients that stringify union version inputs.
// Usage: node tests/manual/history-version-inputs.mjs <project-id> <read-version> <from-version> <to-version> <path> [start-line] [end-line]
import assert from "node:assert/strict";
import { spawnMcp } from "./_mcp-client.mjs";
import { loadConfig } from "../../dist/config.js";
import { loadStored } from "../../dist/auth/cookieStore.js";
import { extractMeta } from "../../dist/session/identity.js";

const [projectId, readArg, fromArg, toArg, path, startArg, endArg] = process.argv.slice(2);
if (!projectId || !/^[a-f\d]{24}$/i.test(projectId) || !path || !readArg || !fromArg || !toArg) {
  console.error("Usage: node tests/manual/history-version-inputs.mjs <project-id> <read-version> <from-version> <to-version> <path> [start-line] [end-line]");
  process.exit(2);
}
const integer = (value, minimum = 0) => {
  const number = Number(value);
  assert.ok(/^\d+$/.test(value) && Number.isSafeInteger(number) && number >= minimum, "Expected a decimal safe integer.");
  return number;
};
const readVersion = integer(readArg), from = integer(fromArg), to = integer(toArg);
const startLine = startArg === undefined ? 1 : integer(startArg, 1);
const endLine = endArg === undefined ? undefined : integer(endArg, 1);

// Confirm a valid stored session before any tool can trigger login recovery.
const config = loadConfig();
const stored = await loadStored(config.baseUrl, true);
assert.ok(stored, "No stored session. Log in explicitly before this read-only check.");
const dashboard = await fetch(config.baseUrl + "/project", {
  headers: { Cookie: stored.cookie }, redirect: "manual", signal: AbortSignal.timeout(15_000),
});
assert.equal(dashboard.status, 200, "Stored session is unavailable; refresh login explicitly.");
assert.ok(extractMeta(await dashboard.text(), "ol-user_id"), "Stored session is not authenticated.");

const mcp = spawnMcp({ label: "history-version-inputs", env: { ...process.env, OL_MCP_LOG_LEVEL: "error" } });
const deadline = setTimeout(() => {
  console.error("History version input check exceeded its 120-second deadline.");
  mcp.kill();
  process.exit(1);
}, 120_000);
const call = async (name, args) => {
  const result = await mcp.callTool(name, args);
  assert.equal(result.raw.error, undefined, `${name}: JSON-RPC error`);
  assert.equal(result.isError, false, `${name}: ${result.structured?.error?.code ?? "MCP input/tool error"}`);
  assert.ok(result.structured, `${name} did not return structuredContent`);
  return result.structured;
};
try {
  await mcp.init();
  await call("open_project", { project_id: projectId });
  const liveTree = await call("list_files", {});
  const readArgs = { path, start_line: startLine, ...(endLine === undefined ? {} : { end_line: endLine }), max_chars: 20_000 };
  const read = await call("read_history_file", { ...readArgs, history_version: readVersion });
  assert.equal(read.history_version, readVersion);
  assert.deepEqual(await call("read_history_file", { ...readArgs, history_version: String(readVersion) }), read);
  const diffArgs = { from_version: from, path, context_lines: 0, max_chars: 45_000 };
  const diff = await call("compare_versions", { ...diffArgs, to_version: to });
  assert.equal(diff.to_version, to);
  assert.deepEqual(await call("compare_versions", { ...diffArgs, to_version: String(to) }), diff);
  const files = await call("list_history_files", { history_version: readVersion });
  assert.equal(files.history_version, readVersion);
  assert.deepEqual(await call("list_history_files", { history_version: String(readVersion) }), files);
  for (const name of ["read_history_file", "compare_versions", "list_history_files"]) {
    const args = name === "read_history_file" ? { ...readArgs, history_version: "latest" } :
      name === "compare_versions" ? { ...diffArgs, to_version: "latest" } : { history_version: "latest" };
    const latest = await call(name, args);
    assert.equal(typeof (name === "compare_versions" ? latest.to_version : latest.history_version), "number");
  }
  assert.deepEqual(await call("list_files", {}), liveTree, "Historical reads replaced the live file tree.");
  // Emit metadata only; no private TeX, credentials or author information.
  console.log(JSON.stringify({ passed: true, read_version: readVersion, read_chars: read.text.length,
    from_version: from, to_version: to, diff_hunks: diff.total_hunks, historical_files: files.total_files,
    numeric_string_results_match: true, latest_inputs_pass: true, live_tree_preserved: true, project_writes: 0 }, null, 2));
} finally {
  clearTimeout(deadline);
  mcp.kill();
}
