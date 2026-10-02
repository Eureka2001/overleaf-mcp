import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { buildOutputUrl } from "../../src/tools/compile.js";
import { checkPdfDestination, savePdfResponse, validatePdfPath } from "../../src/tools/downloadPdf.js";

const PDF = "%PDF-1.7\nfixture bytes\n%%EOF\n";
const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "overleaf-pdf-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith("overleaf-pdf-test-"));
    return rm(dir, { recursive: true, force: true });
  }));
});

describe("compiled output download routing", () => {
  it("includes the CLSI worker and compile group for PDF downloads", () => {
    assert.equal(
      buildOutputUrl({ path: "output.pdf", url: "/project/id/build/build-id/output/output.pdf" }, {
        clsiServerId: "worker 1",
        compileGroup: "group/2",
      }),
      "project/id/build/build-id/output/output.pdf?clsiserverid=worker+1&compileGroup=group%2F2",
    );
  });

  it("preserves existing output URL query parameters", () => {
    assert.equal(
      buildOutputUrl({ path: "output.pdf", url: "/output.pdf?download=true" }, { clsiServerId: "worker" }),
      "output.pdf?download=true&clsiserverid=worker",
    );
  });

  it("works when the compile response has no routing parameters", () => {
    assert.equal(buildOutputUrl({ path: "output.pdf", url: "/output.pdf" }, {}), "output.pdf");
  });
});

describe("validatePdfPath", () => {
  it("rejects a relative path rather than writing to the server's working directory", () => {
    assert.throws(() => validatePdfPath("paper.pdf"), /absolute local path/);
  });

  it("rejects a non-PDF destination", () => {
    assert.throws(() => validatePdfPath(resolve("notes.tex")), /end in \.pdf/);
  });

  it("accepts an absolute path with uppercase PDF extension", () => {
    const path = resolve("paper.PDF");
    assert.equal(validatePdfPath(path), path);
  });
});

describe("checkPdfDestination", () => {
  it("allows a new PDF destination before starting the network request", async () => {
    const path = join(await tempDir(), "nested", "paper.pdf");
    assert.equal(await checkPdfDestination(path), path);
    await assert.rejects(stat(path), { code: "ENOENT" });
  });

  it("refuses an existing file before starting the network request", async () => {
    const path = join(await tempDir(), "paper.pdf");
    await writeFile(path, "original PDF");
    await assert.rejects(checkPdfDestination(path), { code: "EEXIST" });
    assert.equal(await readFile(path, "utf8"), "original PDF");
  });

  it("permits an existing destination when overwrite is explicitly true", async () => {
    const path = join(await tempDir(), "paper.pdf");
    await writeFile(path, "original PDF");
    assert.equal(await checkPdfDestination(path, true), path);
  });
});

describe("savePdfResponse", () => {
  it("creates missing parent directories and saves exact PDF bytes", async () => {
    const path = join(await tempDir(), "nested", "论文.pdf");
    const size = await savePdfResponse(new Response(PDF), path);
    assert.equal(size, Buffer.byteLength(PDF));
    assert.equal(await readFile(path, "utf8"), PDF);
  });

  it("preserves an existing PDF by default", async () => {
    const path = join(await tempDir(), "paper.pdf");
    await writeFile(path, "original PDF");
    await assert.rejects(savePdfResponse(new Response(PDF), path), { code: "EEXIST" });
    assert.equal(await readFile(path, "utf8"), "original PDF");
  });

  it("only replaces an existing file when overwrite is explicitly true", async () => {
    const path = join(await tempDir(), "paper.pdf");
    await writeFile(path, "original PDF");
    await savePdfResponse(new Response(PDF), path, true);
    assert.equal(await readFile(path, "utf8"), PDF);
  });

  it("rejects an HTML response before creating the destination", async () => {
    const path = join(await tempDir(), "paper.pdf");
    const response = new Response("<html>login page</html>", { headers: { "content-type": "application/pdf" } });
    await assert.rejects(savePdfResponse(response, path), /not a PDF/);
    await assert.rejects(stat(path), { code: "ENOENT" });
  });

  it("preserves an existing file on an invalid response even with overwrite enabled", async () => {
    const path = join(await tempDir(), "paper.pdf");
    await writeFile(path, "original PDF");
    await assert.rejects(savePdfResponse(new Response("<html>error</html>"), path, true), /not a PDF/);
    assert.equal(await readFile(path, "utf8"), "original PDF");
  });

  it("rejects an expired build HTTP response without writing a file", async () => {
    const path = join(await tempDir(), "paper.pdf");
    await assert.rejects(savePdfResponse(new Response("Expired build", { status: 404 }), path), /404/);
    await assert.rejects(stat(path), { code: "ENOENT" });
  });

  it("rejects an empty response without creating a file", async () => {
    const path = join(await tempDir(), "paper.pdf");
    await assert.rejects(savePdfResponse(new Response(""), path), /not a PDF/);
    await assert.rejects(stat(path), { code: "ENOENT" });
  });
});
