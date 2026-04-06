/**
 * Generate a globally unique client_message_id (bigint).
 *
 * Layout: upper 42 bits = timestamp in ms, lower 22 bits = counter.
 * This guarantees uniqueness within a single process lifetime.
 */

let lastTimestamp = 0n;
let counter = 0n;

const COUNTER_BITS = 22n;
const COUNTER_MASK = (1n << COUNTER_BITS) - 1n;

export function generateClientMessageId(): bigint {
  const now = BigInt(Date.now());

  if (now === lastTimestamp) {
    counter = (counter + 1n) & COUNTER_MASK;
  } else {
    lastTimestamp = now;
    counter = 0n;
  }

  return (now << COUNTER_BITS) | counter;
}
