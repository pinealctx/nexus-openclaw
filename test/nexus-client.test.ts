import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConnectError, Code } from "@connectrpc/connect";
import {
  NexusClient,
  createNexusClient,
  toNum,
  toBid,
  toBidOpt,
} from "../src/nexus-api/client.js";
import type { NexusAccountConfig } from "../src/config.js";
import {
  SendMessageRequestSchema,
  GetDownloadURLRequestSchema,
  UploadFileRequestSchema,
  WebhookDeliveryConfigSchema,
  SetDeliveryConfigRequestSchema,
} from "../src/nexus-api/index.js";
import { create } from "@bufbuild/protobuf";

function validConfig(): NexusAccountConfig {
  return {
    agentToken: "nxa_test_token_abc",
    serverUrl: "https://api.nexus-dev.xsyphon.com",
    deliveryMode: "websocket",
  };
}

/**
 * Build a mock Connect RPC success response (JSON mode).
 * Body should be proto-json of the output message.
 */
function mockConnectResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Build a mock Connect RPC error response.
 */
function mockConnectError(
  code: string,
  message: string,
  status: number,
): Response {
  return new Response(JSON.stringify({ code, message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("NexusClient", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch") as unknown as typeof fetchSpy;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // -- factory --

  it("createNexusClient returns a NexusClient instance", () => {
    const client = createNexusClient(validConfig());
    expect(client).toBeInstanceOf(NexusClient);
  });

  // -- discoverGatewayUrl --

  it("discovers gateway URL and replaces /ws with /ws/agent", async () => {
    // GetClientConfig is called on the no-auth transport.
    fetchSpy.mockResolvedValueOnce(
      mockConnectResponse({
        gateway: { wsUrl: "wss://ws.nexus-dev.xsyphon.com/ws" },
      }),
    );

    const client = new NexusClient(validConfig());
    const url = await client.discoverGatewayUrl();

    expect(url).toBe("wss://ws.nexus-dev.xsyphon.com/ws/agent");

    // Verify no Authorization header on GetClientConfig (public endpoint).
    const [rpcUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(rpcUrl).toContain("AuthService/GetClientConfig");
    const headers = init.headers as Headers;
    expect(headers.get("Authorization")).toBeNull();
  });

  it("throws when gateway ws_url is missing", async () => {
    fetchSpy.mockResolvedValueOnce(mockConnectResponse({ gateway: {} }));

    const client = new NexusClient(validConfig());
    await expect(client.discoverGatewayUrl()).rejects.toThrow(
      "GetClientConfig did not return a gateway ws_url",
    );
  });

  // -- sendMessage --

  it("sendMessage calls MessageService/SendMessage and returns response", async () => {
    // Connect RPC returns proto-json with int64 fields as strings.
    fetchSpy.mockResolvedValueOnce(
      mockConnectResponse({
        messageId: "100",
        createdAt: "1700000000000",
      }),
    );

    const client = new NexusClient(validConfig());
    const req = create(SendMessageRequestSchema, {
      clientMessageId: 1n,
      conversationId: 10n,
    });
    const res = await client.sendMessage(req);

    expect(res.messageId).toBe(100n);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("api.v1.MessageService/SendMessage");
    expect((init.headers as Headers).get("Authorization")).toBe(
      "Bearer nxa_test_token_abc",
    );
  });

  // -- uploadFile --

  it("uploadFile calls MediaService/UploadFile and returns response", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockConnectResponse({
        file: { fileId: "f1" },
      }),
    );

    const client = new NexusClient(validConfig());
    const res = await client.uploadFile(
      create(UploadFileRequestSchema, {
        fileName: "test.png",
        contentType: "image/png",
        purpose: 1, // MediaPurpose.MESSAGE
        data: new Uint8Array([1, 2, 3]),
      }),
    );

    expect(res.file?.fileId).toBe("f1");

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("api.v1.MediaService/UploadFile");
  });

  // -- getDownloadUrl --

  it("getDownloadUrl calls MediaService/GetDownloadURL and returns response", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockConnectResponse({
        url: "https://cdn.test/file",
        expiresAt: "9999",
      }),
    );

    const client = new NexusClient(validConfig());
    const req = create(GetDownloadURLRequestSchema, { fileId: "f1" });
    const res = await client.getDownloadUrl(req);

    expect(res.url).toBe("https://cdn.test/file");

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("api.v1.MediaService/GetDownloadURL");
  });

  // -- setDeliveryConfig --

  it("setDeliveryConfig calls AgentService/SetDeliveryConfig", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockConnectResponse({
        webhookSecret: "secret123",
      }),
    );

    const client = new NexusClient(validConfig());
    const res = await client.setDeliveryConfig(
      create(SetDeliveryConfigRequestSchema, {
        config: {
          case: "webhook",
          value: create(WebhookDeliveryConfigSchema, {
            url: "https://my.hook/endpoint",
          }),
        },
      }),
    );

    expect(res.webhookSecret).toBe("secret123");

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("api.v1.AgentService/SetDeliveryConfig");
  });

  // -- Connect RPC error handling --

  it("throws ConnectError on non-2xx response", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockConnectError("not_found", "conversation not found", 404),
    );

    const client = new NexusClient(validConfig());

    try {
      await client.sendMessage(
        create(SendMessageRequestSchema, {
          clientMessageId: 1n,
          conversationId: 10n,
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectError);
      const connectErr = err as ConnectError;
      expect(connectErr.code).toBe(Code.NotFound);
      expect(connectErr.message).toContain("conversation not found");
    }
  });

  it("throws ConnectError with Unauthenticated code for 401", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockConnectError("unauthenticated", "invalid token", 401),
    );

    const client = new NexusClient(validConfig());

    try {
      await client.sendMessage(
        create(SendMessageRequestSchema, {
          clientMessageId: 1n,
          conversationId: 10n,
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectError);
      expect((err as ConnectError).code).toBe(Code.Unauthenticated);
    }
  });

  // -- int64 boundary helpers --

  describe("int64 helpers", () => {
    it("toNum converts bigint to number", () => {
      expect(toNum(42n)).toBe(42);
      expect(toNum(undefined)).toBe(0);
      expect(toNum(0n)).toBe(0);
    });

    it("toBid converts number to bigint", () => {
      expect(toBid(42)).toBe(42n);
      expect(toBid(0)).toBe(0n);
    });

    it("toBidOpt converts optional number to optional bigint", () => {
      expect(toBidOpt(42)).toBe(42n);
      expect(toBidOpt(undefined)).toBeUndefined();
    });
  });

  // -- toString (token masking) --

  it("masks token in toString output", () => {
    const client = new NexusClient(validConfig());
    const str = client.toString();
    expect(str).toContain("nxa_");
    expect(str).not.toContain("nxa_test_token_abc");
    expect(str).toContain("***");
  });
});
