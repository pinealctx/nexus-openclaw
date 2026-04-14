import { describe, expect, it, vi } from "vitest";
import type { NexusClient } from "../src/nexus-api/client.js";
import { NexusStreamAdapter } from "../src/outbound/stream.js";

function createMockClient(overrides: Partial<NexusClient> = {}): NexusClient {
  return {
    discoverGatewayUrl: vi.fn().mockResolvedValue("wss://gw.test/ws"),
    sendMessage: vi.fn().mockResolvedValue({ messageId: 100n, createdAt: 0n }),
    editMessage: vi.fn().mockResolvedValue({}),
    pushStreamDelta: vi.fn().mockResolvedValue(undefined),
    endStream: vi.fn().mockResolvedValue(undefined),
    errorStream: vi.fn().mockResolvedValue(undefined),
    answerCardAction: vi.fn().mockResolvedValue(undefined),
    uploadFile: vi.fn().mockResolvedValue({ file: { fileId: "f1" } }),
    getDownloadUrl: vi.fn().mockResolvedValue({ url: "https://cdn.test/file" }),
    toString: () => "MockNexusClient",
    ...overrides,
  } as unknown as NexusClient;
}

describe("NexusStreamAdapter", () => {
  describe("startStream", () => {
    it("creates a stream and returns a session", async () => {
      const client = createMockClient();
      const adapter = new NexusStreamAdapter(client);

      const session = await adapter.startStream({ conversationId: 42 });

      expect(session.messageId).toBe(100);
      expect(session.conversationId).toBe(42);
      expect(session.seq).toBe(0);
      expect(client.sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe("pushDelta", () => {
    it("increments seq and calls pushStreamDelta", async () => {
      const client = createMockClient();
      const adapter = new NexusStreamAdapter(client);
      const session = await adapter.startStream({ conversationId: 1 });

      await adapter.pushDelta(session, "hello ");
      expect(session.seq).toBe(1);
      expect(client.pushStreamDelta).toHaveBeenCalledTimes(1);

      await adapter.pushDelta(session, "world");
      expect(session.seq).toBe(2);
      expect(client.pushStreamDelta).toHaveBeenCalledTimes(2);
    });

    it("retries on failure with same seq", async () => {
      const pushStreamDelta = vi.fn().mockRejectedValueOnce(new Error("transient")).mockResolvedValueOnce(undefined);
      const client = createMockClient({ pushStreamDelta });
      const adapter = new NexusStreamAdapter(client);
      const session = await adapter.startStream({ conversationId: 1 });

      await adapter.pushDelta(session, "data");

      // seq should be 1 (incremented once, retried with same seq).
      expect(session.seq).toBe(1);
      expect(pushStreamDelta).toHaveBeenCalledTimes(2);
    });

    it("calls errorStream after consecutive failure threshold", async () => {
      const pushStreamDelta = vi.fn().mockRejectedValue(new Error("fail"));
      const errorStream = vi.fn().mockResolvedValue(undefined);
      const client = createMockClient({ pushStreamDelta, errorStream });
      const adapter = new NexusStreamAdapter(client);
      const session = await adapter.startStream({ conversationId: 1 });

      // Push 3 deltas — each will fail 3 times, accumulating consecutive failures.
      await adapter.pushDelta(session, "a");
      // After 3 consecutive failures, errorStream should be called.
      expect(errorStream).toHaveBeenCalledTimes(1);
    });
  });

  describe("endStream", () => {
    it("calls endStream on the client", async () => {
      const client = createMockClient();
      const adapter = new NexusStreamAdapter(client);
      const session = await adapter.startStream({ conversationId: 1 });

      await adapter.endStream(session, "full text");

      expect(client.endStream).toHaveBeenCalledTimes(1);
    });
  });

  describe("errorStream", () => {
    it("calls errorStream on the client", async () => {
      const client = createMockClient();
      const adapter = new NexusStreamAdapter(client);
      const session = await adapter.startStream({ conversationId: 1 });

      await adapter.errorStream(session, "something went wrong");

      expect(client.errorStream).toHaveBeenCalledTimes(1);
    });
  });
});
