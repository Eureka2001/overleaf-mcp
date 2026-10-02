// Live test: only uploads randomly named, unreferenced PNG assets. Cleans up
// those assets by verified ID and path; never edits documents or review data.
// Usage: node tests/manual/upload-search.mjs <project-id> [existing-folder]
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";
import { spawnMcp } from "./_mcp-client.mjs";
import { expectOk, olDelete, olPostJson } from "../../dist/api/http.js";

const projectId = process.argv[2];
const folder = process.argv[3] ?? "img";
if (!/^[a-f\d]{24}$/i.test(projectId ?? "")) throw new Error("Pass the intended project ID.");
const nonce = randomUUID();
const pathA = posix.join(folder, `mcp-test-${nonce}-a.png`);
const pathB = posix.join(folder, `mcp-test-${nonce}-b.png`);
const owned = new Map();
const dir = await mkdtemp(join(tmpdir(), "ol-upload-live-"));
const local = join(dir, "test.png");
const textLocal = join(dir, "test.tex");
const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG7sAAAAASUVORK5CYII=", "base64");
const replacement = Buffer.concat([bytes, Buffer.from("mcp-byte-verification")]);
const client = spawnMcp({ label: "upload-search-live-test", env: { ...process.env, OL_MCP_LOG_LEVEL: "warn" } });

async function call(name, args = {}) {
  let timer;
  try {
    const result = await Promise.race([
      client.callTool(name, args),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} timed out`)), 45000); }),
    ]);
    assert.equal(result.raw.error, undefined, JSON.stringify(result.raw.error));
    return result;
  } finally { clearTimeout(timer); }
}
function ok(result) { assert.equal(result.isError, false, result.text); return result.structured; }

let baseline;
let failure;
let uploadStarted = false;
try {
  await writeFile(local, bytes);
  await writeFile(textLocal, "% local fixture only\n");
  await client.init();
  const tools = await client.call("tools/list", {});
  for (const name of ["upload_file", "search_project", "download_pdf"]) assert.ok(tools.result.tools.some((tool) => tool.name === name));
  assert.equal((await call("search_project", { query: "test" })).isError, true);
  assert.equal((await call("upload_file", { local_path: local })).isError, true);
  const projects = ok(await call("list_projects", { limit: 500 }));
  assert.ok(projects.projects.some((project) => project.id === projectId));
  const opened = ok(await call("open_project", { project_id: projectId }));
  const root = opened.root_doc_path;
  assert.ok(root);
  const listed = ok(await call("list_files"));
  assert.ok(!folder || listed.entities.some((entity) => entity.kind === "folder" && entity.path === folder));
  assert.ok(!listed.entities.some((entity) => entity.path === pathA || entity.path === pathB));
  baseline = ok(await call("read_file", { path: root }));
  const search = ok(await call("search_project", { query: "\\documentclass", path_contains: root, case_sensitive: true, context_lines: 0 }));
  assert.equal(search.complete, true);
  const rootMatches = search.matches.filter((match) => match.path === root);
  assert.ok(rootMatches.length > 0);
  for (const match of rootMatches) {
    assert.equal(match.version, baseline.version);
    const line = baseline.text.split("\n")[match.line - 1];
    assert.equal(line.slice(match.column - 1, match.column - 1 + match.match.length), "\\documentclass");
  }
  const capped = ok(await call("search_project", { query: "\\", path_contains: ".tex", max_results: 1 }));
  assert.equal(capped.returned_matches, 1);
  assert.equal(capped.truncated, true);
  const absent = ok(await call("search_project", { query: nonce }));
  assert.equal(absent.total_matches, 0);
  assert.equal(absent.complete, true);
  console.log(JSON.stringify({ search: "passed", files_searched: absent.files_searched, capped_total: capped.total_matches }));

  assert.equal((await call("upload_file", { local_path: textLocal, project_path: "test.tex" })).isError, true);
  uploadStarted = true;
  const first = ok(await call("upload_file", { local_path: local, project_path: pathA }));
  owned.set(pathA, first.file_id);
  assert.equal(first.verified, true);
  assert.equal(first.bytes, bytes.length);
  let tree = ok(await call("list_files"));
  assert.equal(tree.entities.find((entity) => entity.path === pathA)?.id, first.file_id);
  let remote = ok(await call("read_file", { path: pathA }));
  assert.deepEqual(Buffer.from(remote.base64, "base64"), bytes);

  await writeFile(local, replacement);
  const blocked = await call("upload_file", { local_path: local, project_path: pathA });
  assert.equal(blocked.isError, true);
  remote = ok(await call("read_file", { path: pathA }));
  assert.deepEqual(Buffer.from(remote.base64, "base64"), bytes);
  const overwritten = ok(await call("upload_file", { local_path: local, project_path: pathA, overwrite: true }));
  owned.set(pathA, overwritten.file_id);
  assert.equal(overwritten.overwritten, true);
  assert.equal(overwritten.verified, true);
  remote = ok(await call("read_file", { path: pathA }));
  assert.deepEqual(Buffer.from(remote.base64, "base64"), replacement);

  const second = ok(await call("upload_file", { local_path: local, project_path: pathB }));
  owned.set(pathB, second.file_id);
  // Verify the actual server's atomic name-conflict guard that protects the
  // tool's default temporary-upload/rename sequence from concurrent uploads.
  const rename = await olPostJson(`project/${projectId}/file/${second.file_id}/rename`, { name: posix.basename(pathA) });
  assert.equal(rename.ok, false, "Overleaf allowed a duplicate rename");
  remote = ok(await call("read_file", { path: pathA }));
  assert.deepEqual(Buffer.from(remote.base64, "base64"), replacement);
  const after = ok(await call("read_file", { path: root }));
  assert.equal(after.version, baseline.version);
  assert.equal(after.text, baseline.text);
  console.log(JSON.stringify({ upload: "passed", default_collision: "blocked", rename_collision_status: rename.status, overwrite: "verified", document_unchanged: true }));
} catch (error) {
  failure = error;
} finally {
  try {
    if (uploadStarted) {
      // Refresh before cleanup, even after a failed response; trust neither a
      // stale tree nor an ID that now belongs to a different path.
      ok(await call("search_project", { query: nonce, path_contains: nonce }));
      const tree = ok(await call("list_files"));
      for (const path of [pathA, pathB]) {
        const entity = tree.entities.find((item) => item.path === path);
        if (!entity) continue;
        assert.equal(entity.kind, "file");
        assert.ok(entity.name.includes(nonce));
        if (owned.has(path)) assert.equal(entity.id, owned.get(path));
        await expectOk(await olDelete(`project/${projectId}/file/${entity.id}`), "delete own live-test PNG");
      }
      ok(await call("search_project", { query: nonce, path_contains: nonce }));
      const finalTree = ok(await call("list_files"));
      assert.ok(!finalTree.entities.some((entity) => entity.path === pathA || entity.path === pathB));
      console.log(JSON.stringify({ cleanup: "passed", remaining_test_assets: 0 }));
    }
  } catch (error) {
    console.error(`Cleanup failed; inspect only test paths ${pathA}, ${pathB}: ${error.message}`);
    failure ??= error;
  } finally {
    client.kill();
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith("ol-upload-live-"));
    await rm(dir, { recursive: true, force: true });
  }
}
if (failure) throw failure;
