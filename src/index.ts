/**
 * Internal re-exports for the Nexus AI channel plugin.
 *
 * The actual plugin entry point is at the project root: index.ts
 */

export { nexusPlugin } from "./channel.js";
export type { ResolvedNexusAccount } from "./channel.js";
export { validateConfig } from "./config.js";
export { CHANNEL_ID, DEFAULT_ACCOUNT_ID } from "./const.js";
export { getNexusRuntime, setNexusRuntime } from "./runtime.js";

export type {
  NexusAccountConfig,
  WebSocketConfig,
  WebhookConfig,
  ConfigError,
  ConfigValidationResult,
} from "./config.js";

export type {
  SessionKey,
  MediaType,
  MediaAttachment,
  CardPayload,
  OutboundTarget,
  SendOptions,
  StreamSession,
  NexusMsgContext,
  NexusGatewayManager,
  NexusChannelCapabilities,
  NexusChannelMeta,
  NexusChannelPlugin,
} from "./types.js";
