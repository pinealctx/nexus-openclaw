/**
 * Nexus AI ChannelPlugin implementation for OpenClaw.
 *
 * Implements the standard ChannelPlugin<ResolvedNexusAccount> interface
 * so that OpenClaw can discover, configure, start, and stop the channel.
 */

import type {
  ChannelPlugin,
  OpenClawConfig,
} from "openclaw/plugin-sdk/core";
import type { ChannelStatusIssue } from "openclaw/plugin-sdk/channel-contract";

import { CHANNEL_ID, DEFAULT_ACCOUNT_ID, TEXT_CHUNK_LIMIT } from "./const.js";
import { getNexusRuntime } from "./runtime.js";
import { type NexusAccountConfig, validateConfig } from "./config.js";
import { createNexusClient, type NexusClient } from "./nexus-api/client.js";
import { GatewayManager } from "./gateway/manager.js";
import { MessageNormalizer } from "./inbound/normalizer.js";
import { NexusOutboundAdapter } from "./outbound/adapter.js";
import type { NexusMsgContext } from "./types.js";

// ---------------------------------------------------------------------------
// Resolved account type
// ---------------------------------------------------------------------------

export interface ResolvedNexusAccount {
  accountId: string;
  name: string;
  enabled: boolean;
  config: NexusAccountConfig;
}

// ---------------------------------------------------------------------------
// Account resolution helpers
// ---------------------------------------------------------------------------

/**
 * List all configured Nexus account IDs from the OpenClaw config.
 */
function listNexusAccountIds(cfg: OpenClawConfig): string[] {
  const nexusCfg = (cfg as any).channels?.[CHANNEL_ID] as
    | { accounts?: Record<string, unknown> }
    | undefined;
  if (!nexusCfg?.accounts) return [DEFAULT_ACCOUNT_ID];
  return Object.keys(nexusCfg.accounts);
}

/**
 * Resolve a single Nexus account from the OpenClaw config.
 */
function resolveNexusAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedNexusAccount {
  const resolvedId = accountId ?? DEFAULT_ACCOUNT_ID;
  const nexusCfg = (cfg as any).channels?.[CHANNEL_ID] as
    | { accounts?: Record<string, Record<string, unknown>>; enabled?: boolean }
    | undefined;

  const raw = nexusCfg?.accounts?.[resolvedId] ?? {};
  const enabled = (raw as any).enabled !== false;

  return {
    accountId: resolvedId,
    name: (raw as any).name ?? resolvedId,
    enabled,
    config: {
      agentToken: (raw as any).agentToken ?? "",
      serverUrl: (raw as any).serverUrl ?? "",
      deliveryMode: (raw as any).deliveryMode ?? "websocket",
      gatewayUrl: (raw as any).gatewayUrl,
      websocket: (raw as any).websocket,
      webhook: (raw as any).webhook,
    },
  };
}

function hasMultiAccounts(cfg: OpenClawConfig): boolean {
  const nexusCfg = (cfg as any).channels?.[CHANNEL_ID] as
    | { accounts?: Record<string, unknown> }
    | undefined;
  return nexusCfg?.accounts
    ? Object.keys(nexusCfg.accounts).length > 1
    : false;
}

// ---------------------------------------------------------------------------
// Outbound client cache (Issue 3: avoid creating new client on every call)
// ---------------------------------------------------------------------------

const outboundClientCache = new Map<string, { client: NexusClient; adapter: NexusOutboundAdapter }>();

function getOrCreateOutboundClient(accountId: string, config: NexusAccountConfig): { client: NexusClient; adapter: NexusOutboundAdapter } {
  const cached = outboundClientCache.get(accountId);
  if (cached) return cached;
  const client = createNexusClient(config);
  const adapter = new NexusOutboundAdapter(client);
  const entry = { client, adapter };
  outboundClientCache.set(accountId, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Outbound send helper
// ---------------------------------------------------------------------------

async function sendNexusMessage({
  to,
  content,
  accountId,
  cfg,
}: {
  to: string;
  content: string;
  accountId?: string;
  cfg?: OpenClawConfig;
}): Promise<{ channel: string; messageId: string; chatId: string }> {
  const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
  const channelPrefix = new RegExp(`^${CHANNEL_ID}:`, "i");
  const chatId = to.replace(channelPrefix, "");
  const conversationId = Number(chatId);

  if (!cfg) {
    throw new Error(`No config available for account ${resolvedAccountId}`);
  }

  const account = resolveNexusAccount(cfg, resolvedAccountId);
  const result = validateConfig(account.config);
  if (!result.valid) {
    throw new Error(`Invalid config for account ${resolvedAccountId}`);
  }

  const { adapter: outbound } = getOrCreateOutboundClient(resolvedAccountId, result.config);
  await outbound.sendText({ conversationId }, content);

  return {
    channel: CHANNEL_ID,
    messageId: `nexus-${Date.now()}`,
    chatId,
  };
}

// ---------------------------------------------------------------------------
// MsgContext builder for channelRuntime dispatch
// ---------------------------------------------------------------------------

/**
 * Convert a NexusMsgContext into the MsgContext shape expected by OpenClaw's
 * dispatchReplyWithBufferedBlockDispatcher.
 */
function buildOpenClawMsgContext(
  msgCtx: NexusMsgContext,
  accountId: string,
  sessionKey: string,
): Record<string, unknown> {
  // Extract conversation ID from the session key (format: agent:{id}:nexus:{convId})
  const parts = msgCtx.sessionKey.split(":");
  const conversationId = parts[parts.length - 1] ?? msgCtx.sender.id;

  return {
    Body: msgCtx.text ?? "",
    From: `${CHANNEL_ID}:${msgCtx.sender.id}`,
    To: `${CHANNEL_ID}:${conversationId}`,
    SessionKey: sessionKey,
    ChatType: msgCtx.chatType === "group" ? "group" : "direct",
    SenderName: msgCtx.sender.name,
    SenderId: msgCtx.sender.id,
    Provider: CHANNEL_ID,
    AccountId: accountId,
    Timestamp: Date.now(),
    WasMentioned: msgCtx.mentionedSelf,
    ...(msgCtx.group && {
      GroupSubject: msgCtx.group.name,
    }),
    ...(msgCtx.replyTo && {
      ReplyToBody: msgCtx.replyTo.contentPreview,
      ReplyToId: String(msgCtx.replyTo.messageId),
    }),
  };
}

// ---------------------------------------------------------------------------
// Channel metadata
// ---------------------------------------------------------------------------

const meta = {
  id: CHANNEL_ID,
  label: "Nexus AI",
  selectionLabel: "Nexus AI IM",
  detailLabel: "Nexus AI IM Agent",
  docsPath: `/channels/${CHANNEL_ID}`,
  docsLabel: CHANNEL_ID,
  blurb: "Connect to Nexus AI IM platform as an agent.",
  systemImage: "message.fill",
};

// ---------------------------------------------------------------------------
// ChannelPlugin export
// ---------------------------------------------------------------------------

export const nexusPlugin: ChannelPlugin<ResolvedNexusAccount> = {
  id: CHANNEL_ID,
  meta,
  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
  config: {
    listAccountIds: (cfg) => listNexusAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveNexusAccount(cfg, accountId),
    defaultAccountId: (_cfg) => DEFAULT_ACCOUNT_ID,

    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const nexusCfg = ((cfg as any).channels?.[CHANNEL_ID] ?? {}) as Record<string, any>;
      if (!hasMultiAccounts(cfg)) {
        return {
          ...cfg,
          channels: {
            ...(cfg as any).channels,
            [CHANNEL_ID]: { ...nexusCfg, enabled },
          },
        } as OpenClawConfig;
      }
      return {
        ...cfg,
        channels: {
          ...(cfg as any).channels,
          [CHANNEL_ID]: {
            ...nexusCfg,
            accounts: {
              ...nexusCfg.accounts,
              [accountId]: { ...nexusCfg.accounts?.[accountId], enabled },
            },
          },
        },
      } as OpenClawConfig;
    },

    deleteAccount: ({ cfg, accountId }) => {
      if (!hasMultiAccounts(cfg)) {
        const next = { ...cfg } as any;
        const nextChannels = { ...(cfg as any).channels };
        delete nextChannels[CHANNEL_ID];
        if (Object.keys(nextChannels).length > 0) {
          next.channels = nextChannels;
        } else {
          delete next.channels;
        }
        return next as OpenClawConfig;
      }
      const nexusCfg = (cfg as any).channels?.[CHANNEL_ID] as Record<string, any> | undefined;
      const accounts = { ...nexusCfg?.accounts };
      delete accounts[accountId];
      return {
        ...cfg,
        channels: {
          ...(cfg as any).channels,
          [CHANNEL_ID]: {
            ...nexusCfg,
            accounts: Object.keys(accounts).length > 0 ? accounts : undefined,
          },
        },
      } as OpenClawConfig;
    },

    isConfigured: (account) =>
      Boolean(account.config.agentToken?.trim() && account.config.serverUrl?.trim()),

    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(
        account.config.agentToken?.trim() && account.config.serverUrl?.trim(),
      ),
      deliveryMode: account.config.deliveryMode,
    }),

    resolveAllowFrom: ({ cfg, accountId }) => {
      const account = resolveNexusAccount(cfg, accountId);
      return ((account.config as any).allowFrom ?? []).map((e: any) => String(e));
    },

    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((entry) => String(entry).trim()).filter(Boolean),
  },

  security: {
    resolveDmPolicy: ({ cfg: _cfg, accountId: _accountId, account: _account }) => {
      return {
        policy: "open",
        allowFrom: [],
        allowFromPath: `channels.${CHANNEL_ID}.allowFrom`,
        approveHint: `openclaw pairing approve ${CHANNEL_ID} <code>`,
      };
    },
    collectWarnings: ({ cfg, accountId }) => {
      const warnings: string[] = [];
      const account = resolveNexusAccount(cfg, accountId);
      if (!account.config.agentToken?.trim()) {
        warnings.push(
          `- Nexus[${accountId}]: agentToken is not configured.`,
        );
      }
      return warnings;
    },
  },

  messaging: {
    normalizeTarget: (target) => {
      const trimmed = target.trim();
      return trimmed || undefined;
    },
    targetResolver: {
      looksLikeId: (id) => Boolean(id?.trim()),
      hint: "<conversationId>",
    },
  },

  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async () => [],
  },

  outbound: {
    deliveryMode: "gateway",
    textChunkLimit: TEXT_CHUNK_LIMIT,
    sendText: async ({ to, text, accountId, cfg }) => {
      return sendNexusMessage({
        to,
        content: text,
        accountId: accountId ?? undefined,
        cfg,
      });
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, cfg }) => {
      const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;

      if (!mediaUrl) {
        return sendNexusMessage({
          to,
          content: text || "",
          accountId: resolvedAccountId,
          cfg,
        });
      }

      // For now, send media URL as text link; full media upload can be added later
      const fallbackContent = text
        ? `${text}\n📎 ${mediaUrl}`
        : `📎 ${mediaUrl}`;
      return sendNexusMessage({
        to,
        content: fallbackContent,
        accountId: resolvedAccountId,
        cfg,
      });
    },
  },

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts): ChannelStatusIssue[] =>
      accounts.flatMap((entry) => {
        const accountId = String(entry.accountId ?? DEFAULT_ACCOUNT_ID);
        const enabled = entry.enabled !== false;
        const configured = entry.configured === true;
        if (!enabled) return [];
        const issues: ChannelStatusIssue[] = [];
        if (!configured) {
          issues.push({
            channel: CHANNEL_ID,
            accountId,
            kind: "config",
            message: "Nexus agentToken or serverUrl not configured",
            fix: "Set channels.nexus.accounts.<id>.agentToken and serverUrl in your config",
          });
        }
        return issues;
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    probeAccount: async () => ({ ok: true, status: 200 }),
    buildAccountSnapshot: ({ account, runtime }) => {
      const configured = Boolean(
        account.config.agentToken?.trim() && account.config.serverUrl?.trim(),
      );
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
      };
    },
  },

  gateway: {
    startAccount: async (ctx) => {
      const account = resolveNexusAccount(ctx.cfg, ctx.accountId);
      const result = validateConfig(account.config);

      if (!result.valid) {
        ctx.log?.error(
          `Invalid config for nexus[${ctx.accountId}]: ${result.errors.map((e) => e.message).join(", ")}`,
        );
        return;
      }

      const config = result.config;
      ctx.log?.info(
        `starting nexus[${ctx.accountId}] (mode: ${config.deliveryMode})`,
      );

      const client = createNexusClient(config);
      const normalizer = new MessageNormalizer(client);
      const gatewayManager = new GatewayManager(() => config);
      let agentUserId = 0;

      gatewayManager.onAuthSuccess((_accountId: string, userId: number) => {
        agentUserId = userId;
        ctx.log?.info(`nexus[${ctx.accountId}] authenticated as userId=${userId}`);
      });

      gatewayManager.onEvent(async (_accountId: string, event: unknown) => {
        if (agentUserId === 0) return;
        try {
          const msgCtx = await normalizer.normalize(event, agentUserId);
          if (!msgCtx) {
            ctx.log?.info(`nexus[${ctx.accountId}] event normalized: skipped`);
            return;
          }

          ctx.log?.info(`nexus[${ctx.accountId}] normalized event from ${msgCtx.sender?.name ?? 'unknown'}: ${(msgCtx.text ?? '').slice(0, 50)}`);

          // Use channelRuntime for dispatch (OpenClaw 2026.4 ChannelPlugin SDK)
          if (!ctx.channelRuntime) {
            ctx.log?.warn?.(`nexus[${ctx.accountId}] channelRuntime not available - cannot dispatch message`);
            return;
          }

          const channelRt = ctx.channelRuntime;

          // Resolve agent route for this conversation
          const chatType = msgCtx.chatType === "group" ? "group" : "direct";
          const route = channelRt.routing.resolveAgentRoute({
            cfg: ctx.cfg,
            channel: CHANNEL_ID,
            accountId: ctx.accountId,
            peer: { kind: chatType, id: msgCtx.sender.id },
          });

          ctx.log?.info(`nexus[${ctx.accountId}] resolved route: agent=${route.agentId}, session=${route.sessionKey}`);

          // Build OpenClaw MsgContext from NexusMsgContext
          const openClawCtx = buildOpenClawMsgContext(msgCtx, ctx.accountId, route.sessionKey);

          // Record inbound session
          const storePath = channelRt.session.resolveStorePath(undefined, { agentId: route.agentId });
          await channelRt.session.recordInboundSession({
            storePath,
            sessionKey: route.sessionKey,
            ctx: openClawCtx,
            createIfMissing: true,
            updateLastRoute: {
              sessionKey: route.sessionKey,
              channel: CHANNEL_ID,
              to: `${CHANNEL_ID}:${msgCtx.sessionKey.split(":").pop() ?? msgCtx.sender.id}`,
              accountId: ctx.accountId,
            },
            onRecordError: (err) => {
              ctx.log?.error(`nexus[${ctx.accountId}] session record error: ${err}`);
            },
          });

          // Get or create outbound adapter for delivering replies
          const { adapter: outboundAdapter } = getOrCreateOutboundClient(ctx.accountId, config);

          // Dispatch to AI agent via buffered block dispatcher
          await channelRt.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: openClawCtx,
            cfg: ctx.cfg,
            dispatcherOptions: {
              deliver: async (payload) => {
                const replyText = payload.text;
                if (!replyText) return;

                // Extract conversation ID from the session key or To field
                const toField = String(openClawCtx.To ?? "");
                const convIdStr = toField.replace(new RegExp(`^${CHANNEL_ID}:`), "");
                const conversationId = Number(convIdStr);
                if (!conversationId || isNaN(conversationId)) {
                  ctx.log?.error(`nexus[${ctx.accountId}] invalid conversationId from To: ${toField}`);
                  return;
                }

                await outboundAdapter.sendText({ conversationId }, replyText);
                ctx.log?.info(`nexus[${ctx.accountId}] delivered reply to conversation ${conversationId}`);
              },
              onError: (err, info) => {
                ctx.log?.error(`nexus[${ctx.accountId}] reply dispatch error (${info.kind}): ${err}`);
              },
            },
          });
        } catch (err) {
          ctx.log?.error(`nexus[${ctx.accountId}] event processing error: ${err}`);
        }
      });

      try {
        await gatewayManager.start(ctx.accountId);
        (ctx.setStatus as any)?.({ running: true, lastStartAt: new Date().toISOString() });
      } catch (err) {
        ctx.log?.error(`nexus[${ctx.accountId}] gateway start failed: ${err}`);
        (ctx.setStatus as any)?.({
          running: false,
          lastError: String(err),
        });
      }

      // Wait for abort signal to stop
      await new Promise<void>((resolve) => {
        if (ctx.abortSignal.aborted) {
          gatewayManager.stop(ctx.accountId).then(resolve).catch(resolve);
          return;
        }
        ctx.abortSignal.addEventListener(
          "abort",
          () => {
            gatewayManager.stop(ctx.accountId).then(resolve).catch(resolve);
          },
          { once: true },
        );
      });

      (ctx.setStatus as any)?.({
        running: false,
        lastStopAt: new Date().toISOString(),
      });
    },

    logoutAccount: async ({ cfg, accountId }) => {
      const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
      const nexusCfg = (cfg as any).channels?.[CHANNEL_ID] as Record<string, any> | undefined;
      let changed = false;
      let nextCfg = { ...cfg } as any;

      if (!hasMultiAccounts(cfg)) {
        const channelCfg = { ...nexusCfg } as Record<string, any>;
        if (channelCfg.agentToken) {
          delete channelCfg.agentToken;
          changed = true;
        }
        if (changed) {
          nextCfg.channels = { ...nextCfg.channels, [CHANNEL_ID]: channelCfg };
        }
      } else {
        const accountCfg = { ...nexusCfg?.accounts?.[resolvedAccountId] } as Record<string, any>;
        if (accountCfg.agentToken) {
          delete accountCfg.agentToken;
          changed = true;
        }
        if (changed) {
          const nextAccounts = { ...nexusCfg?.accounts, [resolvedAccountId]: accountCfg };
          nextCfg.channels = {
            ...nextCfg.channels,
            [CHANNEL_ID]: { ...nexusCfg, accounts: nextAccounts },
          };
        }
      }

      if (changed) {
        await getNexusRuntime().config.writeConfigFile(nextCfg);
      }

      const resolved = resolveNexusAccount(changed ? nextCfg : cfg, resolvedAccountId);
      const loggedOut = !resolved.config.agentToken;

      return { cleared: changed, envToken: false, loggedOut };
    },
  },
};
