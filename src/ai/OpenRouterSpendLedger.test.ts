import { expect, it } from "vitest";
import { join } from "node:path";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { OpenRouterSpendLedger } from "./OpenRouterSpendLedger.js";
import { OpenRouterEngine } from "./OpenRouterEngine.js";
import { DatabaseSync } from "node:sqlite";
import { openRouterPriceCeiling } from "./OpenRouterPricing.js";

it("retains uncertain spending across restarts and atomically admits only within the fixed ceiling", async () => {
  const path = join(
    await createTestTempDirectory("rea-spend-"),
    "spend.sqlite",
  );
  const first = new OpenRouterSpendLedger(path, 20),
    second = new OpenRouterSpendLedger(path, 20);
  const reservation = first.reserve("caller/model", 12)!;
  expect(second.reserve("caller/model", 9)).toBeNull();
  expect(second.reserve("caller/model", 8)).not.toBeNull();
  expect(first.recordCost(reservation, 1)).toBe(true);
  expect(
    new OpenRouterSpendLedger(path, 20).reserve("caller/model", 0.001),
  ).toBeNull();
  expect(() =>
    new OpenRouterSpendLedger(path, 21).reserve("caller/model", 1),
  ).toThrow();
});
it("permanently stops dispatch if reported upstream billing contradicts a reservation", async () => {
  const path = join(
    await createTestTempDirectory("rea-spend-"),
    "spend.sqlite",
  );
  const ledger = new OpenRouterSpendLedger(path, 20);
  const first = ledger.reserve("caller/model", 1)!,
    second = ledger.reserve("caller/model", 3)!;
  expect(ledger.recordCost(first, 2)).toBe(false);
  expect(ledger.recordCost(second, 2)).toBe(true);
  expect(() =>
    new OpenRouterSpendLedger(path, 20).reserve("caller/model", 0),
  ).toThrow();
});
it("rejects persisted overbilling even if an old interruption missed the policy flag", async () => {
  const path = join(
    await createTestTempDirectory("rea-spend-"),
    "spend.sqlite",
  );
  const ledger = new OpenRouterSpendLedger(path, 20);
  const reservation = ledger.reserve("caller/model", 1)!;
  const database = new DatabaseSync(path);
  try {
    database
      .prepare("UPDATE model_reservations SET cost_usd=2 WHERE id=?")
      .run(reservation);
  } finally {
    database.close();
  }
  expect(() =>
    new OpenRouterSpendLedger(path, 20).reserve("caller/model", 0),
  ).toThrow();
});
it("rejects absent pricing rather than treating it as a free route", async () => {
  const fetcher = (async () =>
    Response.json({
      data: {
        endpoints: [
          {
            context_length: 10000,
            max_completion_tokens: 1000,
            pricing: { prompt: "", completion: "0" },
          },
        ],
      },
    })) as typeof fetch;
  await expect(
    openRouterPriceCeiling(
      "caller/model",
      fetcher,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});
it("blocks inference before spending and routes admitted requests with price ceilings", async () => {
  const path = join(
    await createTestTempDirectory("rea-spend-"),
    "spend.sqlite",
  );
  let dispatches = 0;
  let provider: unknown;
  const fetcher = (async (url: string, options: RequestInit) => {
    if (url.endsWith("/endpoints"))
      return Response.json({
        data: {
          endpoints: [
            {
              context_length: 100000,
              max_completion_tokens: 1000,
              pricing: { prompt: "0.00001", completion: "0.001" },
            },
          ],
        },
      });
    dispatches += 1;
    provider = JSON.parse(String(options.body)).provider;
    return Response.json({
      usage: { cost: 0.01 },
      choices: [
        {
          message: {
            content: JSON.stringify({
              findings: [],
              unknowns: [],
              next_steps: [],
            }),
          },
        },
      ],
    });
  }) as typeof fetch;
  const engine = new OpenRouterEngine(
    { analyst: "caller/model", reviewer: null },
    "private-key",
    fetcher,
    new OpenRouterSpendLedger(path, 3),
  );
  const request = {
    role: "analyst" as const,
    context: "bounded",
    maxOutputTokens: 10,
    maxResponseBytes: 1000,
    signal: new AbortController().signal,
    allowFunctionAnalysis: false,
  };
  expect(
    (await engine.generate({ ...request, maxOutputTokens: 1001 })).ok,
  ).toBe(false);
  expect(
    (await engine.generate({ ...request, context: "x".repeat(100001) })).ok,
  ).toBe(false);
  expect(dispatches).toBe(0);
  expect((await engine.generate(request)).ok).toBe(true);
  expect(provider).toMatchObject({
    max_price: { prompt: 10, completion: 1000, request: 0 },
    zdr: true,
    allow_fallbacks: false,
  });
  expect((await engine.generate(request)).ok).toBe(false);
  expect(dispatches).toBe(1);
});
