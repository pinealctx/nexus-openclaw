/**
 * Internal re-exports for the Nexus AI channel plugin.
 *
 * The actual plugin entry point is at the project root: index.ts
 */

export type { ResolvedNexusAccount } from "./channel.js";
export { evictOutboundClient, nexusPlugin } from "./channel.js";
export type {
  ConfigError,
  ConfigValidationResult,
  NexusAccountConfig,
  WebhookConfig,
  WebSocketConfig,
} from "./config.js";
export { validateConfig } from "./config.js";
export {
  buildAccountConfig,
  getAccountName,
  getAllowFrom,
  getNexusSection,
  hasMultipleAccounts,
  isAccountEnabled,
  listAccountIds,
} from "./config-accessor.js";
export { CHANNEL_ID, DEFAULT_ACCOUNT_ID } from "./const.js";
export { getNexusRuntime, setNexusRuntime } from "./runtime.js";

export type {
  CardPayload,
  MediaAttachment,
  MediaType,
  NexusChannelCapabilities,
  NexusChannelMeta,
  NexusChannelPlugin,
  NexusGatewayManager,
  NexusMsgContext,
  OutboundTarget,
  SendOptions,
  SessionKey,
  StreamSession,
} from "./types.js";
