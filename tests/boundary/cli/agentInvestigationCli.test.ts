import { expect } from "vitest";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "refuses cloud inference without explicit configuration and exits unsuccessfully",
  async ({ cli }) => {
    const result = await cli.run({
      arguments: [
        "investigate",
        JSON.stringify({
          question: "Explain supplied evidence",
          review: false,
        }),
        "--json",
      ],
      environment: {
        REA_AI_ENABLED: "false",
        REA_AI_ANALYST_MODEL: "",
        REA_AI_REVIEWER_MODEL: "",
        OPENROUTER_API_KEY: "",
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      error: { code: "capability_unavailable" },
    });
    expect(result.stdout).not.toContain("sk-");
  },
);
