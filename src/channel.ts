/**
 * Nexus AI ChannelPlugin implementation for OpenClaw.
 *
 * Implements the standard ChannelPlugin<ResolvedNexusAccount> interface
 * so that OpenClaw can discover, configure, start, and stop the channel.
 */

import type { ChannelStatusIssue } from "openclaw/plugin-sdk/channel-contract";
import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk/core";
import { type NexusAccountConfig, validateConfig } from "./config.js";
import {
  buildAccountConfig,
  clearAccountToken,
  deleteAccount as deleteAccountCfg,
  getAccountName,
  getAllowFrom,
  isAccountEnabled,
  listAccountIds,
  setAccountEnabled as setAccountEnabledCfg,
} from "./config-accessor.js";
import { CHANNEL_ID, DEFAULT_ACCOUNT_ID, TEXT_CHUNK_LIMIT } from "./const.js";
import { GatewayManager } from "./gateway/manager.js";
import { MessageNormalizer } from "./inbound/normalizer.js";
import type { NexusLogger } from "./logger.js";
import { createNexusClient, type NexusClient } from "./nexus-api/client.js";
import { NexusOutboundAdapter } from "./outbound/adapter.js";
import { NexusStreamAdapter } from "./outbound/stream.js";
import { getNexusRuntime } from "./runtime.js";
import type { MediaType, NexusMsgContext, StreamSession } from "./types.js";

// ---------------------------------------------------------------------------
// Gateway event handler (extracted from startAccount for readability)
// ---------------------------------------------------------------------------

interface GatewayEventContext {
  accountId: string;
  cfg: OpenClawConfig;
  config: NexusAccountConfig;
  client: NexusClient;
  normalizer: MessageNormalizer;
  channelRuntime: NonNullable<typeof Object.prototype>;
  logger?: NexusLogger;
  log?: { info(msg: string): void; warn?(msg: string): void; error(msg: string): void };
  getAgentUserId: () => number;
}

async function handleGatewayEvent(event: unknown, gctx: GatewayEventContext): Promise<void> {
  const agentUserId = gctx.getAgentUserId();
  if (agentUserId === 0) return;

  const msgCtx = await gctx.normalizer.normalize(event, agentUserId);
  if (!msgCtx) {
    gctx.log?.info(`nexus[${gctx.accountId}] event normalized: skipped`);
    return;
  }

  gctx.log?.info(
    `nexus[${gctx.accountId}] normalized event from ${msgCtx.sender?.name ?? "unknown"}: ${(msgCtx.text ?? "").slice(0, 50)}`,
  );

  const channelRt = gctx.channelRuntime as any;
  const chatType = msgCtx.chatType === "group" ? "group" : "direct";
  const route = channelRt.routing.resolveAgentRoute({
    cfg: gctx.cfg,
    channel: CHANNEL_ID,
    accountId: gctx.accountId,
    peer: { kind: chatType, id: msgCtx.sender.id },
  });

  gctx.log?.info(`nexus[${gctx.accountId}] resolved route: agent=${route.agentId}, session=${route.sessionKey}`);

  const openClawCtx = buildOpenClawMsgContext(msgCtx, gctx.accountId, route.sessionKey);

  // Record inbound session.
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
      accountId: gctx.accountId,
    },
    onRecordError: (err: unknown) => {
      gctx.log?.error(`nexus[${gctx.accountId}] session record error: ${err}`);
    },
  });

  // Dispatch reply with streaming support.
  await dispatchStreamingReply(gctx, channelRt, openClawCtx);
}

async function dispatchStreamingReply(
  gctx: GatewayEventContext,
  channelRt: any,
  openClawCtx: Record<string, unknown>,
): Promise<void> {
  const { adapter: outboundAdapter } = getOrCreateOutboundClient(gctx.accountId, gctx.config, gctx.logger);
  const streamAdapter = new NexusStreamAdapter(gctx.client, gctx.logger);

  let activeStream: StreamSession | null = null;
  let accumulatedText = "";

  const toField = String(openClawCtx.To ?? "");
  const convIdStr = toField.replace(new RegExp(`^${CHANNEL_ID}:`), "");
  const conversationId = Number(convIdStr);

  if (!conversationId || Number.isNaN(conversationId)) {
    gctx.log?.error(`nexus[${gctx.accountId}] invalid conversationId from To: ${toField}`);
    return;
  }

  await channelRt.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: openClawCtx,
    cfg: gctx.cfg,
    dispatcherOptions: {
      deliver: async (payload: { text?: string }) => {
        const replyText = payload.text;
        if (!replyText) return;

        try {
          if (!activeStream) {
            activeStream = await streamAdapter.startStream({ conversationId });
            accumulatedText = replyText;
            await streamAdapter.pushDelta(activeStream, replyText);
          } else {
            accumulatedText += replyText;
            await streamAdapter.pushDelta(activeStream, replyText);
          }
        } catch {
          await outboundAdapter.sendText({ conversationId }, replyText);
        }

        gctx.log?.info(`nexus[${gctx.accountId}] delivered reply to conversation ${conversationId}`);
      },
      onError: (err: unknown, info: { kind: string }) => {
        gctx.log?.error(`nexus[${gctx.accountId}] reply dispatch error (${info.kind}): ${err}`);
        if (activeStream) {
          streamAdapter.errorStream(activeStream, String(err)).catch(() => {});
          activeStream = null;
        }
      },
      onIdle: () => {
        if (activeStream) {
          streamAdapter.endStream(activeStream, accumulatedText).catch((err) => {
            gctx.log?.error(`nexus[${gctx.accountId}] endStream failed: ${err}`);
          });
          activeStream = null;
          accumulatedText = "";
        }
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Gateway lifecycle helpers
// ---------------------------------------------------------------------------

function adaptLogger(
  ctxLog: { info(msg: string): void; warn?(msg: string): void; error(msg: string): void } | undefined,
): NexusLogger | undefined {
  if (!ctxLog) return undefined;
  return {
    info: (msg: string) => ctxLog.info(msg),
    warn: (msg: string) => ctxLog.warn?.(msg) ?? ctxLog.info(msg),
    error: (msg: string) => ctxLog.error(msg),
  };
}

async function waitForAbort(signal: AbortSignal, cleanup: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      cleanup().then(resolve).catch(resolve);
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        cleanup().then(resolve).catch(resolve);
      },
      { once: true },
    );
  });
}

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "flac", "aac", "m4a", "wma"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "avi", "mov", "mkv", "flv", "wmv"]);

function inferMediaType(url: string): MediaType {
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.split(".").pop()?.toLowerCase() ?? "";
    if (IMAGE_EXTS.has(ext)) return "image";
    if (AUDIO_EXTS.has(ext)) return "audio";
    if (VIDEO_EXTS.has(ext)) return "video";
  } catch {
    // Invalid URL — default to file.
  }
  return "file";
}

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

function resolveNexusAccount(cfg: OpenClawConfig, accountId?: string | null): ResolvedNexusAccount {
  const resolvedId = accountId ?? DEFAULT_ACCOUNT_ID;
  return {
    accountId: resolvedId,
    name: getAccountName(cfg, resolvedId),
    enabled: isAccountEnabled(cfg, resolvedId),
    config: buildAccountConfig(cfg, resolvedId),
  };
}

// ---------------------------------------------------------------------------
// Outbound client cache
// ---------------------------------------------------------------------------

const outboundClientCache = new Map<string, { client: NexusClient; adapter: NexusOutboundAdapter }>();

function getOrCreateOutboundClient(
  accountId: string,
  config: NexusAccountConfig,
  logger?: NexusLogger,
): { client: NexusClient; adapter: NexusOutboundAdapter } {
  const cached = outboundClientCache.get(accountId);
  if (cached) return cached;
  const client = createNexusClient(config);
  const adapter = new NexusOutboundAdapter(client, logger);
  const entry = { client, adapter };
  outboundClientCache.set(accountId, entry);
  return entry;
}

/** Remove a cached outbound client (e.g. on logout or account deletion). */
export function evictOutboundClient(accountId: string): void {
  outboundClientCache.delete(accountId);
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
    // TODO(P1-6): return real server-assigned messageId once sendText is updated
    messageId: `nexus-${Date.now()}`,
    chatId,
  };
}

// ---------------------------------------------------------------------------
// MsgContext builder for channelRuntime dispatch
// ---------------------------------------------------------------------------

function buildOpenClawMsgContext(
  msgCtx: NexusMsgContext,
  accountId: string,
  sessionKey: string,
): Record<string, unknown> {
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
  streaming: {
    blockStreamingCoalesceDefaults: {
      minChars: 80,
      idleMs: 300,
    },
  },
  config: {
    listAccountIds: (cfg) => listAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveNexusAccount(cfg, accountId),
    defaultAccountId: (_cfg) => DEFAULT_ACCOUNT_ID,

    setAccountEnabled: ({ cfg, accountId, enabled }) => setAccountEnabledCfg(cfg, accountId, enabled),

    deleteAccount: ({ cfg, accountId }) => {
      evictOutboundClient(accountId);
      return deleteAccountCfg(cfg, accountId);
    },

    isConfigured: (account) => Boolean(account.config.agentToken?.trim() && account.config.serverUrl?.trim()),

    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.config.agentToken?.trim() && account.config.serverUrl?.trim()),
      deliveryMode: account.config.deliveryMode,
    }),

    resolveAllowFrom: ({ cfg, accountId }) => getAllowFrom(cfg, accountId ?? DEFAULT_ACCOUNT_ID),

    formatAllowFrom: ({ allowFrom }) => allowFrom.map((entry) => String(entry).trim()).filter(Boolean),
  },

  security: {
    resolveDmPolicy: ({ cfg: _cfg, accountId: _accountId, account: _account }) => ({
      policy: "open",
      allowFrom: [],
      allowFromPath: `channels.${CHANNEL_ID}.allowFrom`,
      approveHint: `openclaw pairing approve ${CHANNEL_ID} <code>`,
    }),
    collectWarnings: ({ cfg, accountId }) => {
      const warnings: string[] = [];
      const account = resolveNexusAccount(cfg, accountId);
      if (!account.config.agentToken?.trim()) {
        warnings.push(`- Nexus[${accountId}]: agentToken is not configured.`);
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

      if (!cfg) {
        throw new Error(`No config available for account ${resolvedAccountId}`);
      }

      const account = resolveNexusAccount(cfg, resolvedAccountId);
      const result = validateConfig(account.config);
      if (!result.valid) {
        throw new Error(`Invalid config for account ${resolvedAccountId}`);
      }

      const channelPrefix = new RegExp(`^${CHANNEL_ID}:`, "i");
      const chatId = to.replace(channelPrefix, "");
      const conversationId = Number(chatId);
      const { adapter: outbound } = getOrCreateOutboundClient(resolvedAccountId, result.config);

      // Infer media type from URL extension; default to "file".
      const mediaType = inferMediaType(mediaUrl);

      try {
        await outbound.sendMedia(
          { conversationId },
          {
            url: mediaUrl,
            type: mediaType,
          },
        );
      } catch {
        // Fallback: adapter.sendMedia already falls back to text link internally,
        // but if even that fails, send as plain text.
        const fallbackContent = text ? `${text}\n${mediaUrl}` : mediaUrl;
        await outbound.sendText({ conversationId }, fallbackContent);
      }

      // Send accompanying text if present (media was sent separately).
      if (text) {
        await outbound.sendText({ conversationId }, text);
      }

      return {
        channel: CHANNEL_ID,
        messageId: `nexus-${Date.now()}`,
        chatId,
      };
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
    probeAccount: async ({ account }) => {
      const result = validateConfig(account.config);
      if (!result.valid) {
        return { ok: false, status: 0, error: "invalid config" };
      }
      try {
        const client = createNexusClient(result.config);
        // GetClientConfig is a public endpoint — verifies server reachability.
        await client.discoverGatewayUrl();
        return { ok: true, status: 200 };
      } catch (err) {
        return { ok: false, status: 0, error: String(err) };
      }
    },
    buildAccountSnapshot: ({ account, runtime }) => {
      const configured = Boolean(account.config.agentToken?.trim() && account.config.serverUrl?.trim());
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
        ctx.log?.error(`Invalid config for nexus[${ctx.accountId}]: ${result.errors.map((e) => e.message).join(", ")}`);
        return;
      }

      const config = result.config;
      const logger = adaptLogger(ctx.log);

      ctx.log?.info(`starting nexus[${ctx.accountId}] (mode: ${config.deliveryMode})`);

      const client = createNexusClient(config);
      const normalizer = new MessageNormalizer(client);
      const gatewayManager = new GatewayManager(() => config, logger);
      let agentUserId = 0;

      gatewayManager.onAuthSuccess((_accountId: string, userId: number) => {
        agentUserId = userId;
        ctx.log?.info(`nexus[${ctx.accountId}] authenticated as userId=${userId}`);
      });

      const gctx: GatewayEventContext = {
        accountId: ctx.accountId,
        cfg: ctx.cfg,
        config,
        client,
        normalizer,
        channelRuntime: ctx.channelRuntime as any,
        logger,
        log: ctx.log,
        getAgentUserId: () => agentUserId,
      };

      gatewayManager.onEvent(async (_accountId: string, event: unknown) => {
        if (!ctx.channelRuntime) {
          ctx.log?.warn?.(`nexus[${ctx.accountId}] channelRuntime not available`);
          return;
        }
        try {
          await handleGatewayEvent(event, gctx);
        } catch (err) {
          ctx.log?.error(`nexus[${ctx.accountId}] event processing error: ${err}`);
        }
      });

      try {
        await gatewayManager.start(ctx.accountId);
        (ctx.setStatus as (s: Record<string, unknown>) => void)?.({
          running: true,
          lastStartAt: new Date().toISOString(),
        });
      } catch (err) {
        ctx.log?.error(`nexus[${ctx.accountId}] gateway start failed: ${err}`);
        (ctx.setStatus as (s: Record<string, unknown>) => void)?.({
          running: false,
          lastError: String(err),
        });
      }

      await waitForAbort(ctx.abortSignal, () => gatewayManager.stop(ctx.accountId));

      (ctx.setStatus as (s: Record<string, unknown>) => void)?.({
        running: false,
        lastStopAt: new Date().toISOString(),
      });
    },

    logoutAccount: async ({ cfg, accountId }) => {
      const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
      const { nextCfg, changed } = clearAccountToken(cfg, resolvedAccountId);

      // Evict cached client so stale tokens are not reused.
      evictOutboundClient(resolvedAccountId);

      if (changed) {
        await getNexusRuntime().config.writeConfigFile(nextCfg);
      }

      const resolved = resolveNexusAccount(changed ? nextCfg : cfg, resolvedAccountId);
      const loggedOut = !resolved.config.agentToken;

      return { cleared: changed, envToken: false, loggedOut };
    },
  },
};
