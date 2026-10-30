import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createApp } from "./server.js";

export const run = async (): Promise<void> => {
  const runtime = await createApp();
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= runtime
      .close()
      .catch(() => {
        process.stderr.write(
          "REA shutdown retained incomplete owned cleanup; retry shutdown after inspecting the run reports.\n",
        );
        process.exitCode = 1;
      })
      .finally(() => {
        closing = undefined;
      });
    return closing;
  };
  process.on("SIGINT", () => {
    void close();
  });
  process.on("SIGTERM", () => {
    void close();
  });
  process.stdin.once("end", () => {
    void close();
  });
  await runtime.server.connect(new StdioServerTransport());
};
