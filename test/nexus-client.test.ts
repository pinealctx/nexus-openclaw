import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  NexusClient,
  NexusRpcError,
  createNexusClient,
} from "../src/nexus-api/client.js";
import type { NexusAccountConfig } from "../src/config.js";

function validConfig(): NexusAccountConfig {
  return {
    agentToken: "nxa_test_token_abc",
    agentUserId: 42,
    serverUrl: "https://api.nexus.test",
    deliveryMode: "websocket",
  };
}

/** Build a mock Response. */
function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(body),
    headers: new Headers(),
  } as unknown as Response;
}

describe("NexusClient", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // -- factory --

  it("createNexusClient returns a NexusClient instance", () => {
    const client = createNexusClient(validConfig());
    expect(client).toBeInstanceOf(NexusClient);
  });

  // -- rpc basics --

  it("sends POST with correct URL, headers, and body", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ result: "ok" }));

    const client = new NexusClient(validConfig());
    const res = await client.rpc<{ foo: number }, { result: string }>(
      "api.v1.TestService",
      "TestMethod",
      { foo: 1 },
    );

    expect(res).toEqual({ result: "ok" });
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.nexus.test/api.v1.TestService/TestMethod");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer nxa_test_token_abc",
    );
    expect(init.body).toBe(JSON.stringify({ foo: 1 }));
  });

  it("omits Authorization header when skipAuth is true", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({}));

    const client = new NexusClient(validConfig());
    await client.rpc("api.v1.AuthService", "GetClientConfig", {}, true);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(
      (init.headers as Record<string, string>)["Authorization"],
    ).toBeUndefined();
  });

  it("strips trailing slash from serverUrl", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({}));

    const cfg = { ...validConfig(), serverUrl: "https://api.nexus.test/" };
    const client = new NexusClient(cfg);
    await client.rpc("api.v1.Svc", "M", {});

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.nexus.test/api.v1.Svc/M");
  });

  it("throws NexusRpcError on non-2xx response", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ code: "NOT_FOUND", message: "conversation not found" }, 404),
    );

    const client = new NexusClient(validConfig());

    try {
      await client.rpc("api.v1.MessageService", "SendMessage", {});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NexusRpcError);
      const rpcErr = err as NexusRpcError;
      expect(rpcErr.service).toBe("api.v1.MessageService");
      expect(rpcErr.method).toBe("SendMessage");
      expect(rpcErr.status).toBe(404);
      expect(rpcErr.code).toBe("NOT_FOUND");
      expect(rpcErr.detail).toBe("conversation not found");
    }
  });

  it("handles non-JSON error body gracefully", async () => {
    const badRes = {
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: () => Promise.reject(new Error("not json")),
      headers: new Headers(),
    } as unknown as Response;
    fetchSpy.mockResolvedValueOnce(badRes);

    const client = new NexusClient(validConfig());
    await expect(client.rpc("api.v1.Svc", "M", {})).rejects.toThrow(
      NexusRpcError,
    );
  });

  // -- discoverGatewayUrl --

  it("discovers gateway URL and replaces /ws with /ws/agent", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({
        gateway: { wsUrl: "ws://gateway.nexus.test:8444/ws" },
      }),
    );

    const client = new NexusClient(validConfig());
    const url = await client.discoverGatewayUrl();

    expect(url).toBe("ws://gateway.nexus.test:8444/ws/agent");

    // Verify it called GetClientConfig with skipAuth
    const [rpcUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(rpcUrl).toContain("AuthService/GetClientConfig");
    expect(
      (init.headers as Record<string, string>)["Authorization"],
    ).toBeUndefined();
  });

  it("throws when gateway ws_url is missing", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ gateway: {} }));

    const client = new NexusClient(validConfig());
    await expect(client.discoverGatewayUrl()).rejects.toThrow(
      "GetClientConfig did not return a gateway ws_url",
    );
  });

  // -- convenience methods --

  it("sendMessage calls MessageService/SendMessage", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ messageId: "100", createdAt: "1700000000000" }),
    );

    const client = new NexusClient(validConfig());
    const res = await client.sendMessage({
      clientMessageId: "1",
      conversationId: "10",
      body: { type: "MESSAGE_TYPE_TEXT", textContent: { text: "hello" } },
    });

    expect(res.messageId).toBe("100");
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("api.v1.MessageService/SendMessage");
  });

  it("uploadFile calls MediaService/UploadFile", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ file: { fileId: "f1" } }),
    );

    const client = new NexusClient(validConfig());
    const res = await client.uploadFile({
      fileName: "test.png",
      contentType: "image/png",
      purpose: "MESSAGE",
      data: "base64data",
    });

    expect(res.file?.fileId).toBe("f1");
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("api.v1.MediaService/UploadFile");
  });

  it("getDownloadUrl calls MediaService/GetDownloadURL", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ url: "https://cdn.test/file", expiresAt: "9999" }),
    );

    const client = new NexusClient(validConfig());
    const res = await client.getDownloadUrl({ fileId: "f1" });

    expect(res.url).toBe("https://cdn.test/file");
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("api.v1.MediaService/GetDownloadURL");
  });

  it("setDeliveryConfig calls AgentService/SetDeliveryConfig", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ webhookSecret: "secret123" }),
    );

    const client = new NexusClient(validConfig());
    const res = await client.setDeliveryConfig({
      webhook: { url: "https://my.hook/endpoint" },
    });

    expect(res.webhookSecret).toBe("secret123");
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("api.v1.AgentService/SetDeliveryConfig");
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
