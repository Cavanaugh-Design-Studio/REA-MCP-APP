import { expect, it } from "vitest";
import { createAgentEngine } from "../../src/composition/agentEngine.js";

it("requires explicit cloud opt-in, credential and analyst ID without selecting default models", () => {
  expect(createAgentEngine({})).toBeUndefined();
  expect(
    createAgentEngine({
      OPENROUTER_API_KEY: "fixture",
      REA_AI_ANALYST_MODEL: "chosen/a",
    }),
  ).toBeUndefined();
  expect(
    createAgentEngine({
      REA_AI_ENABLED: "true",
      OPENROUTER_API_KEY: "fixture",
    }),
  ).toBeUndefined();
  expect(
    createAgentEngine({
      REA_AI_ENABLED: "true",
      REA_AI_ANALYST_MODEL: "chosen/a",
    }),
  ).toBeUndefined();
  expect(
    createAgentEngine({
      REA_AI_ENABLED: "true",
      OPENROUTER_API_KEY: "fixture",
      REA_AI_ANALYST_MODEL: "chosen/a",
    })?.models,
  ).toEqual({ analyst: "chosen/a", reviewer: null });
  expect(
    createAgentEngine({
      REA_AI_ENABLED: "true",
      OPENROUTER_API_KEY: "fixture",
      REA_AI_ANALYST_MODEL: "chosen/a",
      REA_AI_REVIEWER_MODEL: "chosen/b",
    })?.models,
  ).toEqual({ analyst: "chosen/a", reviewer: "chosen/b" });
});
