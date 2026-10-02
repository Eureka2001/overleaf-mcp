import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { assetMime, MAX_UPLOAD_BYTES, parseUploadResponse, readLocalAsset, resolveUploadTarget, uploadAsset, uploadForm, type UploadTransport } from "../../src/tools/uploadFile.js";
import type { ActiveProject } from "../../src/session/activeProject.js";
import type { FlatEntity } from "../../src/api/projectTypes.js";

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith("ol-upload-unit-"));
    await rm(dir, { recursive: true, force: true });
  }
});

function fixture() {
  const rootId = "111111111111111111111111";
  const folderId = "222222222222222222222222";
  const baseEntities: FlatEntity[] = [
    { id: folderId, name: "img", path: "img", kind: "folder", parentFolderId: rootId },
    { id: "333333333333333333333333", name: "main.tex", path: "main.tex", kind: "doc", parentFolderId: rootId },
  ];
  const ap: ActiveProject = {
    projectId: "444444444444444444444444", name: "unit", trackChangesOnForMe: true,
    project: { _id: "444444444444444444444444", rootFolder: [{ _id: rootId, name: "root", folders: [], docs: [], fileRefs: [] }] },
    entities: [...baseEntities],
  };
  const files = new Map<string, { entity: FlatEntity; bytes: Buffer }>();
  const calls: { op: string; id?: string; name?: string }[] = [];
  let sequence = 16;
  const add = (name: string, bytes: Buffer, parentFolderId = folderId) => {
    const id = (++sequence).toString(16).padStart(24, "0");
    const path = parentFolderId === rootId ? name : `img/${name}`;
    files.set(id, { entity: { id, name, path, kind: "file", parentFolderId }, bytes: Buffer.from(bytes) });
    return id;
  };
  const transport: UploadTransport = {
    refresh: async () => { ap.entities = [...baseEntities, ...[...files.values()].map((file) => ({ ...file.entity }))]; },
    upload: async (folder, name, bytes) => {
      calls.push({ op: "upload", name });
      const previous = [...files.entries()].find(([, file]) => file.entity.parentFolderId === folder && file.entity.name === name);
      if (previous) files.delete(previous[0]);
      const id = add(name, bytes, folder);
      return { success: true, entity_id: id, entity_type: "file" };
    },
    rename: async (id, name) => {
      calls.push({ op: "rename", id, name });
      const file = files.get(id)!;
      if ([...files.values()].some((other) => other !== file && other.entity.parentFolderId === file.entity.parentFolderId && other.entity.name.toLowerCase() === name.toLowerCase())) {
        throw new Error("name already exists");
      }
      file.entity.name = name;
      file.entity.path = file.entity.parentFolderId === rootId ? name : `img/${name}`;
    },
    download: async (id) => Buffer.from(files.get(id)!.bytes),
    remove: async (id) => { calls.push({ op: "remove", id }); files.delete(id); },
  };
  return { ap, files, calls, add, transport, baseEntities };
}

describe("upload input and multipart contract", () => {
  it("supports graphics and fonts while rejecting editable text and archives", () => {
    assert.equal(assetMime("plot.PDF"), "application/pdf");
    assert.equal(assetMime("font.woff2"), "font/woff2");
    for (const name of ["main.tex", "refs.bib", "style.sty", "notes.md", "data.csv", "project.zip"]) assert.throws(() => assetMime(name), /tracked editing/);
  });

  it("uses Overleaf's name and qqfile multipart fields with unchanged bytes", async () => {
    const bytes = Buffer.from([0, 128, 255, 10]);
    const form = uploadForm(bytes, "plot.png", "image/png");
    assert.deepEqual([...form.keys()], ["name", "qqfile"]);
    assert.equal(form.get("name"), "plot.png");
    const file = form.get("qqfile") as File;
    assert.equal(file.name, "plot.png");
    assert.equal(file.type, "image/png");
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
  });

  it("requires a confirmed binary entity rather than trusting any HTTP success", () => {
    assert.deepEqual(parseUploadResponse({ success: true, entity_id: "a".repeat(24), entity_type: "file" }), { id: "a".repeat(24) });
    for (const response of [null, {}, { success: false, error: "quota exceeded" }, { success: true, entity_id: "invalid", entity_type: "file" }, { success: true, entity_id: "a".repeat(24), entity_type: "doc" }]) assert.throws(() => parseUploadResponse(response));
  });

  it("rejects relative paths, directories, empty assets and oversized files before upload", async () => {
    await assert.rejects(readLocalAsset("plot.png"), /absolute/);
    const dir = await mkdtemp(join(tmpdir(), "ol-upload-unit-"));
    tempDirs.push(dir);
    const path = join(dir, "plot.png");
    await writeFile(path, "");
    await assert.rejects(readLocalAsset(path), /nonempty/);
    const handle = await open(path, "w");
    try { await handle.truncate(MAX_UPLOAD_BYTES + 1); } finally { await handle.close(); }
    await assert.rejects(readLocalAsset(path), /50 MiB/);
    const directoryAsset = join(dir, "folder.png");
    await mkdir(directoryAsset);
    await assert.rejects(readLocalAsset(directoryAsset), /regular file/);
    await writeFile(path, Buffer.from([1, 2, 3]));
    assert.deepEqual(await readLocalAsset(path), Buffer.from([1, 2, 3]));
  });

  it("rejects path traversal and missing folders without creating a folder", async () => {
    const f = fixture();
    for (const path of ["/x.png", "img\\x.png", "../x.png", "img/../x.png", "img//x.png", "img/x.png/", "img/ x.png", "C:/x.png"]) assert.throws(() => resolveUploadTarget(f.ap, path, false));
    await assert.rejects(uploadAsset(f.ap, Buffer.from("asset"), "missing/x.png", false, f.transport), /folder/);
    assert.equal(f.calls.length, 0);
  });

  it("does not replace a document or folder even when overwrite is explicit", () => {
    const f = fixture();
    f.ap.entities.push({ id: "doc", name: "text.svg", path: "img/text.svg", kind: "doc", parentFolderId: f.baseEntities[0].id });
    f.ap.entities.push({ id: "folder", name: "nested.pdf", path: "img/nested.pdf", kind: "folder", parentFolderId: f.baseEntities[0].id });
    assert.throws(() => resolveUploadTarget(f.ap, "img/text.svg", true), /editable document or folder/);
    assert.throws(() => resolveUploadTarget(f.ap, "img/nested.pdf", true), /editable document or folder/);
  });
});

describe("verified binary upload and failure recovery", () => {
  const bytes = Buffer.from("binary-test-asset");

  it("stages, verifies, renames and exposes the final file in the refreshed tree", async () => {
    const f = fixture();
    const result = await uploadAsset(f.ap, bytes, "img/plot.png", false, f.transport);
    assert.equal(result.path, "img/plot.png");
    assert.equal(result.bytes, bytes.length);
    assert.equal(result.verified, true);
    assert.equal(result.overwritten, false);
    assert.match(result.sha256, /^[a-f\d]{64}$/);
    assert.match(f.calls[0].name!, /^mcp-upload-[a-f\d-]+\.png$/);
    assert.deepEqual(f.calls.map((call) => call.op), ["upload", "rename"]);
    assert.equal(f.ap.entities.find((entity) => entity.id === result.file_id)?.path, "img/plot.png");
    assert.deepEqual(f.files.get(result.file_id)?.bytes, bytes);
  });

  it("refuses existing and case-insensitive collisions before sending bytes", async () => {
    const f = fixture();
    const id = f.add("Plot.png", Buffer.from("original"));
    await assert.rejects(uploadAsset(f.ap, bytes, "img/plot.png", false, f.transport), /already exists/);
    await assert.rejects(uploadAsset(f.ap, bytes, "img/plot.png", true, f.transport), /exact path/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.files.get(id)?.bytes.toString(), "original");
  });

  it("only replaces a binary asset after explicit overwrite", async () => {
    const f = fixture();
    f.add("plot.png", Buffer.from("original"));
    const result = await uploadAsset(f.ap, bytes, "img/plot.png", true, f.transport);
    assert.equal(result.overwritten, true);
    assert.equal(f.calls[0].name, "plot.png");
    assert.deepEqual(f.calls.map((call) => call.op), ["upload"]);
    assert.equal(f.files.size, 1);
    assert.deepEqual(f.files.get(result.file_id)?.bytes, bytes);
  });

  it("preserves a concurrently created destination and deletes only its own temporary file", async () => {
    const f = fixture();
    const rename = f.transport.rename;
    let winner: string;
    f.transport.rename = async (id, name) => { winner = f.add(name, Buffer.from("collaborator")); await rename(id, name); };
    await assert.rejects(uploadAsset(f.ap, bytes, "img/plot.png", false, f.transport), /temporary asset was removed/);
    assert.equal(f.files.size, 1);
    assert.equal(f.files.get(winner!)?.bytes.toString(), "collaborator");
    assert.notEqual(f.calls.find((call) => call.op === "remove")?.id, winner!);
  });

  it("cleans up corrupted bytes before a final name is assigned", async () => {
    const f = fixture();
    f.transport.download = async () => Buffer.from("corrupted");
    await assert.rejects(uploadAsset(f.ap, bytes, "img/plot.png", false, f.transport), /do not match/);
    assert.equal(f.files.size, 0);
    assert.deepEqual(f.calls.map((call) => call.op), ["upload", "remove"]);
  });

  it("recovers a lost rename acknowledgement only after checking final bytes", async () => {
    const f = fixture();
    const rename = f.transport.rename;
    f.transport.rename = async (id, name) => { await rename(id, name); throw new Error("connection lost after rename"); };
    const result = await uploadAsset(f.ap, bytes, "img/plot.png", false, f.transport);
    assert.equal(result.verified, true);
    assert.equal(f.calls.some((call) => call.op === "remove"), false);
  });

  it("removes its unique temporary asset when the upload response is lost or invalid", async () => {
    for (const loseResponse of [false, true]) {
      const f = fixture();
      const upload = f.transport.upload;
      f.transport.upload = async (...args) => { await upload(...args); if (loseResponse) throw new Error("lost response"); return {}; };
      await assert.rejects(uploadAsset(f.ap, bytes, "img/plot.png", false, f.transport), /temporary asset was removed/);
      assert.equal(f.files.size, 0);
    }
  });

  it("reports an exact temporary path if cleanup fails", async () => {
    const f = fixture();
    f.transport.download = async () => { throw new Error("verification unavailable"); };
    f.transport.remove = async () => { throw new Error("delete denied"); };
    await assert.rejects(uploadAsset(f.ap, bytes, "img/plot.png", false, f.transport), /Inspect 'img\/mcp-upload-[a-f\d-]+\.png'/);
    assert.equal(f.files.size, 1);
  });

  it("keeps a final file if verification later fails and reports uncertainty", async () => {
    const f = fixture();
    const rename = f.transport.rename;
    f.transport.rename = async (id, name) => { await rename(id, name); f.files.get(id)!.bytes = Buffer.from("concurrent change"); throw new Error("rename acknowledgement lost"); };
    await assert.rejects(uploadAsset(f.ap, bytes, "img/plot.png", false, f.transport), /asset remains at 'img\/plot.png'/);
    assert.equal(f.files.size, 1);
    assert.equal(f.calls.some((call) => call.op === "remove"), false);
  });

  it("never deletes a possibly replaced destination after explicit overwrite fails", async () => {
    const f = fixture();
    f.add("plot.png", Buffer.from("original"));
    f.transport.download = async () => Buffer.from("different");
    await assert.rejects(uploadAsset(f.ap, bytes, "img/plot.png", true, f.transport), /may have changed 'img\/plot.png'/);
    assert.equal(f.files.size, 1);
    assert.equal(f.calls.some((call) => call.op === "remove"), false);
  });
});
