import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { z } from "zod";
import { jsonObjectSchema } from "../domain/jsonValue.js";
import type { CallToolResult } from "@modelcontextprotocol/server";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { err, ok, type Result } from "../domain/result.js";
import { bufferedJsonParts, jsonParts } from "../domain/jsonSerialization.js";

const toolInput = z.strictObject({
  name: z.string(),
  arguments: jsonObjectSchema,
});
const ticketInput = z.strictObject({ ticket: z.string() });
// Edits and complete feature revisions are actual user-authored payloads.
// Bound one transfer and all unconsumed ticket snapshots separately.
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TICKET_BYTES = 16 * 1024 * 1024;
const token = () => randomBytes(32).toString("hex");
const same = (a: string, b: string) =>
  /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** A lazily owned loopback view of this connection, never a filesystem or general MCP proxy. */
export class WorkbenchBrowser {
  private server: Server | undefined;
  private opening: Promise<void> | undefined;
  private origin = "";
  private cookieName = "";
  private closed = false;
  private activeRequests = 0;
  private readonly tickets = new Map<
    string,
    { expires: number; state: unknown; bytes: number }
  >();
  private readonly sessions = new Set<string>();

  constructor(
    private readonly html: URL,
    private readonly call: (
      name: string,
      args: Record<string, unknown>,
    ) => Promise<CallToolResult> | CallToolResult,
  ) {}

  async open(state: unknown): Promise<Result<string, AnalysisError>> {
    try {
      return ok(await this.openUrl(state));
    } catch (cause) {
      if (cause instanceof AnalysisResourceConstraintError) return err(cause);
      return err(
        new AnalysisCapabilityUnavailableError(
          "rea",
          "rea_workbench",
          "Browser view unavailable. Build the UI and reconnect REA.",
          { cause },
        ),
      );
    }
  }

  private async openUrl(state: unknown): Promise<string> {
    if (this.closed) throw new Error("The REA connection has closed");
    const parts: string[] = [];
    let bytes = 0;
    for (const part of bufferedJsonParts(jsonParts(state))) {
      bytes += Buffer.byteLength(part);
      if (bytes > MAX_BYTES)
        throw new AnalysisResourceConstraintError(
          "rea_workbench",
          "transport",
          "Browser handoff exceeds 8 MiB",
          { max_bytes: MAX_BYTES },
        );
      parts.push(part);
    }
    const snapshot: unknown = JSON.parse(parts.join(""));
    // Check the packaged artifact before publishing a URL or opening a listener.
    await readFile(this.html);
    if (this.closed) throw new Error("The REA connection has closed");
    this.opening ??= this.listen().catch((cause: unknown) => {
      this.opening = undefined;
      throw cause;
    });
    await this.opening;
    if (this.closed) throw new Error("The REA connection has closed");
    for (const [id, entry] of this.tickets)
      if (entry.expires < Date.now()) this.tickets.delete(id);
    const retainedBytes = [...this.tickets.values()].reduce(
      (total, entry) => total + entry.bytes,
      0,
    );
    if (
      this.tickets.size >= 32 ||
      this.sessions.size >= 32 ||
      retainedBytes + bytes > MAX_TICKET_BYTES
    )
      throw new AnalysisResourceConstraintError(
        "rea_workbench",
        "memory",
        "Browser handoff capacity reached",
        { max_handoffs: 32, max_pending_bytes: MAX_TICKET_BYTES },
        { remediationAction: "Reconnect REA to release browser handoffs" },
      );
    const ticket = token();
    this.tickets.set(ticket, {
      state: snapshot,
      bytes,
      expires: Date.now() + 60000,
    });
    return `${this.origin}/workbench#handoff=${ticket}`;
  }

  private async listen(): Promise<void> {
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server = server;
    server.requestTimeout = 10000;
    server.headersTimeout = 10000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        const address = server.address();
        if (!address || typeof address === "string")
          return reject(new Error("Loopback address unavailable"));
        this.origin = `http://127.0.0.1:${address.port}`;
        // Cookies are host-scoped, not port-scoped: isolate concurrent REA connections.
        this.cookieName = `rea_workbench_${address.port}`;
        resolve();
      });
    });
    server.unref();
  }

  private async body(
    req: IncomingMessage,
    maxBytes = MAX_BYTES,
  ): Promise<unknown> {
    if (req.headers["content-type"] !== "application/json")
      throw new Error("Expected JSON");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) throw new Error("Request budget exceeded");
      chunks.push(buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const reject = (status: number) => {
      res.writeHead(status).end("REA browser request unavailable");
    };
    try {
      if (
        this.closed ||
        req.headers.host !== new URL(this.origin).host ||
        req.headers["sec-fetch-site"] === "cross-site"
      )
        return reject(403);
      if (req.method === "GET" && req.url === "/workbench") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader(
          "Content-Security-Policy",
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        );
        res.end(await readFile(this.html, "utf8"));
        return;
      }
      if (req.method !== "POST" || req.headers.origin !== this.origin)
        return reject(403);
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/session") {
        const { ticket } = ticketInput.parse(await this.body(req, 1024));
        const entry = this.tickets.get(ticket);
        this.tickets.delete(ticket);
        if (!entry || entry.expires < Date.now()) return reject(401);
        if (this.sessions.size >= 32) return reject(429);
        const id = token();
        this.sessions.add(id);
        res.setHeader(
          "Set-Cookie",
          `${this.cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/`,
        );
        res.end(JSON.stringify({ state: entry.state }));
        return;
      }
      const cookie =
        req.headers.cookie
          ?.split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith(`${this.cookieName}=`))
          ?.slice(this.cookieName.length + 1) ?? "";
      if (![...this.sessions].some((id) => same(id, cookie)))
        return reject(401);
      if (req.url !== "/tool") return reject(404);
      // Bound concurrent request buffers separately from pending handoff state.
      if (this.activeRequests >= 2) return reject(429);
      this.activeRequests += 1;
      try {
        const input = toolInput.parse(await this.body(req));
        res.end(JSON.stringify(await this.call(input.name, input.arguments)));
      } finally {
        this.activeRequests -= 1;
      }
    } catch {
      // Never echo request bodies, tickets, credentials or provider diagnostics.
      if (!res.headersSent) reject(400);
      else res.end();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.tickets.clear();
    this.sessions.clear();
    await this.opening?.catch(() => undefined);
    const server = this.server;
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((cause) => (cause ? reject(cause) : resolve()));
        server.closeAllConnections();
      });
      this.server = undefined;
    }
  }
}
