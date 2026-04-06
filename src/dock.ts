/**
 * Lightweight dock metadata for the Nexus AI channel plugin.
 *
 * This module is intentionally free of heavy dependencies (no ws,
 * no protobuf, no connect-rpc) so that OpenClaw can import it
 * without loading the full plugin runtime.
 */

export const nexusDock = {
  id: "nexus" as const,
  capabilities: {
    chatTypes: ["dm", "group"] as const,
    media: ["image", "audio", "video", "file"] as const,
    reactions: false as const,
    threads: false as const,
    blockStreaming: true as const,
    markdown: true as const,
    cards: true as const,
  },
  meta: {
    id: "nexus",
    label: "Nexus AI",
    selectionLabel: "Nexus AI IM",
    blurb: "Connect to Nexus AI IM platform as an agent.",
    aliases: ["nexus-ai"],
  },
};
