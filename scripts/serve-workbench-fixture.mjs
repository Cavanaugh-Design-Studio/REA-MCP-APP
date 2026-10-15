// Explicit local verification harness. No cloud credential, target execution or general HTTP MCP transport.
import { createServer as createHttpServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { build } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../dist/server/createServer.js";
import { createManagedBinarySession } from "../dist/composition/binary.js";
import { createEvidence } from "../dist/domain/evidence.js";
import { createEvidenceBundle } from "../dist/domain/evidenceBundle.js";
import { ok } from "../dist/domain/result.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtureRoot = resolve(root, ".cache/workbench-qa");
await mkdir(fixtureRoot, { recursive: true });
const source = createEvidence(
  {
    path: resolve(fixtureRoot, "fixture.bin"),
    sha256: "a".repeat(64),
    format: "elf",
    architecture: "x86_64",
  },
  { id: "fixture", name: "UI verification fixture", version: "1" },
  {
    operation: "analyze_function",
    parameters: { procedure: "parse_record" },
    result: {
      procedure: {
        name: "parse_record",
        address: "0x401000",
        classification: null,
        body: {
          available: false,
          reason: "Fixture does not establish byte ranges",
        },
        signature: "int parse_record(bytes, length)",
        locals: [],
      },
      pseudocode:
        "if (length < 8) return INVALID;\nreturn decode_record(bytes, length);",
      assembly: [],
      comments: [],
      callers: [],
      callees: [],
      incoming_references: [],
      outgoing_references: [],
      referenced_strings: [],
      referenced_names: [],
      basic_blocks: [],
      native_api: null,
      native_value_flow: null,
      limitations: ["Static fixture only. Runtime behavior is unknown."],
    },
  },
);
const second = createEvidence(
  undefined,
  { id: "fixture", name: "UI verification fixture", version: "1" },
  {
    operation: "fixture_string_observation",
    parameters: {},
    result: {
      strings: ["INVALID", "decode_record"],
      links: "Function observation",
    },
    evidenceLinks: [source.evidence_id],
  },
);
await writeFile(
  resolve(fixtureRoot, "input.json"),
  JSON.stringify(createEvidenceBundle([source, second])),
);
const session = createManagedBinarySession();
session.recordEvidence(source);
session.recordEvidence(second);
const engine = {
  models: { analyst: "fixture/analyst", reviewer: "fixture/reviewer" },
  generate: async (request) => {
    const context = JSON.parse(request.context);
    await new Promise((done) => {
      const timer = setTimeout(
        done,
        context.question.includes("wait") ? 15000 : 600,
      );
      request.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          done();
        },
        { once: true },
      );
    });
    return ok({
      decision: {
        kind: "report",
        findings: context.sources.length
          ? [
              {
                claim:
                  request.role === "analyst"
                    ? "The supplied static fixture checks the record length before decoding. Runtime effects remain unobserved."
                    : "The analyst's statement is consistent with the supplied fixture text; this does not verify executed behavior.",
                evidence_ids: context.sources.map((item) => item.evidence_id),
                assumptions: [
                  "Fixture pseudocode accurately represents this selected source",
                ],
              },
            ]
          : [],
        unknowns: ["What happens for a record of exactly eight bytes?"],
        next_steps: ["Collect a caller-authorized runtime observation"],
      },
      requestedModel: `fixture/${request.role}`,
      returnedModel: `fixture/${request.role}`,
      provider: "simulated",
      inputTokens: 40,
      outputTokens: 60,
      costUsd: null,
    });
  },
};
const server = createServer(
  { kind: "session", session },
  { environment: {}, agentEngine: engine },
);
const client = new Client({ name: "workbench-fixture-host", version: "1" });
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(b);
await client.connect(a);
await client.callTool({
  name: "record_unknown",
  arguments: {
    question: "How does this fixture behave when executed?",
    severity: "medium",
    domain: "fixture-runtime",
    required_authority: "controlled-replay",
    required_confidence: "observed",
    required_environment: null,
    recommended_probes: [
      {
        operation: "capture_process_scenario",
        rationale:
          "Only a caller-authorized runtime observation could address this question",
      },
    ],
    relationships: [],
    supporting_evidence_ids: [source.evidence_id],
  },
});
const built = await build({
  configFile: false,
  root: resolve(root, "tests/fixtures/workbench-host"),
  plugins: [viteSingleFile()],
  build: {
    write: false,
    rollupOptions: {
      input: resolve(root, "tests/fixtures/workbench-host/host.html"),
    },
  },
});
const host = built.output.find(
  (asset) => asset.type === "asset" && asset.fileName.endsWith(".html"),
).source;
const port = Number(process.env.REA_WORKBENCH_FIXTURE_PORT ?? 4319);
const allowed = new Set([
  "rea_workbench",
  "start_investigation",
  "read_investigation",
  "cancel_investigation",
  "get_evidence_bundle",
  "list_unknowns",
  "inspect_analysis_view",
  "import_evidence_bundle",
  "export_evidence_bundle",
]);
const http = createHttpServer(async (req, res) => {
  try {
    if (
      req.headers.host !== `127.0.0.1:${port}` ||
      (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${port}`)
    ) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (req.url === "/" && req.method === "GET") {
      res.setHeader("Content-Type", "text/html");
      res.end(host);
      return;
    }
    if (req.url?.startsWith("/app") && req.method === "GET") {
      const result = await client.readResource({
        uri: "ui://rea/workbench.html",
      });
      res.setHeader("Content-Type", "text/html");
      res.end(result.contents[0].text);
      return;
    }
    if (req.url === "/tool" && req.method === "POST") {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1048576) throw new Error("Fixture request too large");
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!allowed.has(input.name)) throw new Error("Fixture tool denied");
      if (
        input.name.endsWith("_evidence_bundle") &&
        input.name !== "get_evidence_bundle" &&
        ![
          resolve(fixtureRoot, "input.json"),
          resolve(fixtureRoot, "output.json"),
        ].includes(input.arguments?.path)
      )
        throw new Error(
          "Fixture allows only its input.json and output.json paths",
        );
      const result = await client.callTool(input);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
      return;
    }
    res.writeHead(404);
    res.end();
  } catch (error) {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        isError: true,
        content: [{ type: "text", text: error.message }],
      }),
    );
  }
});
http.listen(port, "127.0.0.1", () =>
  console.log(
    `Fixture ready: http://127.0.0.1:${port} (simulated models; no live provider)`,
  ),
);
async function stop() {
  http.close();
  await client.close();
  await server.close();
  await session.close();
}
process.once("SIGINT", () => {
  void stop();
});
process.once("SIGTERM", () => {
  void stop();
});
