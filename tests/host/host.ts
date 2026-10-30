import {
  AppBridge,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { CallToolResultSchema } from "@modelcontextprotocol/core";

const frame = document.querySelector("iframe")!;
const status = document.querySelector("#host-status")!;
let theme: "dark" | "light" = "dark";
let bridge: AppBridge;
let currentMode: "inline" | "fullscreen" = "inline";
const hostMode = () =>
  (document.querySelector("#host-mode") as HTMLSelectElement).value;
const linkMode = () =>
  (document.querySelector("#link-mode") as HTMLSelectElement).value;
async function attach() {
  if (bridge) await bridge.close();
  bridge = new AppBridge(
    null,
    { name: "REA verification fixture", version: "1" },
    {
      serverTools: {},
      message: {},
      downloadFile: {},
      ...(linkMode() === "unavailable" ? {} : { openLinks: {} }),
    },
    {
      hostContext: {
        theme,
        displayMode: "inline",
        availableDisplayModes:
          hostMode() === "omitted" ? ["inline"] : ["inline", "fullscreen"],
      },
    },
  );
  bridge.oncalltool = async (params) => {
    const response = await fetch("/tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    return CallToolResultSchema.parse(await response.json());
  };
  bridge.onmessage = async ({ content }) => {
    status.textContent = `Main-agent handoff received: ${content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join(" ")}`;
    return {};
  };
  bridge.ondownloadfile = async ({ contents }) => {
    const resource = contents[0];
    if (resource?.type !== "resource" || !("text" in resource.resource))
      return { isError: true };
    const report = JSON.parse(resource.resource.text);
    status.textContent = `Report exported: ${report.sources.length} complete sources · ${report.state}`;
    const url = URL.createObjectURL(
      new Blob([resource.resource.text], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `rea-${report.run_id}.json`;
    link.click();
    URL.revokeObjectURL(url);
    return {};
  };
  bridge.onrequestdisplaymode = async ({ mode }) => {
    if (hostMode() === "reject")
      throw new Error("Fixture host rejected fullscreen");
    if (hostMode() === "timeout") return new Promise(() => {});
    if (hostMode() === "inline") return { mode: "inline" };
    currentMode = mode === "fullscreen" ? "fullscreen" : "inline";
    frame.classList.toggle("fullscreen", currentMode === "fullscreen");
    bridge.setHostContext({ displayMode: currentMode });
    return { mode };
  };
  bridge.onopenlink = async ({ url }) => {
    if (linkMode() === "reject")
      throw new Error("Fixture host rejected browser link");
    if (linkMode() === "timeout") return new Promise(() => {});
    if (linkMode() === "denied") return { isError: true };
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open live browser workbench";
    status.replaceChildren(link);
    return {};
  };
  bridge.oninitialized = () => {
    status.textContent =
      "MCP Apps bridge connected · production server / verification host";
  };
  await bridge.connect(
    new PostMessageTransport(frame.contentWindow!, frame.contentWindow!),
  );
  frame.src = `/app?reload=${Date.now()}`;
}
document.querySelector("#host-theme")!.addEventListener("click", () => {
  theme = theme === "dark" ? "light" : "dark";
  bridge.setHostContext({
    theme,
    availableDisplayModes:
      hostMode() === "omitted" ? ["inline"] : ["inline", "fullscreen"],
    displayMode: currentMode,
  });
});
document.querySelector("#host-mode")!.addEventListener("change", () => {
  bridge.setHostContext({
    availableDisplayModes:
      hostMode() === "omitted" ? ["inline"] : ["inline", "fullscreen"],
  });
});
document.querySelector("#link-mode")!.addEventListener("change", () => {
  void attach();
});
document.querySelector("#mobile")!.addEventListener("click", () => {
  frame.style.width = frame.style.width === "400px" ? "100%" : "400px";
});
document.querySelector("#reload")!.addEventListener("click", () => {
  void attach();
});
document.querySelector("#chat-start")!.addEventListener("click", () => {
  void (async () => {
    const args = {
      question: "Explain the chat-started assignment",
      sources: [],
      review: false,
    };
    await bridge.sendToolInput({ arguments: args });
    const response = await fetch("/tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "start_investigation", arguments: args }),
    });
    await bridge.sendToolResult(
      CallToolResultSchema.parse(await response.json()),
    );
    status.textContent = "Chat-started acknowledgment delivered to App";
  })();
});
void attach();
