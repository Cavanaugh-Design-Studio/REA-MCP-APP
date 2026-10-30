import { createServer } from "vite";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { mkdir } from "node:fs/promises";
import { createApp, MODEL_TOOL_NAMES, APP_TOOL_NAMES } from "../dist/server.js";
import { ok } from "../dist/retained/domain/result.js";

// Explicit development fixture: simulated decisions, real app/process boundary.
const port = Number(process.argv[2] ?? 4330);
const root = resolve(".cache/preview");
await mkdir(root, { recursive: true });
const engine = {
  models: { analyst: "fixture/internal-agent", reviewer: null },
  generate: async (request) => {
    const context = JSON.parse(request.context);
    const done = context.latest_observation?.operation === "run_local_command";
    const decision = done
      ? {
          kind: "report",
          report: {
            findings: [
              {
                claim:
                  "The fixture internal agent executed the local Node utility and retained its output.",
                evidence_ids: [context.latest_observation.evidence_id],
                assumptions: [
                  "This deterministic fixture tests execution plumbing, not model quality.",
                ],
              },
            ],
            unknowns: [
              "Real provider quality and target-specific behavior require separate acceptance.",
            ],
            next_steps: [],
          },
        }
      : {
          kind: "tool",
          name: "run_command",
          arguments: {
            executable: process.execPath,
            arguments: [
              "-e",
              "console.log(JSON.stringify({platform:process.platform,architecture:process.arch,node:process.version}))",
            ],
          },
        };
    return ok({
      decision,
      requestedModel: "fixture/internal-agent",
      returnedModel: "fixture/internal-agent",
      provider: "simulated",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: null,
    });
  },
};
const runtime = await createApp({
  engine,
  environment: {
    ...process.env,
    REA_AI_ENABLED: "false",
    REA_PROJECT_STORE: resolve(root, "projects.sqlite"),
  },
});
const client = new Client({ name: "preview-host", version: "1" });
const [a, b] = InMemoryTransport.createLinkedPair();
await runtime.server.connect(b);
await client.connect(a);
const allowed = new Set([...MODEL_TOOL_NAMES, ...APP_TOOL_NAMES]);
const host = await createServer({
  configFile: false,
  root: resolve("tests/host"),
  server: { host: "127.0.0.1", port, strictPort: true },
  plugins: [
    {
      name: "rea-fixture-host",
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (!["/tool", "/app"].includes(request.url?.split("?")[0]))
            return next();
          try {
            if (request.headers.host !== `127.0.0.1:${port}`)
              throw new Error("Invalid host");
            if (request.url.startsWith("/app")) {
              const resource = await client.readResource({
                uri: "ui://rea/workbench.html",
              });
              response.writeHead(200, {
                "Content-Type": "text/html",
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
              throw new Error("Unknown preview operation");
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify(await client.callTool(input)));
          } catch (error) {
            response.writeHead(400, { "Content-Type": "application/json" });
            response.end(
              JSON.stringify({
                isError: true,
                content: [{ type: "text", text: error.message }],
              }),
            );
          }
        });
      },
    },
  ],
});
await host.listen();
process.stdout.write(
  `REA fixture host: http://127.0.0.1:${port}/host.html\nSimulated model; no inference calls. Type quit to drain the owned runtime.\n`,
);
const input = createInterface({ input: process.stdin });
let closing;
const close = () =>
  (closing ??= (async () => {
    input.close();
    await host.close();
    await runtime.close();
    await client.close();
  })());
input.on("line", (line) => {
  if (line.trim() === "quit") void close();
});
process.once("SIGINT", () => {
  void close();
});
process.once("SIGTERM", () => {
  void close();
});
