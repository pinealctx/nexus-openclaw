/**
 * Lightweight Connect RPC client for Nexus AI API.
 *
 * Connect RPC uses HTTP POST with JSON bodies. URL pattern:
 *   {serverUrl}/{package}.{Service}/{Method}
 *
 * This avoids depending on generated protobuf types — the package
 * talks to Nexus over plain HTTP/JSON.
 */

import type { NexusAccountConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Request / Response types (minimal, only fields we use)
// ---------------------------------------------------------------------------

// -- Auth --

export interface GetClientConfigResponse {
  gateway?: {
    wsUrl?: string;
  };
}

// -- Message --

export interface MessageBody {
  type: string;
  textContent?: { text: string; entities?: MessageEntity[] };
  markdownContent?: { rawMarkdown: string };
  streamContent?: { phase: string };
  imageContent?: { fileId: string };
  audioContent?: { fileId: string };
  videoContent?: { fileId: string };
  fileContent?: { fileId: string };
  cardContent?: { cardJson: string };
}

export interface MessageEntity {
  type: string;
  offset: number;
  length: number;
  userId?: number;
  url?: string;
}

export interface SendMessageRequest {
  clientMessageId: string;
  conversationId: string;
  body: MessageBody;
  replyToMessageId?: string;
}

export interface SendMessageResponse {
  messageId: string;
  createdAt: string;
}

export interface EditMessageRequest {
  conversationId: string;
  messageId: string;
  newBody: MessageBody;
}

export interface EditMessageResponse {
  updatedAt: string;
}

// -- Stream --

export interface PushStreamDeltaRequest {
  conversationId: string;
  messageId: string;
  seq: number;
  delta: string;
}

export interface EndStreamRequest {
  conversationId: string;
  messageId: string;
  accumulatedText: string;
  entities?: MessageEntity[];
}

export interface ErrorStreamRequest {
  conversationId: string;
  messageId: string;
  errorMessage: string;
}

// -- Card --

export interface AnswerCardActionRequest {
  actionId: string;
  text?: string;
  showAlert: boolean;
}

// -- Media --

export interface UploadFileRequest {
  fileName: string;
  contentType: string;
  purpose: string;
  data: string; // base64-encoded
}

export interface UploadFileResponse {
  file?: {
    fileId?: string;
    publicUrl?: string;
    fileName?: string;
    contentType?: string;
    size?: string;
  };
}

export interface GetDownloadUrlRequest {
  fileId: string;
}

export interface GetDownloadUrlResponse {
  url: string;
  expiresAt: string;
}

// -- Agent --

export interface SetDeliveryConfigRequest {
  webhook?: { url: string };
  websocket?: Record<string, never>;
  none?: Record<string, never>;
}

export interface SetDeliveryConfigResponse {
  webhookSecret?: string;
}

// ---------------------------------------------------------------------------
// RPC Error
// ---------------------------------------------------------------------------

export class NexusRpcError extends Error {
  constructor(
    public readonly service: string,
    public readonly method: string,
    public readonly status: number,
    public readonly code: string,
    public readonly detail: string,
  ) {
    super(`${service}/${method} failed (${status}): [${code}] ${detail}`);
    this.name = "NexusRpcError";
  }
}

// ---------------------------------------------------------------------------
// Token masking helper (for safe logging)
// ---------------------------------------------------------------------------

function maskToken(token: string): string {
  if (token.length <= 8) return "***";
  return token.slice(0, 4) + "***" + token.slice(-4);
}

// ---------------------------------------------------------------------------
// NexusClient
// ---------------------------------------------------------------------------

const CONNECT_RPC_CONTENT_TYPE = "application/json";

/**
 * Lightweight HTTP client wrapping Nexus Connect RPC endpoints.
 *
 * All RPC methods use HTTP POST with JSON bodies. The URL pattern is:
 *   {serverUrl}/{package}.{Service}/{Method}
 */
export class NexusClient {
  private readonly serverUrl: string;
  private readonly agentToken: string;

  constructor(private readonly config: NexusAccountConfig) {
    // Strip trailing slash from serverUrl for consistent URL building.
    this.serverUrl = config.serverUrl.replace(/\/+$/, "");
    this.agentToken = config.agentToken;
  }

  // -----------------------------------------------------------------------
  // Generic RPC caller
  // -----------------------------------------------------------------------

  /**
   * Execute a Connect RPC call.
   *
   * @param service  Fully-qualified service name, e.g. "api.v1.AuthService"
   * @param method   Method name, e.g. "GetClientConfig"
   * @param request  JSON-serializable request body
   * @param skipAuth If true, omit the Authorization header
   */
  async rpc<Req, Res>(
    service: string,
    method: string,
    request: Req,
    skipAuth = false,
  ): Promise<Res> {
    const url = `${this.serverUrl}/${service}/${method}`;

    const headers: Record<string, string> = {
      "Content-Type": CONNECT_RPC_CONTENT_TYPE,
    };

    if (!skipAuth) {
      headers["Authorization"] = `Bearer ${this.agentToken}`;
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });

    if (!res.ok) {
      let code = "UNKNOWN";
      let detail = res.statusText;
      try {
        const errBody = (await res.json()) as { code?: string; message?: string };
        code = errBody.code ?? code;
        detail = errBody.message ?? detail;
      } catch {
        // response body is not JSON — keep defaults
      }
      throw new NexusRpcError(service, method, res.status, code, detail);
    }

    return (await res.json()) as Res;
  }

  // -----------------------------------------------------------------------
  // Auth
  // -----------------------------------------------------------------------

  /**
   * Discover the agent WebSocket gateway URL.
   *
   * Calls AuthService.GetClientConfig (skip_auth) to obtain
   * GatewayEndpoints.ws_url, then replaces `/ws` with `/ws/agent`.
   */
  async discoverGatewayUrl(): Promise<string> {
    const res = await this.rpc<Record<string, never>, GetClientConfigResponse>(
      "api.v1.AuthService",
      "GetClientConfig",
      {},
      true, // skip_auth
    );

    const wsUrl = res.gateway?.wsUrl;
    if (!wsUrl) {
      throw new Error(
        "GetClientConfig did not return a gateway ws_url",
      );
    }

    // Replace trailing /ws with /ws/agent.
    return wsUrl.replace(/\/ws\/?$/, "/ws/agent");
  }

  // -----------------------------------------------------------------------
  // Message
  // -----------------------------------------------------------------------

  async sendMessage(req: SendMessageRequest): Promise<SendMessageResponse> {
    return this.rpc("api.v1.MessageService", "SendMessage", req);
  }

  async editMessage(req: EditMessageRequest): Promise<EditMessageResponse> {
    return this.rpc("api.v1.MessageService", "EditMessage", req);
  }

  // -----------------------------------------------------------------------
  // Stream
  // -----------------------------------------------------------------------

  async pushStreamDelta(req: PushStreamDeltaRequest): Promise<void> {
    await this.rpc("api.v1.MessageService", "PushStreamDelta", req);
  }

  async endStream(req: EndStreamRequest): Promise<void> {
    await this.rpc("api.v1.MessageService", "EndStream", req);
  }

  async errorStream(req: ErrorStreamRequest): Promise<void> {
    await this.rpc("api.v1.MessageService", "ErrorStream", req);
  }

  // -----------------------------------------------------------------------
  // Card
  // -----------------------------------------------------------------------

  async answerCardAction(req: AnswerCardActionRequest): Promise<void> {
    await this.rpc("api.v1.MessageService", "AnswerCardAction", req);
  }

  // -----------------------------------------------------------------------
  // Media
  // -----------------------------------------------------------------------

  async uploadFile(req: UploadFileRequest): Promise<UploadFileResponse> {
    return this.rpc("api.v1.MediaService", "UploadFile", req);
  }

  async getDownloadUrl(req: GetDownloadUrlRequest): Promise<GetDownloadUrlResponse> {
    return this.rpc("api.v1.MediaService", "GetDownloadURL", req);
  }

  // -----------------------------------------------------------------------
  // Agent
  // -----------------------------------------------------------------------

  async setDeliveryConfig(req: SetDeliveryConfigRequest): Promise<SetDeliveryConfigResponse> {
    return this.rpc("api.v1.AgentService", "SetDeliveryConfig", req);
  }

  // -----------------------------------------------------------------------
  // Diagnostics (safe for logging)
  // -----------------------------------------------------------------------

  /** Return a log-safe description of this client (token masked). */
  toString(): string {
    return `NexusClient(server=${this.serverUrl}, token=${maskToken(this.agentToken)})`;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a NexusClient from account configuration. */
export function createNexusClient(config: NexusAccountConfig): NexusClient {
  return new NexusClient(config);
}
