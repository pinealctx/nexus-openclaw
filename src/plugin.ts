/**
 * Full Nexus channel plugin entry point.
 *
 * Assembles config resolution, GatewayManager, MessageNormalizer,
 * NexusOutboundAdapter, and NexusStreamAdapter into a single
 * plugin object that OpenClaw can register.
 */

import { nexusDock } from "./dock.js";
import { type NexusAccountConfig, validateConfig } from "./config.js";
import { createNexusClient } from "./nexus-api/client.js";
import { GatewayManager } from "./gateway/manager.js";
import { MessageNormalizer } from "./inbound/normalizer.js";
import { NexusOutboundAdapter } from "./outbound/adapter.js";
import { NexusStreamAdapter } from "./outbound/stream.js";
import type { StreamSession } from "./types.js";

// ---------------------------------------------------------------------------
// Per-account runtime state
// ---------------------------------------------------------------------------

interface AccountRuntime {
  config: NexusAccountConfig;
  agentUserId: number;
  normalizer: MessageNormalizer;
  outbound: NexusOutboundAdapter;
  stream: NexusStreamAdapter;
}

// ---------------------------------------------------------------------------
// Plugin state
// ---------------------------------------------------------------------------

const accounts = new Map<string, AccountRuntime>();
let gatewayManager: GatewayManager | null = null;

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function listAccountIds(): string[] {
  return Array.from(accounts.keys());
}

function resolveAccount(accountId: string): NexusAccountConfig {
  const rt = accounts.get(accountId);
  if (!rt) throw new Error(`nexus account not found: ${accountId}`);
  return rt.config;
}

function getOutbound(accountId: string): NexusOutboundAdapter {
  const rt = accounts.get(accountId);
  if (!rt) throw new Error(`nexus account not found: ${accountId}`);
  return rt.outbound;
}

function getStream(accountId: string): NexusStreamAdapter {
  const rt = accounts.get(accountId);
  if (!rt) throw new Error(`nexus account not found: ${accountId}`);
  return rt.stream;
}

// ---------------------------------------------------------------------------
// Plugin object
// ---------------------------------------------------------------------------

export const nexusPlugin = {
  id: "nexus" as const,
  meta: nexusDock.meta,
  capabilities: nexusDock.capabilities,

  config: { listAccountIds, resolveAccount, validateConfig },

  outbound: {
    deliveryMode: "direct" as const,
    async sendText(accountId: string, target: { conversationId: number; replyToMessageId?: number }, text: string, options?: { forceMarkdown?: boolean }): Promise<void> {
      await getOutbound(accountId).sendText(target, text, options);
    },
    async sendMedia(accountId: string, target: { conversationId: number; replyToMessageId?: number }, media: { url: string; type: "image" | "audio" | "video" | "file"; fileName?: string }): Promise<void> {
      await getOutbound(accountId).sendMedia(target, media);
    },
    async sendCard(accountId: string, target: { conversationId: number; replyToMessageId?: number }, cardJson: string): Promise<void> {
      await getOutbound(accountId).sendCard(target, cardJson);
    },
    async answerCardAction(accountId: string, actionId: string, text?: string, showAlert?: boolean): Promise<void> {
      await getOutbound(accountId).answerCardAction(actionId, text, showAlert);
    },
    async editCard(accountId: string, conversationId: number, messageId: number, cardJson: string): Promise<void> {
      await getOutbound(accountId).editCard(conversationId, messageId, cardJson);
    },
  },

  streaming: {
    async startStream(accountId: string, target: { conversationId: number; replyToMessageId?: number }): Promise<StreamSession> {
      return getStream(accountId).startStream(target);
    },
    async pushDelta(accountId: string, session: StreamSession, delta: string): Promise<void> {
      await getStream(accountId).pushDelta(session, delta);
    },
    async endStream(accountId: string, session: StreamSession, fullText: string): Promise<void> {
      await getStream(accountId).endStream(session, fullText);
    },
    async errorStream(accountId: string, session: StreamSession, error: string): Promise<void> {
      await getStream(accountId).errorStream(session, error);
    },
  },

  gateway: {
    async start(accountId: string): Promise<void> {
      if (!gatewayManager) throw new Error("plugin not registered; call register() first");
      await gatewayManager.start(accountId);
    },
    async stop(accountId: string): Promise<void> {
      if (!gatewayManager) return;
      await gatewayManager.stop(accountId);
    },
  },
};

// ---------------------------------------------------------------------------
// Register function
// ---------------------------------------------------------------------------

export function register(api: {
  registerChannel: (entry: { plugin: typeof nexusPlugin; dock: typeof nexusDock }) => void;
  config?: { accounts?: Record<string, Partial<NexusAccountConfig>> };
  dispatch?: (accountId: string, msgCtx: unknown) => void;
}): void {
  const accountConfigs = api.config?.accounts ?? {};

  for (const [accountId, raw] of Object.entries(accountConfigs)) {
    const result = validateConfig(raw);
    if (!result.valid) {
      const fields = result.errors.map((e) => `${e.field}: ${e.message}`).join("; ");
      throw new Error(`invalid nexus config for account ${accountId}: ${fields}`);
    }
    const config = result.config;
    const client = createNexusClient(config);
    accounts.set(accountId, {
      config,
      agentUserId: 0,
      normalizer: new MessageNormalizer(client),
      outbound: new NexusOutboundAdapter(client),
      stream: new NexusStreamAdapter(client),
    });
  }

  gatewayManager = new GatewayManager(resolveAccount);

  gatewayManager.onAuthSuccess((accountId: string, userId: number) => {
    const rt = accounts.get(accountId);
    if (rt) rt.agentUserId = userId;
  });

  if (api.dispatch) {
    const dispatch = api.dispatch;
    gatewayManager.onEvent(async (accountId: string, event: unknown) => {
      const rt = accounts.get(accountId);
      if (!rt || rt.agentUserId === 0) return;
      const msgCtx = await rt.normalizer.normalize(event, rt.agentUserId);
      if (msgCtx) dispatch(accountId, msgCtx);
    });
  }

  api.registerChannel({ plugin: nexusPlugin, dock: nexusDock });
}
