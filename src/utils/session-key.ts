import type { SessionKey } from "../types.js";

/**
 * Build an OpenClaw session key for an agent–conversation pair.
 *
 * Format: `agent:{agentUserId}:nexus:{conversationId}`
 */
export function buildSessionKey(agentUserId: number, conversationId: number): SessionKey {
  return `agent:${agentUserId}:nexus:${conversationId}`;
}
