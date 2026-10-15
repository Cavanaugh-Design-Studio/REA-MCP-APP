import { expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { join } from "node:path";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { browserVerificationFixture } from "../../../src/domain/browserScenarioVerification.fixture.js";

import { CallToolResultSchema } from "@modelcontextprotocol/core";

it("saves a large feature revision through the authenticated browser without losing Evidence or bypassing stale revision checks", async () => {
  const directory = await createTestTempDirectory("rea-fullscreen-project-");
  const session = createTestBinarySession(() => {
    throw new Error("No native provider expected");
  });
  const server = createServer(
    { kind: "session", session },
    {
      environment: {
        REA_PROJECT_STORE: join(directory, "projects.sqlite"),
        REA_MCP_MAX_RESPONSE_BYTES: "33554432",
      },
    },
  );
  const client = new Client({ name: "fullscreen-project", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    const source = browserVerificationFixture();
    const definition = {
      title: "Large annotation project",
      goal: "Retain local observations",
      original: {
        kind: "browser",
        location: "http://localhost:4100/",
        sha256: null,
      },
      candidate: null,
      evidence_bundle: createEvidenceBundle([source.evidence]),
      obligations: {
        reviewed_obligations: [],
        manifest: { bindings: [], contradictions: [] },
      },
      specification: null,
      cases: [],
      notes: ["local annotations ".repeat(32000)],
    };
    const created = toolContract("create_feature_project").outputSchema.parse(
      (
        await client.callTool({
          name: "create_feature_project",
          arguments: definition,
        })
      ).structuredContent,
    ).result;
    const opened = toolContract("rea_workbench").outputSchema.parse(
      (
        await client.callTool({
          name: "rea_workbench",
          arguments: { open_browser: true },
        })
      ).structuredContent,
    ).result;
    const url = new URL(opened.browser_url!);
    const headers = {
      Origin: url.origin,
      "Content-Type": "application/json",
    };
    expect(
      (
        await fetch(`${url.origin}/session`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ticket: "x".repeat(2048) }),
        })
      ).status,
    ).toBe(400);
    const claimed = await fetch(`${url.origin}/session`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ticket: new URLSearchParams(url.hash.slice(1)).get("handoff"),
      }),
    });
    const cookie = claimed.headers.get("set-cookie")!.split(";")[0]!;
    const input = {
      name: "revise_feature_project",
      arguments: {
        project_id: created.project_id,
        expected_revision: 1,
        definition: { ...definition, title: "Revised in fullscreen" },
      },
    };
    const body = JSON.stringify(input);
    expect(Buffer.byteLength(body)).toBeGreaterThan(262144);
    const request = () =>
      fetch(`${url.origin}/tool`, {
        method: "POST",
        headers: { ...headers, Cookie: cookie },
        body,
      });
    const saved = toolContract("revise_feature_project").outputSchema.parse(
      CallToolResultSchema.parse(await (await request()).json())
        .structuredContent,
    ).result;
    expect(saved.revision).toBe(2);
    expect(
      saved.definition.evidence_bundle.records.map((item) => item.evidence_id),
    ).toEqual([source.evidence.evidence_id]);
    expect(saved.definition.notes).toEqual(definition.notes);
    expect(
      CallToolResultSchema.parse(await (await request()).json()).isError,
    ).toBe(true);
    const historical = toolContract("read_feature_project").outputSchema.parse(
      (
        await client.callTool({
          name: "read_feature_project",
          arguments: { project_id: created.project_id, revision: 1 },
        })
      ).structuredContent,
    ).result;
    expect(historical.project.definition.title).toBe(definition.title);
    expect(
      (
        await client.callTool({
          name: "read_feature_project",
          arguments: { project_id: created.project_id, revision: 9 },
        })
      ).isError,
    ).toBe(true);
  } finally {
    await client.close();
    await server.close();
    await session.close();
  }
});
