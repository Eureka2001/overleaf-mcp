import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveActiveProject, type ActiveProject } from "../../src/session/activeProject.js";

const project = (projectId: string): ActiveProject => ({
  projectId, name: projectId, project: {} as ActiveProject["project"],
  entities: [], trackChangesOnForMe: false,
});
const session = (current: ActiveProject | null, open: (id: string) => Promise<ActiveProject>) => ({
  getActiveProject: () => current, open,
});
const unexpectedOpen = async (): Promise<ActiveProject> => {
  assert.fail("implicit or cached selection should not open a project");
};

describe("resolveActiveProject", () => {
  it("preserves missing-project behavior without an explicit id", async () => {
    assert.equal(await resolveActiveProject(undefined, session(null, unexpectedOpen)), null);
  });
  it("preserves implicit selection of the current project", async () => {
    const current = project("project-a");
    assert.equal(await resolveActiveProject(undefined, session(current, unexpectedOpen)), current);
  });
  it("reuses the matching project without reopening and clearing its doc cache", async () => {
    const current = project("project-a");
    assert.equal(await resolveActiveProject("project-a", session(current, unexpectedOpen)), current);
  });
  it("opens the requested project in a fresh session", async () => {
    const requested = project("project-a");
    const calls: string[] = [];
    const result = await resolveActiveProject("project-a", session(null, async (id) => {
      calls.push(id); return requested;
    }));
    assert.equal(result, requested);
    assert.deepEqual(calls, ["project-a"]);
  });
  it("switches away from a different cached project", async () => {
    const requested = project("project-b");
    const calls: string[] = [];
    const result = await resolveActiveProject("project-b", session(project("project-a"), async (id) => {
      calls.push(id); return requested;
    }));
    assert.equal(result, requested);
    assert.deepEqual(calls, ["project-b"]);
  });
  it("propagates open failures instead of returning the wrong project", async () => {
    const failure = new Error("access denied");
    await assert.rejects(
      resolveActiveProject("project-b", session(project("project-a"), async () => { throw failure; })),
      (err) => err === failure,
    );
  });
});
