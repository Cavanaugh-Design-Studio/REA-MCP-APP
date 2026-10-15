import { build } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { fileURLToPath } from "node:url";

await build({
  configFile: false,
  root: fileURLToPath(new URL("../ui", import.meta.url)),
  plugins: [viteSingleFile()],
  build: {
    outDir: fileURLToPath(new URL("../dist/ui", import.meta.url)),
    emptyOutDir: false,
    rollupOptions: {
      input: fileURLToPath(new URL("../ui/workbench.html", import.meta.url)),
    },
  },
});
