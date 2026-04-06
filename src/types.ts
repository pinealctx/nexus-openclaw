/**
 * Core type definitions for @openclaw/channel-nexus plugin.
 */

// ---------------------------------------------------------------------------
// Session Key
// ---------------------------------------------------------------------------

/** OpenClaw session key identifying an agent–conversation pair. */
export type SessionKey = `agent:${number}:nexus:${number}`;

// ---------------------------------------------------------------------------
// Media & Card Payloads
// ---------------------------------------------------------------------------

export type MediaType = "image" | "audio" | "video" | "file";

export interface MediaAttachment {
  type: MediaType;
  url: string;
  fileName?: string;
  mimeType?: string;
  size?: number;
}

export interface CardPayload {
  cardJson: string;
}

// ---------------------------------------------------------------------------
// Outbound Types
// ---------------------------------------------------------------------------

export interface OutboundTarget {
  /** Nexus conversation_id. */
  conversationId: number;
  /** Optional message id to reply to. */
  replyToMessageId?: number;
}

export interface SendOptions {
  /** Force MARKDOWN message type regardless of content detection. */
  forceMarkdown?: boolean;
  /** Arbitrary metadata attached to the message. */
  metadata?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Stream Session
// ---------------------------------------------------------------------------

export interface StreamSession {
  messageId: number;
  conversationId: number;
  seq: number;
}

// ---------------------------------------------------------------------------
// Inbound Message Context
// ---------------------------------------------------------------------------

export interface NexusMsgContext {
  sessionKey: SessionKey;
  chatType: "dm" | "group";
  sender: {
    id: string;
    name: string;
    avatarUrl?: string;
  };
  text?: string;
  nexusMessageType?: string;
  media?: MediaAttachment[];
  cardAction?: {
    actionId: string;
    actionData: string;
    verb: string;
    messageId: number;
  };
  group?: {
    id: number;
    name: string;
  };
  mentionedSelf: boolean;
  replyTo?: {
    messageId: number;
    senderId: number;
    contentPreview: string;
  };
  rawEvent: unknown;
}

// ---------------------------------------------------------------------------
// Gateway Manager
// ---------------------------------------------------------------------------

export interface NexusGatewayManager {
  start(accountId: string): Promise<void>;
  stop(accountId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Plugin Capabilities & Meta
// ---------------------------------------------------------------------------

export interface NexusChannelCapabilities {
  chatTypes: readonly ["dm", "group"];
  media: readonly ["image", "audio", "video", "file"];
  reactions: false;
  threads: false;
  blockStreaming: true;
  markdown: true;
  cards: true;
}

export interface NexusChannelMeta {
  label: "Nexus AI";
  docsUrl: string;
}

/**
 * Top-level plugin interface.
 *
 * Concrete implementation will be provided in later tasks; this interface
 * captures the shape declared in the design document.
 */
export interface NexusChannelPlugin {
  id: "nexus";
  meta: NexusChannelMeta;
  capabilities: NexusChannelCapabilities;
}
