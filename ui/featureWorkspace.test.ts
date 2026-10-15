import { expect, it } from "vitest";
import { FeatureWorkspace } from "./featureWorkspace.js";

const projectId = "a29b87b3-e3f0-4fb3-8b88-fb3ccff3bbbd";
const definition = {
  title: "Annotation",
  notes: ["retained local observations ".repeat(24000)],
  evidence_bundle: { records: [] },
};
const makeWorkspace = (calls: Record<string, unknown>[]) =>
  new FeatureWorkspace({
    call: async (_name, args) => {
      calls.push(args ?? {});
      return {
        project: {
          project_id: projectId,
          revision: args?.revision ?? 4,
          definition,
        },
      };
    },
    perform: async (action) => action(),
    discuss: async () => {},
    delegate: () => {},
    retain: () => {},
    escape: String,
    unwrap: (raw) => raw as Record<string, unknown>,
    standalone: true,
  });

it("reopens a large durable manifest using its immutable revision without copying it into the fullscreen ticket", async () => {
  const workspace = makeWorkspace([]);
  await workspace.load(projectId);
  const state = workspace.snapshot();
  expect(JSON.stringify(definition).length).toBeGreaterThan(262144);
  expect(JSON.stringify(state).length).toBeLessThan(1024);
  expect(state.definitionEdit).toBeNull();
  const calls: Record<string, unknown>[] = [];
  const reopened = makeWorkspace(calls);
  await reopened.restore(state);
  expect(calls).toEqual([{ project_id: projectId, revision: 4 }]);
  expect(reopened.snapshot()).toEqual(state);
});

it("preserves an unsaved invalid JSON edit and its original revision when a newer project exists", async () => {
  const calls: Record<string, unknown>[] = [];
  const workspace = makeWorkspace(calls);
  // A malformed edit remains user text; opening fullscreen must not parse,
  // discard or save it. The project currently has a later revision (4).
  await workspace.restore({
    projectId,
    definitionRevision: 2,
    definitionEdit: { start: 0, remove: 1, insert: "{ unsaved: " },
    cases: { selected: "zoom-2" },
  });
  const state = workspace.snapshot();
  expect(state.definitionRevision).toBe(2);
  expect(state.definitionEdit).toEqual({
    start: 1,
    remove: 0,
    insert: " unsaved: ",
  });
  expect(state.cases.selected).toBe("zoom-2");
  expect(JSON.stringify(state).length).toBeLessThan(1024);
  const reopened = makeWorkspace(calls);
  await reopened.restore(state);
  expect(calls).toEqual([
    { project_id: projectId, revision: 2 },
    { project_id: projectId, revision: 2 },
  ]);
  expect(reopened.snapshot()).toEqual(state);
});

it("rejects a manifest edit that does not fit its loaded revision", async () => {
  const workspace = makeWorkspace([]);
  await expect(
    workspace.restore({
      projectId,
      definitionRevision: 2,
      definitionEdit: { start: 0, remove: 1000000, insert: "" },
    }),
  ).rejects.toThrow("fullscreen manifest edit is invalid");
  await expect(
    workspace.restore({
      projectId,
      definitionEdit: { start: 0, remove: 0, insert: "unsaved" },
    }),
  ).rejects.toThrow("requires its saved project revision");
});
