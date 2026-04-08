import { describe, it, expect } from "vitest";
import {
  validateConfig,
  type NexusAccountConfig,
} from "../src/config.js";

/** Helper to build a minimal valid websocket config. */
function validWsConfig(): NexusAccountConfig {
  return {
    agentToken: "nxa_test_token_123",
    serverUrl: "https://api.nexus-dev.xsyphon.com",
    deliveryMode: "websocket",
  };
}

/** Helper to build a minimal valid webhook config. */
function validWhConfig(): NexusAccountConfig {
  return {
    agentToken: "nxa_test_token_123",
    serverUrl: "http://localhost:8443",
    deliveryMode: "webhook",
    webhook: {
      webhookSecret: "secret123",
      port: 3000,
    },
  };
}

describe("validateConfig", () => {
  // ---- happy paths ----

  it("accepts a valid websocket config", () => {
    const result = validateConfig(validWsConfig());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.config.deliveryMode).toBe("websocket");
    }
  });

  it("accepts a valid webhook config", () => {
    const result = validateConfig(validWhConfig());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.config.deliveryMode).toBe("webhook");
    }
  });

  it("defaults deliveryMode to websocket when omitted", () => {
    const { deliveryMode: _, ...rest } = validWsConfig();
    const result = validateConfig(rest);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.config.deliveryMode).toBe("websocket");
    }
  });

  // ---- agentToken ----

  it("rejects missing agentToken", () => {
    const { agentToken: _, ...rest } = validWsConfig();
    const result = validateConfig(rest);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "agentToken" }),
        ]),
      );
    }
  });

  it("rejects agentToken without nxa_ prefix", () => {
    const result = validateConfig({ ...validWsConfig(), agentToken: "bad_token" });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0].field).toBe("agentToken");
      expect(result.errors[0].message).toContain("nxa_");
    }
  });

  // ---- serverUrl ----

  it("rejects missing serverUrl", () => {
    const { serverUrl: _, ...rest } = validWsConfig();
    const result = validateConfig(rest);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "serverUrl" }),
        ]),
      );
    }
  });

  it("rejects non-HTTP/HTTPS serverUrl", () => {
    const result = validateConfig({ ...validWsConfig(), serverUrl: "ftp://bad.url" });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0].field).toBe("serverUrl");
    }
  });

  it("rejects malformed serverUrl", () => {
    const result = validateConfig({ ...validWsConfig(), serverUrl: "not-a-url" });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0].field).toBe("serverUrl");
    }
  });

  // ---- webhook mode validation ----

  it("rejects webhook mode without webhook config", () => {
    const result = validateConfig({
      ...validWsConfig(),
      deliveryMode: "webhook",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "webhook" }),
        ]),
      );
    }
  });

  it("rejects webhook mode with missing webhookSecret", () => {
    const result = validateConfig({
      ...validWsConfig(),
      deliveryMode: "webhook",
      webhook: { webhookSecret: "", port: 3000 },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "webhook.webhookSecret" }),
        ]),
      );
    }
  });

  it("rejects webhook mode with invalid port", () => {
    const result = validateConfig({
      ...validWsConfig(),
      deliveryMode: "webhook",
      webhook: { webhookSecret: "secret", port: 0 },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "webhook.port" }),
        ]),
      );
    }
  });

  // ---- multiple errors ----

  it("collects multiple errors at once", () => {
    const result = validateConfig({});
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const fields = result.errors.map((e) => e.field);
      expect(fields).toContain("agentToken");
      expect(fields).toContain("serverUrl");
    }
  });

  // ---- preserves optional websocket config ----

  it("preserves optional websocket tuning params", () => {
    const cfg = {
      ...validWsConfig(),
      websocket: { heartbeatInterval: 15000, reconnectBaseDelay: 500 },
    };
    const result = validateConfig(cfg);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.config.websocket?.heartbeatInterval).toBe(15000);
      expect(result.config.websocket?.reconnectBaseDelay).toBe(500);
    }
  });
});
