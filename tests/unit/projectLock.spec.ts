import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withProjectLock } from "../../src/tools/project.js";

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("withProjectLock", () => {
  it("runs project-scoped calls one at a time, in order", async () => {
    const log: string[] = [];
    const call = (name: string) => withProjectLock(async () => {
      log.push(`${name}:start`); await tick(); log.push(`${name}:end`); return name;
    });
    assert.deepEqual(await Promise.all([call("a"), call("b")]), ["a", "b"]);
    assert.deepEqual(log, ["a:start", "a:end", "b:start", "b:end"]);
  });

  it("keeps the queue moving after a failed call", async () => {
    await assert.rejects(withProjectLock(async () => { throw new Error("boom"); }), /boom/);
    assert.equal(await withProjectLock(async () => "next"), "next");
  });
});
