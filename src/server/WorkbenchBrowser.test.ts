import { expect, it } from "vitest";
import { WorkbenchBrowser } from "./WorkbenchBrowser.js";

it("releases consumed ticket bytes and bounds authenticated concurrent browser requests independently", async () => {
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready: () => void = () => {};
  const twoRequests = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let calls = 0;
  const browser = new WorkbenchBrowser(
    new URL("../../dist/ui/workbench.html", import.meta.url),
    async () => {
      calls += 1;
      if (calls === 2) ready();
      await pending;
      return { content: [] };
    },
  );
  try {
    const payload = { question: "x".repeat(6 * 1024 * 1024) };
    const first = await browser.open(payload);
    if (!first.ok) throw first.error;
    expect((await browser.open(payload)).ok).toBe(true);
    const exceeded = await browser.open(payload);
    expect(exceeded.ok).toBe(false);
    if (!exceeded.ok) expect(exceeded.error.message).toContain("capacity");
    const url = new URL(first.value);
    const headers = { Origin: url.origin, "Content-Type": "application/json" };
    const claimed = await fetch(`${url.origin}/session`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ticket: new URLSearchParams(url.hash.slice(1)).get("handoff"),
      }),
    });
    expect(claimed.status).toBe(200);
    await claimed.json();
    expect((await browser.open(payload)).ok).toBe(true);
    const cookie = claimed.headers.get("set-cookie")!.split(";")[0]!;
    const request = () =>
      fetch(`${url.origin}/tool`, {
        method: "POST",
        headers: { ...headers, Cookie: cookie },
        body: JSON.stringify({ name: "get_session", arguments: {} }),
      });
    const firstRequest = request();
    const secondRequest = request();
    await twoRequests;
    expect((await request()).status).toBe(429);
    expect(calls).toBe(2);
    release();
    expect((await firstRequest).status).toBe(200);
    expect((await secondRequest).status).toBe(200);
    expect((await request()).status).toBe(200);
  } finally {
    release();
    await browser.close();
  }
});
