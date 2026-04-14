/**
 * Nexus Agent account configuration and validation.
 */

// ---------------------------------------------------------------------------
// Config Interfaces
// ---------------------------------------------------------------------------

export interface WebSocketConfig {
  /** Heartbeat interval in ms (default 30000). */
  heartbeatInterval?: number;
  /** Max reconnect attempts (-1 = infinite, default -1). */
  maxReconnectAttempts?: number;
  /** Reconnect base delay in ms (default 1000). */
  reconnectBaseDelay?: number;
  /** Reconnect max delay in ms (default 30000). */
  reconnectMaxDelay?: number;
}

export interface WebhookConfig {
  /** HMAC-SHA256 signing secret (the agent's secret_key). */
  secretKey: string;
  /** Listening port. */
  port: number;
  /** Listening path (default "/webhook"). */
  path?: string;
  /** Bind address (default "0.0.0.0"). */
  host?: string;
}

export interface NexusAccountConfig {
  /** Nexus Agent Token (must start with "nxa_"). */
  agentToken: string;
  /** Nexus Server base URL (HTTP or HTTPS). */
  serverUrl: string;
  /** Delivery mode: "websocket" (default) or "webhook". */
  deliveryMode: "websocket" | "webhook";
  /** Gateway WebSocket URL override. When set, skips GetClientConfig discovery. */
  gatewayUrl?: string;
  /** WebSocket tuning (only used when deliveryMode is "websocket"). */
  websocket?: WebSocketConfig;
  /** Webhook settings (required when deliveryMode is "webhook"). */
  webhook?: WebhookConfig;
}

// ---------------------------------------------------------------------------
// Validation Result Types
// ---------------------------------------------------------------------------

export interface ConfigError {
  field: string;
  message: string;
}

export type ConfigValidationResult =
  | { valid: true; config: NexusAccountConfig }
  | { valid: false; errors: ConfigError[] };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const AGENT_TOKEN_PREFIX = "nxa_";

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Validate a NexusAccountConfig object.
 *
 * Returns `{ valid: true, config }` when all checks pass, or
 * `{ valid: false, errors }` with descriptive errors identifying the
 * specific field and constraint violated.
 */
export function validateConfig(config: Partial<NexusAccountConfig>): ConfigValidationResult {
  const errors: ConfigError[] = [];

  // agentToken
  if (typeof config.agentToken !== "string" || config.agentToken.length === 0) {
    errors.push({ field: "agentToken", message: "agentToken is required" });
  } else if (!config.agentToken.startsWith(AGENT_TOKEN_PREFIX)) {
    errors.push({
      field: "agentToken",
      message: `agentToken must start with "${AGENT_TOKEN_PREFIX}"`,
    });
  }

  // serverUrl
  if (typeof config.serverUrl !== "string" || config.serverUrl.length === 0) {
    errors.push({ field: "serverUrl", message: "serverUrl is required" });
  } else if (!isValidHttpUrl(config.serverUrl)) {
    errors.push({
      field: "serverUrl",
      message: "serverUrl must be a valid HTTP or HTTPS URL",
    });
  }

  // deliveryMode
  const mode = config.deliveryMode ?? "websocket";
  if (mode !== "websocket" && mode !== "webhook") {
    errors.push({
      field: "deliveryMode",
      message: 'deliveryMode must be "websocket" or "webhook"',
    });
  }

  // Mode-specific validation
  if (mode === "webhook") {
    if (!config.webhook) {
      errors.push({
        field: "webhook",
        message: "webhook configuration is required when deliveryMode is webhook",
      });
    } else {
      if (typeof config.webhook.secretKey !== "string" || config.webhook.secretKey.length === 0) {
        errors.push({
          field: "webhook.secretKey",
          message: "webhook.secretKey is required when deliveryMode is webhook",
        });
      }
      if (!isPositiveInteger(config.webhook.port)) {
        errors.push({
          field: "webhook.port",
          message: "webhook.port must be a positive integer",
        });
      }
    }
  }

  // gatewayUrl (optional override)
  if (config.gatewayUrl !== undefined && config.gatewayUrl !== null) {
    try {
      const url = new URL(config.gatewayUrl);
      if (url.protocol !== "ws:" && url.protocol !== "wss:") {
        errors.push({
          field: "gatewayUrl",
          message: "gatewayUrl must be a valid ws:// or wss:// URL",
        });
      }
    } catch {
      errors.push({
        field: "gatewayUrl",
        message: "gatewayUrl must be a valid ws:// or wss:// URL",
      });
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Build the validated config with default deliveryMode
  const validated: NexusAccountConfig = {
    agentToken: config.agentToken!,
    serverUrl: config.serverUrl!,
    deliveryMode: mode,
    ...(config.gatewayUrl !== undefined && { gatewayUrl: config.gatewayUrl }),
    ...(config.websocket !== undefined && { websocket: config.websocket }),
    ...(config.webhook !== undefined && { webhook: config.webhook }),
  };

  return { valid: true, config: validated };
}
