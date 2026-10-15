import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createServer } from "../../../src/server/createServer.js";
import { ok } from "../../../src/domain/result.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import type { AgentEngine } from "../../../src/application/agents/AgentEngine.js";
import { AGENT_TOOL_CONTRACTS } from "../../../src/contracts/agentToolContracts.js";
import { ToolResultDelivery } from "../../../src/server/toolResult.js";
import { Ajv2020 } from "ajv/dist/2020.js";

describe("MCP App delegation contracts", () => {
  it("returns a deliverable run acknowledgement and reports independently of oversized source bodies", async () => {
    const source = createEvidence(
      undefined,
      { id: "fixture", name: "Fixture", version: "1" },
      {
        operation: "fixture",
        parameters: {},
        result: { large: "x".repeat(100000) },
      },
    );
    const engine: AgentEngine = {
      models: { analyst: "a", reviewer: null },
      generate: async () => {
        throw new Error("Context must be rejected before generation");
      },
    };
    const session = createTestBinarySession(() => {
      throw new Error("No provider expected");
    });
    const server = createServer(
      { kind: "session", session },
      {
        environment: {},
        agentEngine: engine,
        delivery: new ToolResultDelivery(8192),
      },
    );
    const client = new Client({ name: "small-buffer", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(b);
      await client.connect(a);
      const reply = await client.callTool({
        name: "start_investigation",
        arguments: {
          question: "Explain",
          review: false,
          sources: [{ kind: "inline-evidence", evidence: source }],
          budget: { max_context_bytes: 100 },
        },
      });
      expect(reply.isError).not.toBe(true);
      const acknowledgement = AGENT_TOOL_CONTRACTS.find(
        (contract) => contract.name === "start_investigation",
      )!.outputSchema.parse(reply.structuredContent).result;
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      const read = await client.callTool({
        name: "read_investigation",
        arguments: { run_id: acknowledgement.run_id },
      });
      expect(read.isError).not.toBe(true);
      expect(read.structuredContent).toMatchObject({
        result: { state: "limited", total_sources: 1, sources: [] },
      });
    } finally {
      await client.close();
      await server.close();
      await session.close();
    }
  });
});
describe("MCP App report handoff", () => {
  it("advertises named UI contracts, validates results, and hands complete worker reports back to the main client", async () => {
    const source = createEvidence(
      undefined,
      { id: "fixture", name: "Fixture", version: "1" },
      { operation: "fixture", parameters: {}, result: { observed: "value" } },
    );
    const engine: AgentEngine = {
      models: { analyst: "fixture/analyst", reviewer: "fixture/reviewer" },
      generate: async () =>
        ok({
          decision: {
            kind: "report",
            findings: [
              {
                claim: "Inferred interpretation",
                evidence_ids: [source.evidence_id],
                assumptions: [],
              },
            ],
            unknowns: [],
            next_steps: [],
          },
          requestedModel: "fixture/analyst",
          returnedModel: null,
          provider: null,
          inputTokens: 10,
          outputTokens: 20,
          costUsd: 0,
        }),
    };
    const session = createTestBinarySession(() => {
      throw new Error("No live provider calls expected");
    });
    const server = createServer(
      { kind: "session", session },
      { environment: {}, agentEngine: engine },
    );
    const client = new Client({ name: "main-agent-fixture", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const catalog = await client.listTools();
      const validator = new Ajv2020({ strict: false, validateFormats: false });
      for (const contract of AGENT_TOOL_CONTRACTS) {
        const advertised = catalog.tools.find(
          (tool) => tool.name === contract.name,
        )!;
        expect(validator.validateSchema(advertised.inputSchema)).toBe(true);
        const outputSchema: Record<string, unknown> = advertised.outputSchema!;
        expect(validator.validateSchema(outputSchema)).toBe(true);
      }
      expect(
        catalog.tools.find((tool) => tool.name === "rea_workbench")?._meta,
      ).toMatchObject({ ui: { resourceUri: "ui://rea/workbench.html" } });
      const status = await client.callTool({
        name: "rea_workbench",
        arguments: {},
      });
      expect(
        AGENT_TOOL_CONTRACTS.find(
          (contract) => contract.name === "rea_workbench",
        )!.outputSchema.safeParse(status.structuredContent).success,
      ).toBe(true);
      const started = await client.callTool({
        name: "start_investigation",
        arguments: {
          question: "Interpret this observation",
          sources: [{ kind: "inline-evidence", evidence: source }],
        },
      });
      const parsed = AGENT_TOOL_CONTRACTS.find(
        (contract) => contract.name === "start_investigation",
      )!.outputSchema.parse(started.structuredContent);
      let result = AGENT_TOOL_CONTRACTS.find(
        (contract) => contract.name === "read_investigation",
      )!.outputSchema.parse(
        (
          await client.callTool({
            name: "read_investigation",
            arguments: { run_id: parsed.result.run_id, include_sources: true },
          })
        ).structuredContent,
      ).result;
      for (
        let attempt = 0;
        attempt < 100 && result.state === "running";
        attempt++
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        const reply = await client.callTool({
          name: "read_investigation",
          arguments: { run_id: result.run_id, include_sources: true },
        });
        result = AGENT_TOOL_CONTRACTS.find(
          (contract) => contract.name === "read_investigation",
        )!.outputSchema.parse(reply.structuredContent).result;
      }
      expect(result.state).toBe("completed");
      expect(result.sources).toEqual([source]);
      expect(result.analyst?.findings[0]?.evidence_ids).toEqual([
        source.evidence_id,
      ]);
      expect(result.reviewer).not.toBeNull();
      const reportsOnly = await client.callTool({
        name: "read_investigation",
        arguments: { run_id: result.run_id },
      });
      expect(reportsOnly.structuredContent).toMatchObject({
        result: { sources: [], total_sources: 1 },
      });
      const resource = await client.readResource({
        uri: "ui://rea/workbench.html",
      });
      expect(resource.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
      expect(
        resource.contents[0] && "text" in resource.contents[0]
          ? resource.contents[0].text
          : "",
      ).toContain("Investigation workspace");
      const missing = await client.callTool({
        name: "read_investigation",
        arguments: { run_id: "another-connection-run" },
      });
      expect(missing.isError).toBe(true);
      const malformed = await client.callTool({
        name: "start_investigation",
        arguments: { question: "" },
      });
      expect(malformed.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
      await session.close();
    }
  });
});
