import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { AnalysisProtocolError } from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { ok, err, type Result } from "../domain/result.js";
import { portableFeatureFilePathSchema } from "../domain/featureProject.js";

/** An absent output directory is acquired exclusively. A receipt is written only after every artifact. */
export const writeFeatureHandoff = async (
  path: string,
  files: Readonly<Record<string, string>>,
): Promise<
  Result<
    { path: string; files: { path: string; sha256: string; bytes: number }[] },
    AnalysisError
  >
> => {
  if (!isAbsolute(path))
    return err(
      new AnalysisProtocolError("Handoff output directory must be absolute"),
    );
  let acquired = false;
  try {
    await mkdir(path);
    acquired = true;
    const receipts = [];
    for (const [name, content] of Object.entries(files)) {
      if (
        !portableFeatureFilePathSchema.safeParse(name).success ||
        (name.includes("/") &&
          !name.startsWith("cases/") &&
          !name.startsWith("candidate/"))
      )
        throw new TypeError("Invalid handoff artifact name");
      const destination = join(path, name);
      if (name.includes("/"))
        await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content, { flag: "wx" });
      receipts.push({
        path: name,
        sha256: createHash("sha256").update(content).digest("hex"),
        bytes: Buffer.byteLength(content),
      });
    }
    const value = { path, files: receipts };
    await writeFile(
      join(path, "handoff-receipt.json"),
      JSON.stringify(value, null, 2) + "\n",
      { flag: "wx" },
    );
    return ok(value);
  } catch (cause) {
    return err(
      new AnalysisProtocolError(
        acquired
          ? `Handoff export is incomplete. Retained partial artifacts at ${path}; no complete receipt was published.`
          : "Handoff requires an absent output directory with an existing writable parent",
        { cause },
      ),
    );
  }
};
