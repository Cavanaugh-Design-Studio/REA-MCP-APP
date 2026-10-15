import { createServer } from "vite";
import { Client } from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

// Development-only MCP App host fixture. The production server remains stdio.
const port = Number(process.argv[2] ?? 4320);
const client = new Client({
  name: "workbench-browser-verification",
  version: "1",
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("scripts/rea.mjs"), "mcp"],
  env: {
    ...getDefaultEnvironment(),
    REA_AI_ENABLED: "false",
    REA_PROJECT_STORE: resolve(
      process.argv[3] ?? ".cache/workbench-preview/projects.sqlite",
    ),
  },
  stderr: "pipe",
});
const allowed = new Set([
  "rea_workbench",
  "get_evidence_bundle",
  "read_investigation",
  "start_investigation",
  "cancel_investigation",
  "list_unknowns",
  "inspect_analysis_view",
  "create_feature_project",
  "read_feature_project",
  "list_feature_projects",
  "revise_feature_project",
  "compare_browser_scenario_evidence",
  "export_feature_handoff",
]);
await client.connect(transport);
const middleware = async (request, response, next) => {
  if (!["/tool", "/app"].includes(request.url?.split("?")[0])) {
    next();
    return;
  }
  try {
    if (request.headers.host !== `127.0.0.1:${port}`)
      throw new Error("Invalid host");
    if (request.url.startsWith("/app")) {
      const resource = await client.readResource({
        uri: "ui://rea/workbench.html",
      });
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(resource.contents[0].text);
      return;
    }
    if (
      request.method !== "POST" ||
      request.headers.origin !== `http://127.0.0.1:${port}`
    )
      throw new Error("Invalid origin/method");
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) throw new Error("Request too large");
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!allowed.has(input.name))
      throw new Error("Tool unavailable in preview");
    const result = await client.callTool(input);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(result));
  } catch (error) {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        isError: true,
        content: [{ type: "text", text: error.message }],
      }),
    );
  }
};
const host = await createServer({
  root: resolve("tests/fixtures/workbench-host"),
  server: { host: "127.0.0.1", port, strictPort: true },
  configFile: false,
  plugins: [
    {
      name: "rea-verification-host",
      configureServer(server) {
        server.middlewares.use(middleware);
      },
    },
  ],
});
await host.listen();
process.stdout.write(
  `REA App verification host: http://127.0.0.1:${port}/host.html\nModels disabled. Type quit to drain the owned server.\n`,
);
let closing = false;
const input = createInterface({ input: process.stdin });
async function close() {
  if (closing) return;
  closing = true;
  input.close();
  await host.close();
  await client.close();
  await transport.close();
}
input.on("line", (line) => {
  if (line.trim() === "quit") void close();
});
process.on("SIGINT", () => {
  void close();
});
process.on("SIGTERM", () => {
  void close();
});
