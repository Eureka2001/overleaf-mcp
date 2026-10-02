import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { searchDocuments, searchText, type SearchOptions } from "../../src/tools/searchProject.js";
import type { ActiveProject } from "../../src/session/activeProject.js";
import { clearDocCache, ensureDocLoaded, updateDoc } from "../../src/session/docCache.js";

const options = (query: string, changes: Partial<SearchOptions> = {}): SearchOptions => ({
  query, case_sensitive: false, context_lines: 1, max_results: 50, ...changes,
});

function project(): ActiveProject {
  return {
    projectId: "project", name: "test", trackChangesOnForMe: false,
    project: { _id: "project", rootFolder: [] },
    entities: [
      { id: "b", kind: "doc", path: "sec/b.tex", name: "b.tex", parentFolderId: "root" },
      { id: "a", kind: "doc", path: "a.bib", name: "a.bib", parentFolderId: "root" },
      { id: "image", kind: "file", path: "image.pdf", name: "image.pdf", parentFolderId: "root" },
      { id: "folder", kind: "folder", path: "sec", name: "sec", parentFolderId: "root" },
    ],
  };
}

afterEach(clearDocCache);

describe("literal project search positions and context", () => {
  it("matches LaTeX commands and regex punctuation literally", () => {
    const query = "\\label{fig:(a+b).*}";
    const result = searchText(`prefix ${query}\nwrong label`, options(query));
    assert.equal(result.total, 1);
    assert.equal(result.matches[0].column, 8);
    assert.equal(result.matches[0].match, query);
  });

  it("supports case-insensitive defaults and explicit case sensitivity", () => {
    const text = "ObjectNav objectnav OBJECTNAV";
    assert.equal(searchText(text, options("ObjectNav")).total, 3);
    assert.equal(searchText(text, options("ObjectNav", { case_sensitive: true })).total, 1);
  });

  it("returns one-based positions and an exclusive end position", () => {
    const match = searchText("intro\nxx target yy\nend", options("target")).matches[0];
    assert.deepEqual([match.line, match.column, match.end_line, match.end_column], [2, 4, 2, 10]);
    assert.deepEqual(match.context.map((line) => line.line), [1, 2, 3]);
  });

  it("keeps correct UTF-16 positions under Unicode case folding", () => {
    const match = searchText("😊 Kelvin", options("kelvin")).matches[0];
    assert.equal(match.column, 4);
    assert.equal(match.match, "Kelvin");
  });

  it("matches across lines and normalizes pasted CRLF queries", () => {
    const match = searchText("start line\nnext end", options("line\r\nnext", { context_lines: 0 })).matches[0];
    assert.deepEqual([match.line, match.column, match.end_line, match.end_column], [1, 7, 2, 5]);
    assert.equal(match.match, "line\nnext");
    assert.equal(match.context.length, 2);
  });

  it("returns no context neighbours when context_lines is zero", () => {
    const result = searchText("before\nneedle\nafter", options("needle", { context_lines: 0 }));
    assert.deepEqual(result.matches[0].context.map((line) => line.line), [2]);
  });

  it("counts all non-overlapping occurrences after the result cap", () => {
    const result = searchText("aaaa aa", options("aa", { max_results: 1 }));
    assert.equal(result.total, 3);
    assert.equal(result.matches.length, 1);
  });

  it("clips long lines around the matching location rather than losing the match", () => {
    const match = searchText("x".repeat(2000) + "needle" + "y".repeat(2000), options("needle")).matches[0];
    assert.equal(match.column, 2001);
    assert.ok(match.context[0].text.includes("needle"));
    assert.equal(match.context[0].text.length, 300);
    assert.equal(match.context[0].start_column, 1901);
    assert.equal(match.context[0].truncated, true);
  });

  it("bounds context even when a query spans many lines", () => {
    const query = Array.from({ length: 30 }, () => "x").join("\n");
    const match = searchText(query, options(query)).matches[0];
    assert.equal(match.context.length, 12);
    assert.equal(match.context_truncated, true);
    assert.deepEqual([match.context[0].line, match.context.at(-1)!.line], [1, 30]);
  });

  it("reports zero matches and rejects empty queries", () => {
    assert.deepEqual(searchText("abc", options("absent")), { matches: [], total: 0 });
    assert.throws(() => searchText("abc", options("")), /must not be empty/);
  });
});

describe("live document search aggregation", () => {
  it("skips binary assets, filters paths, and returns each live document version", async () => {
    const readIds: string[] = [];
    const result = await searchDocuments(project(), options("needle", { path_contains: "SEC/" }), async (id) => {
      readIds.push(id);
      return { docLines: ["needle"], version: 42, updates: [], ranges: null };
    });
    assert.deepEqual(readIds, ["b"]);
    assert.equal(result.matches[0].version, 42);
    assert.equal(result.matches[0].path, "sec/b.tex");
    assert.equal(result.complete, true);
  });

  it("applies one cap across files while still counting all matching files", async () => {
    const result = await searchDocuments(project(), options("needle", { max_results: 1 }), async () => ({
      docLines: ["needle needle"], version: 4, updates: [], ranges: null,
    }));
    assert.equal(result.total_matches, 4);
    assert.equal(result.returned_matches, 1);
    assert.equal(result.matches[0].path, "a.bib");
    assert.equal(result.files_matched, 2);
    assert.equal(result.truncated, true);
  });

  it("reports partial read failures alongside successful matches", async () => {
    const result = await searchDocuments(project(), options("needle"), async (id) => {
      if (id === "a") throw new Error("document inaccessible");
      return { docLines: ["needle"], version: 7, updates: [], ranges: null };
    });
    assert.equal(result.complete, false);
    assert.equal(result.files_searched, 1);
    assert.equal(result.total_matches, 1);
    assert.deepEqual(result.read_errors, [{ path: "a.bib", error: "document inaccessible" }]);
  });

  it("returns an empty complete result when no paths match", async () => {
    const result = await searchDocuments(project(), options("needle", { path_contains: "absent" }), async () => {
      throw new Error("reader must not be called");
    });
    assert.equal(result.complete, true);
    assert.equal(result.total_matches, 0);
    assert.equal(result.files_searched, 0);
  });

  it("does not replace read_file's pinned edit baseline with a search snapshot", async () => {
    updateDoc("b", "previously read content", 2);
    await searchDocuments(project(), options("needle", { path_contains: "sec/" }), async () => ({
      docLines: ["new needle"], version: 8, updates: [], ranges: null,
    }));
    const baseline = await ensureDocLoaded("b");
    assert.equal(baseline.text, "previously read content");
    assert.equal(baseline.version, 2);
  });
});
