import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";

// Builds only this source-owned study with a caller-installed .NET SDK. It never
// installs SDKs or claims a blind reconstruction or native feature certificate.
const execute = promisify(execFile);
const output = resolve(
  process.argv[2] ?? `.cache/managed-feature/${Date.now()}`,
);
await mkdir(dirname(output), { recursive: true });
await mkdir(output, { recursive: false });
const source = `using System;
using System.Text.Json;
public static class Pricing {
  public static void Main(string[] args) {
    try {
      using var doc = JsonDocument.Parse(args[0]);
      var root = doc.RootElement;
      int unit = root.GetProperty("unit").GetInt32();
      int quantity = root.GetProperty("quantity").GetInt32();
      int discount = root.GetProperty("discount").GetInt32();
      if (unit < 0 || quantity < 0 || discount < 0 || discount > 100) throw new ArgumentException();
      int subtotal = checked(unit * quantity);
      int reduced = checked((int)Math.Round((decimal)subtotal * (100 - discount) / 100, MidpointRounding.AwayFromZero));
      int shipping = reduced == 0 || reduced >= 10000 ? 0 : 499;
      Console.WriteLine(JsonSerializer.Serialize(new { subtotal, reduced, shipping, total = checked(reduced + shipping) }));
    } catch { Console.WriteLine(JsonSerializer.Serialize(new { error = "invalid-input" })); }
  }
}`;
const candidate = `export function price(raw, seeded = false) {
  try {
    const {unit, quantity, discount} = JSON.parse(raw);
    if (![unit, quantity, discount].every(value => Number.isInteger(value) && value >= 0 && value <= 2147483647) || discount > 100) throw Error();
    const subtotal = unit * quantity;
    if (subtotal > 2147483647) throw Error();
    const reduced = Math.floor(subtotal * (100 - discount) / 100 + 0.5);
    const shipping = seeded || reduced === 0 || reduced >= 10000 ? 0 : 499;
    const total = reduced + shipping;
    if (total > 2147483647) throw Error();
    return {subtotal, reduced, shipping, total};
  } catch { return {error:'invalid-input'}; }
}
`;
await writeFile(join(output, "Program.cs"), source);
await writeFile(join(output, "candidate.mjs"), candidate);
await writeFile(
  join(output, "Pricing.csproj"),
  '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net9.0</TargetFramework><AssemblyName>Pricing</AssemblyName><RestoreIgnoreFailedSources>true</RestoreIgnoreFailedSources></PropertyGroup></Project>',
);
const environment = {
  ...process.env,
  DOTNET_CLI_TELEMETRY_OPTOUT: "1",
  DOTNET_NOLOGO: "1",
};
let build;
try {
  build = await execute(
    "dotnet",
    [
      "build",
      join(output, "Pricing.csproj"),
      "--configuration",
      "Release",
      "--nologo",
      "--verbosity",
      "quiet",
    ],
    { env: environment, timeout: 60000, windowsHide: true },
  );
} catch (cause) {
  await writeFile(
    join(output, "build.log"),
    String(cause.stdout ?? "") + String(cause.stderr ?? ""),
  );
  throw cause;
}
await writeFile(join(output, "build.log"), build.stdout + build.stderr);
const artifact = join(output, "bin", "Release", "net9.0", "Pricing.dll");
const digest = createHash("sha256")
  .update(await readFile(artifact))
  .digest("hex");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("scripts/rea.mjs"), "mcp"],
  env: { ...getDefaultEnvironment(), REA_AI_ENABLED: "false" },
  stderr: "pipe",
});
const client = new Client({
  name: "rea-real-managed-feature-study",
  version: "1",
});
let errors = "";
transport.stderr?.on("data", (bytes) => {
  errors += bytes.toString();
});
const report = {
  scope:
    "Source-owned real .NET compilation, public REA inspection and finite execution comparison; not blind, native ABI proof or full application equivalence",
  output,
  artifact,
  artifact_sha256: digest,
  sdk: (
    await execute("dotnet", ["--version"], {
      env: environment,
      windowsHide: true,
    })
  ).stdout.trim(),
  evidence_ids: [],
  cases: [],
};
try {
  await client.connect(transport);
  for (const name of [
    "inspect_managed_artifact",
    "inspect_managed_members",
    "inspect_managed_native_boundaries",
  ]) {
    const response = await client.callTool({
      name,
      arguments: { path: artifact },
    });
    await writeFile(
      join(output, `${name}.json`),
      JSON.stringify(response, null, 2),
    );
    assert(!response.isError, `${name} failed`);
    const evidence =
      response.structuredContent?.evidence ?? response.structuredContent;
    report.evidence_ids.push(evidence.evidence_id);
  }
  const cli = await execute(
    process.execPath,
    [
      resolve("scripts/rea.mjs"),
      "inspect-managed-artifact",
      artifact,
      "--json",
    ],
    { timeout: 30000, windowsHide: true },
  );
  const cliEvidence = JSON.parse(cli.stdout);
  assert.equal(cliEvidence.normalized_result.classification.status, "managed");
  await writeFile(
    join(output, "cli-artifact.json"),
    JSON.stringify(cliEvidence, null, 2),
  );
  const { price } = await import(
    pathToFileURL(join(output, "candidate.mjs")).href
  );
  const cases = [
    { id: "shipping", input: { unit: 1250, quantity: 2, discount: 0 } },
    {
      id: "free-shipping-boundary",
      input: { unit: 10000, quantity: 1, discount: 0 },
    },
    { id: "below-boundary", input: { unit: 9999, quantity: 1, discount: 0 } },
    { id: "rounding", input: { unit: 101, quantity: 1, discount: 50 } },
    { id: "zero", input: { unit: 0, quantity: 1, discount: 0 } },
    { id: "negative", input: { unit: -1, quantity: 1, discount: 0 } },
    { id: "overflow", input: { unit: 2147483647, quantity: 2, discount: 0 } },
    { id: "malformed", raw: "{" },
  ];
  for (const item of cases) {
    const raw = item.raw ?? JSON.stringify(item.input);
    const reference = JSON.parse(
      (
        await execute("dotnet", [artifact, raw], {
          env: environment,
          timeout: 10000,
          windowsHide: true,
        })
      ).stdout,
    );
    const repaired = price(raw),
      seeded = price(raw, true);
    const matches = JSON.stringify(reference) === JSON.stringify(repaired);
    assert(matches, `Repaired mismatch: ${item.id}`);
    report.cases.push({
      case_id: item.id,
      input: raw,
      original: reference,
      candidate: repaired,
      repaired_match: matches,
      seeded_match: JSON.stringify(reference) === JSON.stringify(seeded),
    });
  }
  assert(
    report.cases.some((item) => !item.seeded_match),
    "Seeded bug was not detected",
  );
  assert.equal(
    createHash("sha256")
      .update(await readFile(artifact))
      .digest("hex"),
    digest,
    "Inspection modified target bytes",
  );
  report.public_cli = true;
  report.public_mcp = true;
  report.artifact_unchanged = true;
} finally {
  await client.close();
  await transport.close();
  if (errors) await writeFile(join(output, "mcp-stderr.log"), errors);
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
}
process.stdout.write(
  JSON.stringify({
    output,
    cases: report.cases.length,
    repaired_passed: report.cases.filter((item) => item.repaired_match).length,
    seeded_failures: report.cases.filter((item) => !item.seeded_match).length,
    public_cli: report.public_cli,
    public_mcp: report.public_mcp,
    artifact_unchanged: report.artifact_unchanged,
  }) + "\n",
);
