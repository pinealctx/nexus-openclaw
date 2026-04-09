/**
 * Connect RPC client for Nexus AI API.
 *
 * Uses @connectrpc/connect-web transport with generated protobuf types.
 * All RPC calls are typed via generated service descriptors.
 */

import { create } from "@bufbuild/protobuf";
import { createClient, type Client, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";

import type { NexusAccountConfig } from "../config.js";

// Generated service descriptors and schemas
import { AuthService, GetClientConfigRequestSchema } from "../generated/api/v1/auth_service_pb.js";
import {
  MessageService,
  type SendMessageRequest,
  type SendMessageResponse,
  type EditMessageRequest,
  type EditMessageResponse,
  type PushStreamDeltaRequest,
  type EndStreamRequest,
  type ErrorStreamRequest,
  type AnswerCardActionRequest,
  SendMessageRequestSchema,
  EditMessageRequestSchema,
  PushStreamDeltaRequestSchema,
  EndStreamRequestSchema,
  ErrorStreamRequestSchema,
  AnswerCardActionRequestSchema,
} from "../generated/api/v1/message_service_pb.js";
import {
  MediaService,
  type UploadFileRequest,
  type UploadFileResponse,
  type GetDownloadURLRequest,
  type GetDownloadURLResponse,
  UploadFileRequestSchema,
  GetDownloadURLRequestSchema,
} from "../generated/api/v1/media_service_pb.js";
import {
  AgentService,
  type SetDeliveryConfigRequest,
  type SetDeliveryConfigResponse,
  SetDeliveryConfigRequestSchema,
} from "../generated/api/v1/agent_service_pb.js";
import { MessageType, StreamPhase, MessageBodySchema, MessageEntityType } from "../generated/shared/v1/message_pb.js";
import { MediaPurpose } from "../generated/shared/v1/media_pb.js";

// ---------------------------------------------------------------------------
// int64 boundary helpers
// ---------------------------------------------------------------------------

/** Convert bigint to number for internal plugin types. */
export function toNum(v: bigint | undefined): number {
  if (v === undefined) return 0;
  return Number(v);
}

/** Convert number to bigint for proto request fields. */
export function toBid(v: number): bigint {
  return BigInt(v);
}

/** Convert optional number to optional bigint for proto request fields. */
export function toBidOpt(v: number | undefined): bigint | undefined {
  return v !== undefined ? BigInt(v) : undefined;
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

/**
 * Connect RPC client wrapping Nexus API endpoints.
 *
 * Uses typed service clients generated from protobuf definitions.
 */
export class NexusClient {
  private readonly serverUrl: string;
  private readonly agentToken: string;

  private readonly messageClient: Client<typeof MessageService>;
  private readonly mediaClient: Client<typeof MediaService>;
  private readonly agentClient: Client<typeof AgentService>;
  private readonly authClient: Client<typeof AuthService>;

  constructor(private readonly config: NexusAccountConfig) {
    this.serverUrl = config.serverUrl.replace(/\/+$/, "");
    this.agentToken = config.agentToken;

    // Auth interceptor adds Bearer token to all requests.
    const authInterceptor: Interceptor = (next) => async (req) => {
      req.header.set("Authorization", `Bearer ${this.agentToken}`);
      return await next(req);
    };

    // Transport with auth interceptor.
    const transport = createConnectTransport({
      baseUrl: this.serverUrl,
      interceptors: [authInterceptor],
    });

    // No-auth transport for GetClientConfig (public endpoint).
    const noAuthTransport = createConnectTransport({
      baseUrl: this.serverUrl,
    });

    this.messageClient = createClient(MessageService, transport);
    this.mediaClient = createClient(MediaService, transport);
    this.agentClient = createClient(AgentService, transport);
    this.authClient = createClient(AuthService, noAuthTransport);
  }

  // -----------------------------------------------------------------------
  // Auth
  // -----------------------------------------------------------------------

  /**
   * Discover the WebSocket gateway URL.
   *
   * Calls AuthService.GetClientConfig (no auth) to obtain
   * GatewayEndpoints.ws_url. The unified gateway serves both
   * users and agents on the same /ws endpoint.
   */
  async discoverGatewayUrl(): Promise<string> {
    const res = await this.authClient.getClientConfig(
      create(GetClientConfigRequestSchema, {}),
    );

    const wsUrl = res.gateway?.wsUrl;
    if (!wsUrl) {
      throw new Error(
        "GetClientConfig did not return a gateway ws_url",
      );
    }

    return wsUrl;
  }

  // -----------------------------------------------------------------------
  // Message
  // -----------------------------------------------------------------------

  async sendMessage(req: SendMessageRequest): Promise<SendMessageResponse> {
    return this.messageClient.sendMessage(req);
  }

  async editMessage(req: EditMessageRequest): Promise<EditMessageResponse> {
    return this.messageClient.editMessage(req);
  }

  // -----------------------------------------------------------------------
  // Stream
  // -----------------------------------------------------------------------

  async pushStreamDelta(req: PushStreamDeltaRequest): Promise<void> {
    await this.messageClient.pushStreamDelta(req);
  }

  async endStream(req: EndStreamRequest): Promise<void> {
    await this.messageClient.endStream(req);
  }

  async errorStream(req: ErrorStreamRequest): Promise<void> {
    await this.messageClient.errorStream(req);
  }

  // -----------------------------------------------------------------------
  // Card
  // -----------------------------------------------------------------------

  async answerCardAction(req: AnswerCardActionRequest): Promise<void> {
    await this.messageClient.answerCardAction(req);
  }

  // -----------------------------------------------------------------------
  // Media
  // -----------------------------------------------------------------------

  async uploadFile(req: UploadFileRequest): Promise<UploadFileResponse> {
    return this.mediaClient.uploadFile(req);
  }

  async getDownloadUrl(req: GetDownloadURLRequest): Promise<GetDownloadURLResponse> {
    return this.mediaClient.getDownloadURL(req);
  }

  // -----------------------------------------------------------------------
  // Agent
  // -----------------------------------------------------------------------

  async setDeliveryConfig(req: SetDeliveryConfigRequest): Promise<SetDeliveryConfigResponse> {
    return this.agentClient.setDeliveryConfig(req);
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

// Re-export generated types for convenience
export { MessageType, StreamPhase, MessageBodySchema, MessageEntityType } from "../generated/shared/v1/message_pb.js";
export { MediaPurpose } from "../generated/shared/v1/media_pb.js";
export { SendMessageRequestSchema, EditMessageRequestSchema, PushStreamDeltaRequestSchema, EndStreamRequestSchema, ErrorStreamRequestSchema, AnswerCardActionRequestSchema } from "../generated/api/v1/message_service_pb.js";
export { UploadFileRequestSchema, GetDownloadURLRequestSchema } from "../generated/api/v1/media_service_pb.js";
export { SetDeliveryConfigRequestSchema } from "../generated/api/v1/agent_service_pb.js";
