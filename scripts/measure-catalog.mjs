import { Client } from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

async function measure(launcher, args = []) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [launcher, ...args],
    cwd: resolve(".cache"),
    env: { ...getDefaultEnvironment(), REA_AI_ENABLED: "false" },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "catalog-measurement", version: "1" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const model = tools.filter(
      (tool) =>
        !tool._meta?.ui?.visibility ||
        tool._meta.ui.visibility.includes("model"),
    );
    const resources = await client.listResources();
    return {
      launcher,
      registered_tools: tools.length,
      model_facing_tools: model.length,
      all_definition_bytes: Buffer.byteLength(JSON.stringify(tools)),
      model_definition_bytes: Buffer.byteLength(JSON.stringify(model)),
      resource_uris: resources.resources.map((item) => item.uri),
      foreign_cwd: true,
    };
  } finally {
    await client.close();
    await transport.close();
  }
}
await mkdir(".cache", { recursive: true });
const current = await measure(resolve("scripts/launch.mjs"));
const baseline = process.argv[2]
  ? await measure(resolve(process.argv[2]), ["mcp"])
  : null;
const report = {
  scope:
    "Compiled public stdio discovery only; models disabled; not a model efficiency benchmark",
  current,
  baseline,
  definition_reduction: baseline
    ? 1 - current.all_definition_bytes / baseline.all_definition_bytes
    : null,
};
await writeFile(
  ".cache/catalog-measurement.json",
  JSON.stringify(report, null, 2),
);
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
