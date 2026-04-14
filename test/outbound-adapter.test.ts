import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NexusClient } from "../src/nexus-api/client.js";
import { MessageType } from "../src/nexus-api/index.js";
import { NexusOutboundAdapter } from "../src/outbound/adapter.js";

// ---------------------------------------------------------------------------
// Mock NexusClient
// ---------------------------------------------------------------------------

function createMockClient(overrides: Partial<NexusClient> = {}): NexusClient {
  return {
    discoverGatewayUrl: vi.fn().mockResolvedValue("wss://gw.test/ws"),
    sendMessage: vi.fn().mockResolvedValue({ messageId: 1n, createdAt: 0n }),
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

describe("NexusOutboundAdapter", () => {
  // ---- sendText ----

  describe("sendText", () => {
    it("sends a plain text message", async () => {
      const client = createMockClient();
      const adapter = new NexusOutboundAdapter(client);

      await adapter.sendText({ conversationId: 42 }, "hello");

      expect(client.sendMessage).toHaveBeenCalledTimes(1);
      const req = (client.sendMessage as any).mock.calls[0][0];
      expect(req.conversationId).toBe(42n);
    });

    it("auto-detects markdown and sets type accordingly", async () => {
      const client = createMockClient();
      const adapter = new NexusOutboundAdapter(client);

      await adapter.sendText({ conversationId: 1 }, "# Heading\nSome text");

      const req = (client.sendMessage as any).mock.calls[0][0];
      expect(req.body.type).toBe(MessageType.MARKDOWN);
      expect(req.body.content.case).toBe("markdown");
    });

    it("sends plain text when no markdown detected", async () => {
      const client = createMockClient();
      const adapter = new NexusOutboundAdapter(client);

      await adapter.sendText({ conversationId: 1 }, "just plain text");

      const req = (client.sendMessage as any).mock.calls[0][0];
      expect(req.body.type).toBe(MessageType.TEXT);
      expect(req.body.content.case).toBe("text");
    });

    it("respects forceMarkdown option", async () => {
      const client = createMockClient();
      const adapter = new NexusOutboundAdapter(client);

      await adapter.sendText({ conversationId: 1 }, "plain", { forceMarkdown: true });

      const req = (client.sendMessage as any).mock.calls[0][0];
      expect(req.body.type).toBe(MessageType.MARKDOWN);
    });
  });

  // ---- retry logic ----

  describe("retry logic", () => {
    it("retries on transient error and succeeds", async () => {
      const sendMessage = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce({ messageId: 1n });
      const client = createMockClient({ sendMessage });
      const adapter = new NexusOutboundAdapter(client);

      await adapter.sendText({ conversationId: 1 }, "hi");

      expect(sendMessage).toHaveBeenCalledTimes(2);
    });

    it("throws immediately on UNAUTHENTICATED", async () => {
      const sendMessage = vi.fn().mockRejectedValue(new ConnectError("bad token", Code.Unauthenticated));
      const client = createMockClient({ sendMessage });
      const adapter = new NexusOutboundAdapter(client);

      await expect(adapter.sendText({ conversationId: 1 }, "hi")).rejects.toThrow("bad token");

      // Should not retry.
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it("silently skips on NOT_FOUND", async () => {
      const sendMessage = vi.fn().mockRejectedValue(new ConnectError("not found", Code.NotFound));
      const client = createMockClient({ sendMessage });
      const adapter = new NexusOutboundAdapter(client);

      // Should not throw.
      await adapter.sendText({ conversationId: 1 }, "hi");
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  // ---- sendCard ----

  describe("sendCard", () => {
    it("sends a card message", async () => {
      const client = createMockClient();
      const adapter = new NexusOutboundAdapter(client);

      await adapter.sendCard({ conversationId: 10 }, '{"type":"AdaptiveCard"}');

      const req = (client.sendMessage as any).mock.calls[0][0];
      expect(req.body.content.case).toBe("card");
    });
  });

  // ---- answerCardAction ----

  describe("answerCardAction", () => {
    it("calls answerCardAction on the client", async () => {
      const client = createMockClient();
      const adapter = new NexusOutboundAdapter(client);

      await adapter.answerCardAction("action-1", "done", true);

      expect(client.answerCardAction).toHaveBeenCalledTimes(1);
    });
  });

  // ---- sendMedia ----

  describe("sendMedia", () => {
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, "fetch") as unknown as typeof fetchSpy;
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it("uploads file and sends media message on success", async () => {
      fetchSpy.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
      const client = createMockClient();
      const adapter = new NexusOutboundAdapter(client);

      await adapter.sendMedia(
        { conversationId: 5 },
        {
          url: "https://example.com/photo.jpg",
          type: "image",
        },
      );

      expect(client.uploadFile).toHaveBeenCalledTimes(1);
      expect(client.sendMessage).toHaveBeenCalledTimes(1);
      const req = (client.sendMessage as any).mock.calls[0][0];
      expect(req.body.content.case).toBe("image");
    });

    it("falls back to text link when upload fails", async () => {
      fetchSpy.mockRejectedValueOnce(new Error("network error"));
      const client = createMockClient();
      const adapter = new NexusOutboundAdapter(client);

      await adapter.sendMedia(
        { conversationId: 5 },
        {
          url: "https://example.com/doc.pdf",
          type: "file",
        },
      );

      // Should fall back to sendText (sendMessage with text type).
      expect(client.sendMessage).toHaveBeenCalledTimes(1);
      const req = (client.sendMessage as any).mock.calls[0][0];
      // Fallback sends as markdown link.
      expect(req.body.content.case).toBe("markdown");
    });
  });
});
