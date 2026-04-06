/**
 * @openclaw/channel-nexus — Nexus AI channel plugin for OpenClaw.
 *
 * Default export: the register function.
 * Named exports: types, config utilities, dock metadata.
 */

export { register as default, register, nexusPlugin } from "./plugin.js";
export { nexusDock } from "./dock.js";
export { validateConfig } from "./config.js";

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
