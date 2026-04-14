import { describe, expect, it } from "vitest";
import { computeSignature, verifySignature } from "../src/utils/hmac.js";
import { generateClientMessageId } from "../src/utils/id-gen.js";
import { isMarkdown } from "../src/utils/markdown-detect.js";
import { buildSessionKey } from "../src/utils/session-key.js";

// ---------------------------------------------------------------------------
// 3.1 — buildSessionKey
// ---------------------------------------------------------------------------
describe("buildSessionKey", () => {
  it("produces the correct format", () => {
    expect(buildSessionKey(123, 456)).toBe("agent:123:nexus:456");
  });

  it("is deterministic for the same inputs", () => {
    const a = buildSessionKey(1, 2);
    const b = buildSessionKey(1, 2);
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// 3.3 — HMAC signature utilities
// ---------------------------------------------------------------------------
describe("computeSignature / verifySignature", () => {
  const secret = "test-secret";
  const ts = "1700000000";
  const body = '{"event":"hello"}';

  it("compute then verify round-trips", () => {
    const sig = computeSignature(secret, ts, body);
    expect(verifySignature(secret, ts, body, sig)).toBe(true);
  });

  it("accepts signature with sha256= prefix", () => {
    const sig = computeSignature(secret, ts, body);
    expect(verifySignature(secret, ts, body, `sha256=${sig}`)).toBe(true);
  });

  it("rejects a wrong signature", () => {
    expect(verifySignature(secret, ts, body, "bad")).toBe(false);
  });

  it("rejects when secret differs", () => {
    const sig = computeSignature(secret, ts, body);
    expect(verifySignature("other-secret", ts, body, sig)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3.5 — isMarkdown
// ---------------------------------------------------------------------------
describe("isMarkdown", () => {
  it("detects headings", () => {
    expect(isMarkdown("# Title")).toBe(true);
    expect(isMarkdown("## Subtitle")).toBe(true);
  });

  it("detects bold", () => {
    expect(isMarkdown("some **bold** text")).toBe(true);
  });

  it("detects italic with asterisk", () => {
    expect(isMarkdown("some *italic* text")).toBe(true);
  });

  it("detects italic with underscore", () => {
    expect(isMarkdown("some _italic_ text")).toBe(true);
  });

  it("detects fenced code blocks", () => {
    expect(isMarkdown("```\ncode\n```")).toBe(true);
  });

  it("detects inline code", () => {
    expect(isMarkdown("use `foo()` here")).toBe(true);
  });

  it("detects links", () => {
    expect(isMarkdown("[click](https://example.com)")).toBe(true);
  });

  it("detects unordered lists", () => {
    expect(isMarkdown("- item one")).toBe(true);
    expect(isMarkdown("* item one")).toBe(true);
  });

  it("detects ordered lists", () => {
    expect(isMarkdown("1. first")).toBe(true);
  });

  it("detects horizontal rules", () => {
    expect(isMarkdown("---")).toBe(true);
  });

  it("returns false for plain text", () => {
    expect(isMarkdown("Hello, world!")).toBe(false);
    expect(isMarkdown("No markdown here.")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3.7 — generateClientMessageId
// ---------------------------------------------------------------------------
describe("generateClientMessageId", () => {
  it("returns a bigint", () => {
    expect(typeof generateClientMessageId()).toBe("bigint");
  });

  it("generates unique ids across rapid calls", () => {
    const ids = new Set<bigint>();
    for (let i = 0; i < 1000; i++) {
      ids.add(generateClientMessageId());
    }
    expect(ids.size).toBe(1000);
  });
});
