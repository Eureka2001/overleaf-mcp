#!/usr/bin/env node
// Read-only Overleaf end-to-end test; writes only the requested local PDF.
// node tests/manual/download-pdf.mjs <project_id> <absolute-output.pdf> [root_doc]
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { spawnMcp } from "./_mcp-client.mjs";

const [projectId, outputPath, rootDoc = "main.tex"] = process.argv.slice(2);
if (!projectId || !outputPath || !isAbsolute(outputPath)) {
  console.error("usage: download-pdf.mjs <project_id> <absolute-output.pdf> [root_doc]");
  process.exit(2);
}

const client = spawnMcp({ label: "download-pdf-test" });
const timeout = setTimeout(() => {
  console.error("download-pdf-test timed out");
  client.kill();
  process.exit(1);
}, 180_000);

try {
  await client.init();
  const tools = await client.call("tools/list", {});
  assert.ok(tools.result.tools.some((tool) => tool.name === "download_pdf"));

  const unopened = await client.callTool("download_pdf", { output_path: outputPath });
  assert.equal(unopened.isError, true);
  assert.match(unopened.text, /No project is open/);

  // Match the normal project-discovery workflow before opening.
  const projects = await client.callTool("list_projects", { limit: 100 });
  assert.equal(projects.isError, false, projects.text);
  assert.ok(projects.structured.projects.some((project) => project.id === projectId));
  const opened = await client.callTool("open_project", { project_id: projectId });
  assert.equal(opened.isError, false, opened.text);

  const uncompiled = await client.callTool("download_pdf", { output_path: outputPath });
  assert.equal(uncompiled.isError, true);
  assert.match(uncompiled.text, /Call compile first/);

  const compiled = await client.callTool("compile", { root_doc: rootDoc, draft: false, stop_on_first_error: true });
  assert.equal(compiled.isError, false, compiled.text);
  assert.equal(compiled.structured.built_cleanly, true, compiled.text);
  console.log(JSON.stringify({ step: "compile", root_doc: rootDoc, ...compiled.structured }));

  const relative = await client.callTool("download_pdf", { output_path: "relative.pdf" });
  assert.equal(relative.isError, true);
  assert.match(relative.text, /absolute local path/);

  const downloaded = await client.callTool("download_pdf", { output_path: outputPath });
  assert.equal(downloaded.isError, false, downloaded.text);
  assert.equal(downloaded.structured.output_path, resolve(outputPath));
  const bytes = await readFile(outputPath);
  assert.equal(bytes.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.equal(bytes.length, downloaded.structured.bytes);

  const duplicate = await client.callTool("download_pdf", { output_path: outputPath });
  assert.equal(duplicate.isError, true);
  assert.match(duplicate.text, /Destination already exists/);
  assert.deepEqual(await readFile(outputPath), bytes);
  console.log(JSON.stringify({ step: "download", ...downloaded.structured, checks: "registration, no-project, no-compile, absolute-path, PDF-signature, bytes, no-overwrite" }));
} finally {
  clearTimeout(timeout);
  client.kill();
}
