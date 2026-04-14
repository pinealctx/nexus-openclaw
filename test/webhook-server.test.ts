import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebhookServer } from "../src/gateway/webhook-server.js";
import { computeSignature } from "../src/utils/hmac.js";

const TEST_SECRET = "test-webhook-secret";
const TEST_PORT = 19876; // Unlikely to conflict.

function makeTimestamp(): string {
  return String(Math.floor(Date.now() / 1000));
}

async function postWebhook(
  port: number,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const ts = headers["x-nexus-timestamp"] ?? makeTimestamp();
  const sig = headers["x-nexus-signature"] ?? computeSignature(TEST_SECRET, ts, body);

  const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-nexus-timestamp": ts,
      "x-nexus-signature": sig,
      ...headers,
    },
    body,
  });

  return { status: res.status, body: await res.text() };
}

describe("WebhookServer", () => {
  let server: WebhookServer;

  beforeEach(async () => {
    server = new WebhookServer({
      secretKey: TEST_SECRET,
      port: TEST_PORT,
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("accepts valid webhook and dispatches event", async () => {
    const handler = vi.fn();
    server.onEvent(handler);

    const payload = JSON.stringify({ event: "test", data: 123 });
    const { status } = await postWebhook(TEST_PORT, payload);

    expect(status).toBe(200);
    // Give handler time to fire (it's sync but after response).
    await new Promise((r) => setTimeout(r, 10));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ event: "test", data: 123 });
  });

  it("rejects missing signature header", async () => {
    // Send without signature headers at all.
    try {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(401);
    } catch (err: any) {
      // On Windows, the server may reset the connection before the client reads the response.
      // This is acceptable — the server correctly rejected the request.
      expect(err.cause?.code).toBe("ECONNRESET");
    }
  });

  it("rejects invalid signature", async () => {
    const ts = makeTimestamp();
    const { status } = await postWebhook(TEST_PORT, "{}", {
      "x-nexus-timestamp": ts,
      "x-nexus-signature": "bad-signature",
    });
    expect(status).toBe(401);
  });

  it("rejects expired timestamp", async () => {
    const oldTs = String(Math.floor(Date.now() / 1000) - 600); // 10 min ago
    const body = "{}";
    const sig = computeSignature(TEST_SECRET, oldTs, body);
    const { status } = await postWebhook(TEST_PORT, body, {
      "x-nexus-timestamp": oldTs,
      "x-nexus-signature": sig,
    });
    expect(status).toBe(401);
  });

  it("rejects non-POST requests", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/webhook`, {
      method: "GET",
    });
    expect(res.status).toBe(404);
  });

  it("rejects wrong path", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/wrong-path`, {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("rejects invalid JSON body", async () => {
    const ts = makeTimestamp();
    const body = "not-json{{{";
    const sig = computeSignature(TEST_SECRET, ts, body);
    const { status } = await postWebhook(TEST_PORT, body, {
      "x-nexus-timestamp": ts,
      "x-nexus-signature": sig,
    });
    expect(status).toBe(400);
  });

  it("does not crash when handler throws", async () => {
    const badHandler = vi.fn().mockImplementation(() => {
      throw new Error("handler error");
    });
    const goodHandler = vi.fn();
    server.onEvent(badHandler);
    server.onEvent(goodHandler);

    const payload = JSON.stringify({ ok: true });
    const { status } = await postWebhook(TEST_PORT, payload);

    expect(status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(badHandler).toHaveBeenCalledTimes(1);
    expect(goodHandler).toHaveBeenCalledTimes(1);
  });
});
