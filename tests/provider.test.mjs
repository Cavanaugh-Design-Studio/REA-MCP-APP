import test from "node:test";
import assert from "node:assert/strict";
import { OpenRouterEngine } from "../dist/ai/Engine.js";
import { localToolDefinitions } from "../dist/contracts.js";

test("provider request contains the skill and local tools, with credentials only in transport", async () => {
  let body;
  const engine = new OpenRouterEngine(
    { analyst: "fixture/model", reviewer: null },
    "fixture-transport-secret",
    async (_url, init) => {
      body = JSON.parse(init.body);
      assert.equal(
        init.headers.Authorization,
        "Bearer fixture-transport-secret",
      );
      assert.equal(init.body.includes("fixture-transport-secret"), false);
      return new Response(
        JSON.stringify({
          model: "fixture/model",
          usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.001 },
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [
                  {
                    type: "function",
                    function: {
                      name: "run_command",
                      arguments: JSON.stringify({
                        executable: "rg",
                        arguments: ["-uu", "search", "input"],
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    },
  );
  const result = await engine.generate({
    role: "analyst",
    context: JSON.stringify({ question: "Trace the feature", sources: [] }),
    skill: "trusted leanrea guide",
    tools: localToolDefinitions,
    maxOutputTokens: 1024,
    maxResponseBytes: 65536,
    signal: new AbortController().signal,
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.decision.name, "run_command");
  assert.equal(result.value.costUsd, 0.001);
  assert.ok(body.messages[0].content.includes("trusted leanrea guide"));
  assert.deepEqual(
    body.tools.map((tool) => tool.function.name),
    ["run_command", "read_file", "write_file", "list_files"],
  );
  assert.equal(body.provider.allow_fallbacks, false);
});

test("malformed reports retain billed usage and output-limit responses remain limited", async () => {
  for (const finish_reason of ["stop", "length"]) {
    const engine = new OpenRouterEngine(
      { analyst: "fixture/model", reviewer: null },
      "fixture-key",
      async () =>
        new Response(
          JSON.stringify({
            usage: { cost: 0.002 },
            choices: [{ finish_reason, message: { content: "{invalid" } }],
          }),
        ),
    );
    const result = await engine.generate({
      role: "analyst",
      context: "{}",
      skill: "fixture",
      tools: [],
      maxOutputTokens: 128,
      maxResponseBytes: 4096,
      signal: new AbortController().signal,
    });
    assert.equal(result.ok, true);
    assert.equal(result.value.costUsd, 0.002);
    assert.equal(
      result.value.decision.kind,
      finish_reason === "length" ? "limited" : "failed",
    );
  }
});
