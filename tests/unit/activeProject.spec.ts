import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProjectSelector, type ActiveProject } from "../../src/session/activeProject.js";

const project = (projectId: string): ActiveProject => ({
  projectId, name: projectId, project: {} as ActiveProject["project"],
  entities: [], trackChangesOnForMe: false,
});

/** In-memory stand-in for the module-level session: open() switches `active`. */
function fakeSession(initial: ActiveProject | null = null, fail?: Error) {
  const opened: string[] = [];
  let active = initial;
  return {
    opened,
    session: {
      getActiveProject: () => active,
      open: async (id: string) => {
        if (fail) throw fail;
        opened.push(id);
        active = project(id);
        return active;
      },
    },
  };
}

async function resolvedId(selector: ProjectSelector, id: string | undefined, access: "read" | "write") {
  const r = await selector.resolve(id, access);
  return r.ok ? r.ap.projectId : `refused: ${r.error}`;
}

describe("ProjectSelector", () => {
  it("refuses without an open project or explicit id", async () => {
    const { session } = fakeSession();
    const r = await new ProjectSelector(session).resolve(undefined, "read");
    assert.equal(r.ok, false);
  });

  it("opens the requested project in a fresh session", async () => {
    const { session, opened } = fakeSession();
    assert.equal(await resolvedId(new ProjectSelector(session), "project-a", "read"), "project-a");
    assert.deepEqual(opened, ["project-a"]);
  });

  it("reuses the matching project without reopening and clearing its doc cache", async () => {
    const { session, opened } = fakeSession();
    const selector = new ProjectSelector(session);
    await selector.select("project-a");
    const r = await selector.resolve("project-a", "read");
    assert.ok(r.ok && !r.switchedFrom);
    assert.deepEqual(opened, ["project-a"]);
  });

  it("reports the previous project when a call switches", async () => {
    const { session } = fakeSession();
    const selector = new ProjectSelector(session);
    await selector.select("project-a");
    const r = await selector.resolve("project-b", "read");
    assert.ok(r.ok);
    assert.equal(r.switchedFrom?.projectId, "project-a");
  });

  it("allows implicit writes to the project confirmed by open_project", async () => {
    const { session } = fakeSession();
    const selector = new ProjectSelector(session);
    await selector.select("project-a");
    assert.equal(await resolvedId(selector, undefined, "write"), "project-a");
  });

  it("refuses an implicit write after a read switched projects", async () => {
    const { session } = fakeSession();
    const selector = new ProjectSelector(session);
    await selector.select("project-a");
    await selector.resolve("project-b", "read");
    assert.match(await resolvedId(selector, undefined, "write"), /^refused: Active project changed to "project-b"/);
    // Reads keep working on the switched project.
    assert.equal(await resolvedId(selector, undefined, "read"), "project-b");
  });

  it("refuses an implicit write when only a read selected the project", async () => {
    const { session } = fakeSession();
    const selector = new ProjectSelector(session);
    await selector.resolve("project-a", "read");
    assert.match(await resolvedId(selector, undefined, "write"), /^refused:/);
  });

  it("an explicit project_id on a write confirms the target", async () => {
    const { session } = fakeSession();
    const selector = new ProjectSelector(session);
    await selector.select("project-a");
    await selector.resolve("project-b", "read");
    assert.equal(await resolvedId(selector, "project-b", "write"), "project-b");
    assert.equal(await resolvedId(selector, undefined, "write"), "project-b");
  });

  it("open_project re-confirms the write target", async () => {
    const { session } = fakeSession();
    const selector = new ProjectSelector(session);
    await selector.select("project-a");
    await selector.resolve("project-b", "read");
    await selector.select("project-a");
    assert.equal(await resolvedId(selector, undefined, "write"), "project-a");
  });

  it("propagates open failures instead of returning the wrong project", async () => {
    const failure = new Error("access denied");
    const { session } = fakeSession(project("project-a"), failure);
    await assert.rejects(new ProjectSelector(session).resolve("project-b", "read"), (err) => err === failure);
  });
});
