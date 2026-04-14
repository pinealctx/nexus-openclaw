/**
 * Type-safe accessor for Nexus channel configuration within OpenClawConfig.
 *
 * Centralizes all `as any` / `as Record<string, unknown>` casts into a single
 * module so the rest of the codebase can work with strongly-typed values.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { NexusAccountConfig, WebhookConfig, WebSocketConfig } from "./config.js";
import { CHANNEL_ID, DEFAULT_ACCOUNT_ID } from "./const.js";

// ---------------------------------------------------------------------------
// Internal channel section shape (mirrors ChannelsConfig[key])
// ---------------------------------------------------------------------------

interface NexusChannelSection {
  enabled?: boolean;
  agentToken?: string;
  serverUrl?: string;
  deliveryMode?: "websocket" | "webhook";
  gatewayUrl?: string;
  websocket?: WebSocketConfig;
  webhook?: WebhookConfig;
  allowFrom?: Array<string | number>;
  accounts?: Record<string, NexusAccountEntry>;
}

interface NexusAccountEntry {
  enabled?: boolean;
  name?: string;
  agentToken?: string;
  serverUrl?: string;
  deliveryMode?: "websocket" | "webhook";
  gatewayUrl?: string;
  websocket?: WebSocketConfig;
  webhook?: WebhookConfig;
  allowFrom?: Array<string | number>;
}

// ---------------------------------------------------------------------------
// Accessor functions
// ---------------------------------------------------------------------------

/**
 * Extract the Nexus channel section from an OpenClawConfig.
 *
 * This is the single place where we cast from the SDK's `[key: string]: any`
 * channels map into our typed section shape.
 */
export function getNexusSection(cfg: OpenClawConfig): NexusChannelSection | undefined {
  // OpenClawConfig.channels is ChannelsConfig which is `[key: string]: any`
  const channels = (cfg as { channels?: Record<string, unknown> }).channels;
  return channels?.[CHANNEL_ID] as NexusChannelSection | undefined;
}

/**
 * Check whether the config has multiple Nexus accounts.
 */
export function hasMultipleAccounts(cfg: OpenClawConfig): boolean {
  const section = getNexusSection(cfg);
  return section?.accounts ? Object.keys(section.accounts).length > 1 : false;
}

/**
 * List all configured Nexus account IDs.
 */
export function listAccountIds(cfg: OpenClawConfig): string[] {
  const section = getNexusSection(cfg);
  if (!section?.accounts) return [DEFAULT_ACCOUNT_ID];
  return Object.keys(section.accounts);
}

/**
 * Read the raw account entry for a given account ID.
 */
export function getAccountEntry(cfg: OpenClawConfig, accountId: string): NexusAccountEntry {
  const section = getNexusSection(cfg);
  return section?.accounts?.[accountId] ?? {};
}

/**
 * Build a NexusAccountConfig from the raw config section for a given account.
 */
export function buildAccountConfig(cfg: OpenClawConfig, accountId?: string | null): NexusAccountConfig {
  const resolvedId = accountId ?? DEFAULT_ACCOUNT_ID;
  const section = getNexusSection(cfg);
  const entry = section?.accounts?.[resolvedId];

  // When multi-account is not used, fields may live at the section root.
  const source = entry ?? section ?? {};

  return {
    agentToken: source.agentToken ?? "",
    serverUrl: source.serverUrl ?? "",
    deliveryMode: source.deliveryMode ?? "websocket",
    gatewayUrl: source.gatewayUrl,
    websocket: source.websocket,
    webhook: source.webhook,
  };
}

/**
 * Read the account name (falls back to accountId).
 */
export function getAccountName(cfg: OpenClawConfig, accountId: string): string {
  const entry = getAccountEntry(cfg, accountId);
  return entry.name ?? accountId;
}

/**
 * Check whether an account is enabled (defaults to true).
 */
export function isAccountEnabled(cfg: OpenClawConfig, accountId: string): boolean {
  const entry = getAccountEntry(cfg, accountId);
  return entry.enabled !== false;
}

/**
 * Read the allowFrom list for an account.
 */
export function getAllowFrom(cfg: OpenClawConfig, accountId: string): string[] {
  const entry = getAccountEntry(cfg, accountId);
  return (entry.allowFrom ?? []).map((e) => String(e));
}

// ---------------------------------------------------------------------------
// Config mutation helpers (return new OpenClawConfig)
// ---------------------------------------------------------------------------

/**
 * Set the enabled flag for an account. Returns a new config object.
 */
export function setAccountEnabled(cfg: OpenClawConfig, accountId: string, enabled: boolean): OpenClawConfig {
  const section = getNexusSection(cfg) ?? {};
  const channels = (cfg as { channels?: Record<string, unknown> }).channels ?? {};

  if (!hasMultipleAccounts(cfg)) {
    return {
      ...cfg,
      channels: {
        ...channels,
        [CHANNEL_ID]: { ...section, enabled },
      },
    } as OpenClawConfig;
  }

  const accounts = section.accounts ?? {};
  return {
    ...cfg,
    channels: {
      ...channels,
      [CHANNEL_ID]: {
        ...section,
        accounts: {
          ...accounts,
          [accountId]: { ...accounts[accountId], enabled },
        },
      },
    },
  } as OpenClawConfig;
}

/**
 * Delete an account from the config. Returns a new config object.
 */
export function deleteAccount(cfg: OpenClawConfig, accountId: string): OpenClawConfig {
  const channels = { ...(cfg as { channels?: Record<string, unknown> }).channels };

  if (!hasMultipleAccounts(cfg)) {
    delete channels[CHANNEL_ID];
    const next = { ...cfg } as Record<string, unknown>;
    if (Object.keys(channels).length > 0) {
      next.channels = channels;
    } else {
      delete next.channels;
    }
    return next as OpenClawConfig;
  }

  const section = getNexusSection(cfg);
  const accounts = { ...section?.accounts };
  delete accounts[accountId];

  return {
    ...cfg,
    channels: {
      ...channels,
      [CHANNEL_ID]: {
        ...section,
        accounts: Object.keys(accounts).length > 0 ? accounts : undefined,
      },
    },
  } as OpenClawConfig;
}

/**
 * Clear the agentToken for an account (logout). Returns a new config object
 * and whether any change was made.
 */
export function clearAccountToken(
  cfg: OpenClawConfig,
  accountId: string,
): { nextCfg: OpenClawConfig; changed: boolean } {
  const section = getNexusSection(cfg);
  const channels = (cfg as { channels?: Record<string, unknown> }).channels ?? {};

  if (!hasMultipleAccounts(cfg)) {
    const sectionCopy = { ...section } as Record<string, unknown>;
    if (!sectionCopy.agentToken) return { nextCfg: cfg, changed: false };
    delete sectionCopy.agentToken;
    return {
      nextCfg: {
        ...cfg,
        channels: { ...channels, [CHANNEL_ID]: sectionCopy },
      } as OpenClawConfig,
      changed: true,
    };
  }

  const accounts = section?.accounts ?? {};
  const entry = { ...accounts[accountId] } as Record<string, unknown>;
  if (!entry.agentToken) return { nextCfg: cfg, changed: false };
  delete entry.agentToken;

  return {
    nextCfg: {
      ...cfg,
      channels: {
        ...channels,
        [CHANNEL_ID]: {
          ...section,
          accounts: { ...accounts, [accountId]: entry },
        },
      },
    } as OpenClawConfig,
    changed: true,
  };
}
