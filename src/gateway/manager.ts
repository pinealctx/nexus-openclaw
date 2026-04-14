/**
 * Gateway Manager — selects WebSocket or Webhook delivery mode per account
 * and manages start/stop lifecycle.
 */

import type { NexusAccountConfig } from "../config.js";
import { consoleLogger, type NexusLogger } from "../logger.js";
import { createNexusClient, type NexusClient } from "../nexus-api/client.js";
import { WebhookServer } from "./webhook-server.js";
import { WebSocketConnector } from "./ws-connector.js";

// ---------------------------------------------------------------------------
// Per-account state
// ---------------------------------------------------------------------------

interface AccountEntry {
  connector: WebSocketConnector | null;
  server: WebhookServer | null;
  client: NexusClient;
}

// ---------------------------------------------------------------------------
// Event handler type
// ---------------------------------------------------------------------------

type GatewayEventHandler = (accountId: string, event: unknown) => void;
type AuthSuccessHandler = (accountId: string, userId: number) => void;

// ---------------------------------------------------------------------------
// GatewayManager
// ---------------------------------------------------------------------------

export class GatewayManager {
  private readonly accounts = new Map<string, AccountEntry>();
  private readonly eventHandlers: GatewayEventHandler[] = [];
  private readonly authSuccessHandlers: AuthSuccessHandler[] = [];
  private readonly log: NexusLogger;

  constructor(
    private readonly configResolver: (accountId: string) => NexusAccountConfig,
    logger?: NexusLogger,
  ) {
    this.log = logger ?? consoleLogger;
  }

  /**
   * Register a handler that receives events tagged with the originating accountId.
   */
  onEvent(handler: GatewayEventHandler): void {
    this.eventHandlers.push(handler);
  }

  /**
   * Register a handler fired after successful authentication, receiving the agent user ID.
   */
  onAuthSuccess(handler: AuthSuccessHandler): void {
    this.authSuccessHandlers.push(handler);
  }

  /**
   * Start event receiving for the given account.
   *
   * Idempotent: if the account is already started, this is a no-op.
   * Only one delivery mode (WebSocket or Webhook) is active per account.
   */
  async start(accountId: string): Promise<void> {
    if (this.accounts.has(accountId)) {
      return;
    }

    const config = this.configResolver(accountId);
    this.log.info(`[nexus-gw] starting account: ${accountId} mode: ${config.deliveryMode}`);
    const client = createNexusClient(config);

    const entry: AccountEntry = {
      connector: null,
      server: null,
      client,
    };

    // Register entry before async work so a concurrent start sees it.
    this.accounts.set(accountId, entry);

    try {
      if (config.deliveryMode === "websocket") {
        await this.startWebSocket(accountId, config, client, entry);
      } else {
        await this.startWebhook(accountId, config, entry);
      }
    } catch (err) {
      // Roll back on failure so the account can be retried.
      this.accounts.delete(accountId);
      throw err;
    }
  }

  /**
   * Stop event receiving for the given account and release resources.
   *
   * No-op if the account is not started.
   */
  async stop(accountId: string): Promise<void> {
    const entry = this.accounts.get(accountId);
    if (!entry) {
      return;
    }

    this.accounts.delete(accountId);

    if (entry.connector) {
      await entry.connector.disconnect();
    }
    if (entry.server) {
      await entry.server.stop();
    }
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private async startWebSocket(
    accountId: string,
    config: NexusAccountConfig,
    client: NexusClient,
    entry: AccountEntry,
  ): Promise<void> {
    const connector = new WebSocketConnector(config, client, this.log);

    connector.onEvent((event) => {
      this.dispatch(accountId, event);
    });

    connector.onAuthSuccess((userId) => {
      for (const handler of this.authSuccessHandlers) {
        handler(accountId, userId);
      }
    });

    entry.connector = connector;
    await connector.connect();
  }

  private async startWebhook(accountId: string, config: NexusAccountConfig, entry: AccountEntry): Promise<void> {
    if (!config.webhook) {
      throw new Error(`webhook configuration is required for account ${accountId}`);
    }

    const server = new WebhookServer(config.webhook);

    server.onEvent((event) => {
      this.dispatch(accountId, event);
    });

    entry.server = server;
    await server.start();
  }

  private dispatch(accountId: string, event: unknown): void {
    for (const handler of this.eventHandlers) {
      handler(accountId, event);
    }
  }
}
