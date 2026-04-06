/**
 * WebSocket connector for Nexus AI Gateway.
 *
 * Manages the WebSocket connection to /ws/agent, handling authentication,
 * heartbeat keepalive, event dispatch, and exponential backoff reconnection.
 *
 * Frame protocol is JSON-based (simplified for this plugin):
 *   Client → Server: AUTH_REQUEST, HEARTBEAT_PING
 *   Server → Client: AUTH_RESPONSE, HEARTBEAT_PONG, EVENT_PUSH, ERROR
 */

import WebSocket from "ws";
import type { NexusAccountConfig } from "../config.js";
import type { NexusClient } from "../nexus-api/client.js";

// ---------------------------------------------------------------------------
// Frame types (JSON wire format)
// ---------------------------------------------------------------------------

interface AuthRequestFrame {
  type: "AUTH_REQUEST";
  token: string;
}

interface HeartbeatPingFrame {
  type: "HEARTBEAT_PING";
}

type ClientFrame = AuthRequestFrame | HeartbeatPingFrame;

interface AuthResponseFrame {
  type: "AUTH_RESPONSE";
  success: boolean;
  error?: string;
}

interface HeartbeatPongFrame {
  type: "HEARTBEAT_PONG";
}

interface EventPushFrame {
  type: "EVENT_PUSH";
  event: unknown;
}

interface ErrorFrame {
  type: "ERROR";
  code: string;
  message: string;
}

type ServerFrame =
  | AuthResponseFrame
  | HeartbeatPongFrame
  | EventPushFrame
  | ErrorFrame;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_HEARTBEAT_INTERVAL = 30_000; // 30s
const HEARTBEAT_TIMEOUT_MULTIPLIER = 3; // 3x heartbeat = 90s
const DEFAULT_RECONNECT_BASE_DELAY = 1_000; // 1s
const DEFAULT_RECONNECT_MAX_DELAY = 30_000; // 30s
const MAX_JITTER = 1_000; // 0-1000ms random jitter

// ---------------------------------------------------------------------------
// Reconnection delay calculator (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Compute reconnection delay with exponential backoff and jitter.
 *
 * delay = min(baseDelay * 2^attempt, maxDelay) + random_jitter(0, MAX_JITTER)
 */
export function computeReconnectDelay(
  attempt: number,
  baseDelay: number,
  maxDelay: number,
): number {
  const exponential = Math.min(baseDelay * 2 ** attempt, maxDelay);
  const jitter = Math.floor(Math.random() * (MAX_JITTER + 1));
  return exponential + jitter;
}

// ---------------------------------------------------------------------------
// Non-recoverable error codes that should stop reconnection
// ---------------------------------------------------------------------------

const NON_RECOVERABLE_ERROR_CODES = new Set([
  "AUTH_FAILED",
  "TOKEN_REVOKED",
  "TOKEN_EXPIRED",
  "UNAUTHENTICATED",
]);

// ---------------------------------------------------------------------------
// WebSocketConnector
// ---------------------------------------------------------------------------

export class WebSocketConnector {
  private ws: WebSocket | null = null;
  private authenticated = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPongTimestamp = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private gatewayUrl: string | null = null;

  // Callbacks
  private eventHandler: ((event: unknown) => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  private disconnectHandler: ((reason: string) => void) | null = null;

  // Resolved config values
  private readonly heartbeatInterval: number;
  private readonly heartbeatTimeout: number;
  private readonly reconnectBaseDelay: number;
  private readonly reconnectMaxDelay: number;
  private readonly maxReconnectAttempts: number;

  constructor(
    private readonly config: NexusAccountConfig,
    private readonly nexusClient: NexusClient,
  ) {
    const ws = config.websocket;
    this.heartbeatInterval = ws?.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL;
    this.heartbeatTimeout = this.heartbeatInterval * HEARTBEAT_TIMEOUT_MULTIPLIER;
    this.reconnectBaseDelay = ws?.reconnectBaseDelay ?? DEFAULT_RECONNECT_BASE_DELAY;
    this.reconnectMaxDelay = ws?.reconnectMaxDelay ?? DEFAULT_RECONNECT_MAX_DELAY;
    this.maxReconnectAttempts = ws?.maxReconnectAttempts ?? -1;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Whether the connection is authenticated and ready. */
  get connected(): boolean {
    return (
      this.ws !== null &&
      this.ws.readyState === WebSocket.OPEN &&
      this.authenticated
    );
  }

  /** Register a handler for incoming WebhookEvent payloads. */
  onEvent(handler: (event: unknown) => void): void {
    this.eventHandler = handler;
  }

  /** Register a handler for errors. */
  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  /** Register a handler for disconnection. */
  onDisconnect(handler: (reason: string) => void): void {
    this.disconnectHandler = handler;
  }

  /**
   * Connect to the Nexus Gateway WebSocket endpoint.
   *
   * Discovers the gateway URL via NexusClient, establishes the WebSocket
   * connection, and authenticates with the agent token.
   */
  async connect(): Promise<void> {
    this.stopping = false;
    this.reconnectAttempt = 0;

    // Discover gateway URL if not cached.
    if (!this.gatewayUrl) {
      this.gatewayUrl = await this.nexusClient.discoverGatewayUrl();
    }

    await this.establishConnection();
  }

  /**
   * Gracefully disconnect from the Gateway.
   *
   * Stops heartbeat, cancels pending reconnection, and closes the socket.
   */
  async disconnect(): Promise<void> {
    this.stopping = true;
    this.clearTimers();

    if (this.ws) {
      this.ws.removeAllListeners();
      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close(1000, "client disconnect");
      }
      this.ws = null;
    }

    this.authenticated = false;
  }

  // -----------------------------------------------------------------------
  // Connection establishment
  // -----------------------------------------------------------------------

  private establishConnection(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const url = this.gatewayUrl!;
      const ws = new WebSocket(url);
      this.ws = ws;
      this.authenticated = false;

      let settled = false;

      ws.on("open", () => {
        this.sendAuthRequest();
      });

      ws.on("message", (data: WebSocket.Data) => {
        const frame = this.parseFrame(data);
        if (!frame) return;

        switch (frame.type) {
          case "AUTH_RESPONSE":
            this.handleAuthResponse(frame);
            if (!settled) {
              settled = true;
              if (frame.success) {
                resolve();
              } else {
                reject(
                  new Error(
                    `Authentication failed: ${frame.error ?? "unknown error"}`,
                  ),
                );
              }
            }
            break;

          case "HEARTBEAT_PONG":
            this.handleHeartbeatPong();
            break;

          case "EVENT_PUSH":
            this.handleEventPush(frame);
            break;

          case "ERROR":
            this.handleErrorFrame(frame);
            break;

          default:
            // Unknown frame type — ignore.
            break;
        }
      });

      ws.on("error", (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
        this.emitError(err);
      });

      ws.on("close", (_code: number, reason: Buffer) => {
        const reasonStr = reason.toString() || "connection closed";
        this.authenticated = false;
        this.clearHeartbeat();

        if (!settled) {
          settled = true;
          reject(new Error(`WebSocket closed before auth: ${reasonStr}`));
        }

        this.disconnectHandler?.(reasonStr);

        if (!this.stopping) {
          this.scheduleReconnect();
        }
      });
    });
  }

  // -----------------------------------------------------------------------
  // Authentication
  // -----------------------------------------------------------------------

  private sendAuthRequest(): void {
    const frame: AuthRequestFrame = {
      type: "AUTH_REQUEST",
      token: this.config.agentToken,
    };
    this.sendFrame(frame);
  }

  private handleAuthResponse(frame: AuthResponseFrame): void {
    if (frame.success) {
      this.authenticated = true;
      this.reconnectAttempt = 0;
      this.startHeartbeat();
    } else {
      // Auth failure is non-recoverable — stop reconnection.
      this.stopping = true;
      this.emitError(
        new Error(`Authentication failed: ${frame.error ?? "unknown"}`),
      );
    }
  }

  // -----------------------------------------------------------------------
  // Heartbeat
  // -----------------------------------------------------------------------

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.lastPongTimestamp = Date.now();

    // Send HEARTBEAT_PING at the configured interval.
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        const frame: HeartbeatPingFrame = { type: "HEARTBEAT_PING" };
        this.sendFrame(frame);
      }
    }, this.heartbeatInterval);

    // Check for pong timeout.
    this.heartbeatTimeoutTimer = setInterval(() => {
      const elapsed = Date.now() - this.lastPongTimestamp;
      if (elapsed > this.heartbeatTimeout) {
        this.ws?.close(4000, "heartbeat timeout");
      }
    }, this.heartbeatInterval);
  }

  private handleHeartbeatPong(): void {
    this.lastPongTimestamp = Date.now();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.heartbeatTimeoutTimer) {
      clearInterval(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  // -----------------------------------------------------------------------
  // Event dispatch
  // -----------------------------------------------------------------------

  private handleEventPush(frame: EventPushFrame): void {
    this.eventHandler?.(frame.event);
  }

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  private handleErrorFrame(frame: ErrorFrame): void {
    const err = new Error(`Gateway error [${frame.code}]: ${frame.message}`);
    this.emitError(err);

    if (NON_RECOVERABLE_ERROR_CODES.has(frame.code)) {
      this.stopping = true;
      this.ws?.close(4001, "non-recoverable error");
    }
  }

  private emitError(err: Error): void {
    this.errorHandler?.(err);
  }

  // -----------------------------------------------------------------------
  // Reconnection with exponential backoff
  // -----------------------------------------------------------------------

  private scheduleReconnect(): void {
    if (this.stopping) return;

    if (
      this.maxReconnectAttempts >= 0 &&
      this.reconnectAttempt >= this.maxReconnectAttempts
    ) {
      this.emitError(
        new Error(
          `Max reconnect attempts (${this.maxReconnectAttempts}) reached`,
        ),
      );
      return;
    }

    const delay = computeReconnectDelay(
      this.reconnectAttempt,
      this.reconnectBaseDelay,
      this.reconnectMaxDelay,
    );
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(async () => {
      if (this.stopping) return;

      try {
        await this.establishConnection();
        // Reconnect succeeded — attempt counter is reset in handleAuthResponse.
      } catch {
        // establishConnection rejected — the close handler will schedule
        // the next reconnect attempt automatically.
      }
    }, delay);
  }

  // -----------------------------------------------------------------------
  // Frame I/O helpers
  // -----------------------------------------------------------------------

  private sendFrame(frame: ClientFrame): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  private parseFrame(data: WebSocket.Data): ServerFrame | null {
    try {
      const text =
        typeof data === "string" ? data : (data as Buffer).toString("utf-8");
      const parsed = JSON.parse(text) as Record<string, unknown>;

      if (typeof parsed.type !== "string") return null;
      return parsed as unknown as ServerFrame;
    } catch {
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Timer cleanup
  // -----------------------------------------------------------------------

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
