import { describe, expect, it } from "vitest";
import { get } from "node:http";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { ok } from "../../../src/domain/result.js";

describe("workbench fullscreen browser handoff", () => {
  it("serves the packaged App and shares a live MCP run through an authenticated single-use handoff", async () => {
    const session = createTestBinarySession(() => {
      throw new Error("No native provider expected");
    });
    const server = createServer(
      { kind: "session", session },
      {
        environment: {},
        agentEngine: {
          models: { analyst: "fixture/analyst", reviewer: null },
          generate: async () =>
            ok({
              decision: {
                kind: "report",
                findings: [],
                unknowns: [],
                next_steps: [],
              },
              requestedModel: "fixture/analyst",
              returnedModel: null,
              provider: null,
              inputTokens: null,
              outputTokens: null,
              costUsd: null,
            }),
        },
      },
    );
    const client = new Client({ name: "fullscreen-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    let origin = "";
    try {
      await server.connect(b);
      await client.connect(a);
      const started = await client.callTool({
        name: "start_investigation",
        arguments: { question: "Retain this run", sources: [], review: false },
      });
      const run = toolContract("start_investigation").outputSchema.parse(
        started.structuredContent,
      ).result;
      const handoff = {
        runId: run.run_id,
        question: "Unsaved question",
        selected: [],
        form: { requests: "3" },
      };
      const opened = await client.callTool({
        name: "rea_workbench",
        arguments: { open_browser: true, handoff },
      });
      const url = new URL(
        toolContract("rea_workbench").outputSchema.parse(
          opened.structuredContent,
        ).result.browser_url!,
      );
      expect(url.hostname).toBe("127.0.0.1");
      expect(url.pathname).toBe("/workbench");
      expect(url.search).toBe("");
      origin = url.origin;
      const html = await fetch(url);
      expect(html.status).toBe(200);
      expect(html.headers.get("cache-control")).toBe("no-store");
      expect(html.headers.get("content-security-policy")).toContain(
        "frame-ancestors 'none'",
      );
      expect(await html.text()).toContain('id="root"');
      const ticket = new URLSearchParams(url.hash.slice(1)).get("handoff");
      const consumed = await fetch(`${origin}/session`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ ticket }),
      });
      expect(consumed.status).toBe(200);
      expect(await consumed.json()).toEqual({ state: handoff });
      const setCookie = consumed.headers.get("set-cookie")!;
      expect(setCookie).toContain("HttpOnly; SameSite=Strict");
      const cookie = setCookie.split(";")[0]!;
      const headers = {
        Origin: origin,
        "Content-Type": "application/json",
        Cookie: cookie,
      };
      const read = await fetch(`${origin}/tool`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "read_investigation",
          arguments: { run_id: run.run_id },
        }),
      });
      const report = toolContract("read_investigation").outputSchema.parse(
        ((await read.json()) as { structuredContent: unknown })
          .structuredContent,
      ).result;
      expect(report.run_id).toBe(run.run_id);
      expect(report.question).toBe("Retain this run");
      const replay = await fetch(`${origin}/session`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ticket }),
      });
      expect(replay.status).toBe(401);
      await server.close();
      await expect(fetch(`${origin}/workbench`)).rejects.toThrow();
    } finally {
      await client.close();
      await server.close();
      await session.close();
    }
  });
});

describe("workbench browser isolation", () => {
  it("rejects unauthenticated, foreign-origin and unauthorized browser tool calls", async () => {
    const session = createTestBinarySession(() => {
      throw new Error("No native provider expected");
    });
    const server = createServer(
      { kind: "session", session },
      { environment: {} },
    );
    const client = new Client({ name: "fullscreen-isolation", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(b);
      await client.connect(a);
      const result = await client.callTool({
        name: "rea_workbench",
        arguments: { open_browser: true },
      });
      const url = new URL(
        toolContract("rea_workbench").outputSchema.parse(
          result.structuredContent,
        ).result.browser_url!,
      );
      const headers = {
        Origin: url.origin,
        "Content-Type": "application/json",
      };
      const body = JSON.stringify({
        name: "open_binary",
        arguments: { path: "private" },
      });
      expect(
        (await fetch(`${url.origin}/tool`, { method: "POST", headers, body }))
          .status,
      ).toBe(401);
      const claimed = await fetch(`${url.origin}/session`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ticket: new URLSearchParams(url.hash.slice(1)).get("handoff"),
        }),
      });
      const cookie = claimed.headers.get("set-cookie")!.split(";")[0]!;
      expect(
        (
          await fetch(`${url.origin}/tool`, {
            method: "POST",
            headers: {
              ...headers,
              Cookie: cookie,
              Origin: "https://example.com",
            },
            body,
          })
        ).status,
      ).toBe(403);
      const foreignHost = await new Promise<number | undefined>(
        (resolve, reject) => {
          get(
            `${url.origin}/workbench`,
            { headers: { Host: "evil.example" } },
            (response) => {
              response.resume();
              resolve(response.statusCode);
            },
          ).on("error", reject);
        },
      );
      expect(foreignHost).toBe(403);
      const denied = await fetch(`${url.origin}/tool`, {
        method: "POST",
        headers: { ...headers, Cookie: cookie },
        body,
      });
      expect(denied.status).toBe(400);
      expect(await denied.text()).not.toContain("private");
      const invalid = await fetch(`${url.origin}/tool`, {
        method: "POST",
        headers: { ...headers, Cookie: cookie },
        body: JSON.stringify({
          name: "start_investigation",
          arguments: { question: 42 },
        }),
      });
      expect(invalid.status).toBe(400);
      const oversize = await client.callTool({
        name: "rea_workbench",
        arguments: {
          open_browser: true,
          handoff: { question: "x".repeat(8 * 1024 * 1024) },
        },
      });
      expect(oversize.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
      await session.close();
    }
  });
});
