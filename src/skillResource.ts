import { readFile } from "node:fs/promises";

export const LEANREA_RESOURCE_URI = "rea://internal/skills/leanrea";

/** Package-relative: independent of the host's cwd and installed skills. */
export const readBundledLeanrea = (): Promise<string> =>
  readFile(new URL("../leanrea/SKILL.md", import.meta.url), "utf8");
