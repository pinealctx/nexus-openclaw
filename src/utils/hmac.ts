import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Compute an HMAC-SHA256 signature for a webhook payload.
 *
 * Signature = HMAC-SHA256(secret, timestamp + "." + body) as hex.
 */
export function computeSignature(
  secret: string,
  timestamp: string,
  body: string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

/**
 * Verify an HMAC-SHA256 signature using timing-safe comparison.
 *
 * The `signature` parameter may carry a `sha256=` prefix which is
 * stripped before comparison.
 */
export function verifySignature(
  secret: string,
  timestamp: string,
  body: string,
  signature: string,
): boolean {
  const expected = computeSignature(secret, timestamp, body);
  const actual = signature.startsWith("sha256=")
    ? signature.slice("sha256=".length)
    : signature;

  if (expected.length !== actual.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}
