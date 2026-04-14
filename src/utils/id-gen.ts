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
    if (counter === 0n) {
      // Counter wrapped within the same millisecond — spin until next ms.
      // This is extremely unlikely (~4M calls/ms) but prevents duplicate IDs.
      let next = BigInt(Date.now());
      while (next === lastTimestamp) {
        next = BigInt(Date.now());
      }
      lastTimestamp = next;
      return (next << COUNTER_BITS) | counter;
    }
  } else {
    lastTimestamp = now;
    counter = 0n;
  }

  return (now << COUNTER_BITS) | counter;
}
