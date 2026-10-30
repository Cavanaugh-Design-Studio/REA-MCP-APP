import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve, relative } from "node:path";
import { createRequire } from "node:module";
import { appRoot, originalRoot } from "./acceptance-paths.mjs";

// Deliberate source reuse, never a dependency on the original runtime/catalog.
const original = await originalRoot(process.argv[2]);
const parser = createRequire(join(original, "package.json"))("@babel/parser");
const roots = [
  "src/application/javascript/JavaScriptApplicationService.ts",
  "src/composition/javascriptAnalysisWorkerProcess.ts",
  "src/dotnet/ManagedArtifactInspector.ts",
  "src/dotnet/ManagedMemberInspector.ts",
  "src/dotnet/ManagedNativeBoundaryInspector.ts",
  "src/dotnet/ManagedStaticProvider.ts",
  "src/application/managed/ManagedApplicationGraphService.ts",
  "src/application/BinaryTargetResolver.ts",
  "src/composition/browserScenario.ts",
  "src/application/BrowserScenarioCaptureService.ts",
  "src/ghidra/GhidraProvider.ts",
  "src/adb/AdbDeviceOutput.ts",
  "src/adb/AdbShellOutput.ts",
];
const files = new Map(),
  packages = new Set();
async function visit(path) {
  path = resolve(original, path);
  if (files.has(path)) return;
  const source = await readFile(path, "utf8");
  files.set(path, source);
  const ast = parser.parse(source, {
    sourceType: "module",
    plugins: ["typescript", "importAttributes"],
  });
  const specs = new Set();
  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (
      [
        "ImportDeclaration",
        "ExportNamedDeclaration",
        "ExportAllDeclaration",
      ].includes(node.type) &&
      node.source
    )
      specs.add(node.source.value);
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Import" &&
      node.arguments[0]?.type === "StringLiteral"
    )
      specs.add(node.arguments[0].value);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const child of value) walk(child);
      else if (value && typeof value === "object") walk(value);
    }
  }
  walk(ast);
  for (const spec of specs) {
    if (spec.startsWith("."))
      await visit(resolve(dirname(path), spec.replace(/\.js$/u, ".ts")));
    else if (!spec.startsWith("node:") && !spec.startsWith("#"))
      packages.add(spec);
  }
}
for (const root of roots) await visit(root);
const forbidden = [...files.keys()].filter((path) =>
  /src\/(server|cli)\/|\/toolContracts\.ts$|\/parseConfig\.ts$/u.test(
    path.replaceAll("\\", "/"),
  ),
);
if (forbidden.length)
  throw new Error(
    `Unwanted registration/configuration dependency: ${forbidden.join(", ")}`,
  );
const digest = (source) => createHash("sha256").update(source).digest("hex");
const records = [];
for (const [path, source] of files) {
  const name = relative(original, path).replaceAll("\\", "/");
  const destination = name.replace(/^src\//u, "src/retained/");
  const output = join(appRoot, destination);
  let ported;
  try {
    ported = await readFile(output, "utf8");
  } catch (cause) {
    if (cause.code !== "ENOENT") throw cause;
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, source, { flag: "wx" });
    ported = source;
  }
  records.push({
    source: name,
    destination,
    bytes: Buffer.byteLength(source),
    sha256: digest(source),
    ported_sha256: digest(ported),
  });
}
const bridgeFiles = [
  "ReaGhidraBridge.java",
  "ReaGhidraExtensions.java",
  "ReaGhidraPrepareCom.java",
  "ReaGhidraNoReturnFix.java",
];
await mkdir(join(appRoot, "bridge/ghidra"), { recursive: true });
for (const name of bridgeFiles)
  await copyFile(
    join(original, "bridge/ghidra", name),
    join(appRoot, "bridge/ghidra", name),
  );
const report = {
  description:
    "Selected semantic parsers, graph builders, owned Ghidra protocol and browser scenario closure. No original MCP registration or provider catalog.",
  roots,
  packages: [...packages].sort(),
  files: records,
  bridge_files: bridgeFiles,
};
await writeFile(
  join(appRoot, "docs/capability-source-manifest.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      files: records.length,
      source_bytes: records.reduce((n, file) => n + file.bytes, 0),
      packages: report.packages,
      forbidden: forbidden.length,
    },
    null,
    2,
  ),
);
