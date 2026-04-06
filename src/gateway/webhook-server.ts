import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { WebhookConfig } from "../config.js";
import { verifySignature } from "../utils/hmac.js";

const TIMESTAMP_TOLERANCE_SEC = 300; // 5 minutes

type EventHandler = (event: unknown) => void;

export class WebhookServer {
  private readonly config: WebhookConfig;
  private server: Server | null = null;
  private eventHandlers: EventHandler[] = [];

  constructor(config: WebhookConfig) {
    this.config = config;
  }

  onEvent(handler: EventHandler): void {
    this.eventHandlers.push(handler);
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    const server = createServer((req, res) => {
      this.handleRequest(req, res);
    });

    const host = this.config.host ?? "0.0.0.0";
    const port = this.config.port;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });

    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    this.server = null;

    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const expectedPath = this.config.path ?? "/webhook";
    if (req.method !== "POST" || req.url !== expectedPath) {
      res.writeHead(404);
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf-8");
      this.processBody(req, res, rawBody);
    });
  }

  private processBody(req: IncomingMessage, res: ServerResponse, rawBody: string): void {
    const signature = req.headers["x-nexus-signature"] as string | undefined;
    const timestamp = req.headers["x-nexus-timestamp"] as string | undefined;

    if (!signature || !timestamp) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "missing signature or timestamp header" }));
      return;
    }

    // Validate timestamp within 5-minute window
    const tsSeconds = Number(timestamp);
    if (Number.isNaN(tsSeconds)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid timestamp" }));
      return;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - tsSeconds) > TIMESTAMP_TOLERANCE_SEC) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "timestamp outside acceptable window" }));
      return;
    }

    // Verify HMAC-SHA256 signature
    if (!verifySignature(this.config.webhookSecret, timestamp, rawBody, signature)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid signature" }));
      return;
    }

    // Parse JSON body
    let event: unknown;
    try {
      event = JSON.parse(rawBody) as unknown;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid JSON body" }));
      return;
    }

    // Respond 200 before dispatching to handlers
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));

    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }
}
