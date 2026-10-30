import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Acceptance may read the original checkout, but never uses its credentials or
// runtime as an application dependency. All generated output belongs to this app.
export async function originalRoot(supplied) {
  const root = await realpath(supplied ?? join(appRoot, "..", "rea-main"));
  if (root === (await realpath(appRoot)))
    throw new Error("Original and MCP App must be distinct directories");
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (pkg.name !== "rea-agents")
    throw new Error(
      "Expected an original rea-agents checkout; pass its absolute path",
    );
  return root;
}

export async function assertPinnedNode() {
  const version = (await readFile(join(appRoot, ".nvmrc"), "utf8")).trim();
  if (process.version !== `v${version}`)
    throw new Error(`Use pinned Node ${version}; received ${process.version}`);
}

export function acceptanceEnvironment(extra = {}) {
  const allowed = new Set([
    "path",
    "pathext",
    "systemroot",
    "windir",
    "comspec",
    "temp",
    "tmp",
    "tmpdir",
    "home",
    "userprofile",
    "localappdata",
    "appdata",
    "lang",
    "lc_all",
  ]);
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) => allowed.has(key.toLowerCase()) && value !== undefined,
      ),
    ),
    REA_AI_ENABLED: "false",
    ...extra,
  };
}
