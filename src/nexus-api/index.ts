export { NexusClient, createNexusClient } from "./client.js";

// Re-export generated types for convenience
export {
  MessageType,
  StreamPhase,
  MessageBodySchema,
  MessageEntityType,
  toNum,
  toBid,
  toBidOpt,
} from "./client.js";

export { MediaPurpose } from "./client.js";

export {
  SendMessageRequestSchema,
  EditMessageRequestSchema,
  PushStreamDeltaRequestSchema,
  EndStreamRequestSchema,
  ErrorStreamRequestSchema,
  AnswerCardActionRequestSchema,
} from "./client.js";

export {
  UploadFileRequestSchema,
  GetDownloadURLRequestSchema,
} from "./client.js";

export {
  SetDeliveryConfigRequestSchema,
} from "./client.js";

// Re-export generated message types
export type {
  SendMessageRequest,
  SendMessageResponse,
  EditMessageRequest,
  EditMessageResponse,
  PushStreamDeltaRequest,
  EndStreamRequest,
  ErrorStreamRequest,
  AnswerCardActionRequest,
} from "../generated/api/v1/message_service_pb.js";

export type {
  UploadFileRequest,
  UploadFileResponse,
  GetDownloadURLRequest,
  GetDownloadURLResponse,
} from "../generated/api/v1/media_service_pb.js";

export type {
  SetDeliveryConfigRequest,
  SetDeliveryConfigResponse,
} from "../generated/api/v1/agent_service_pb.js";

export type {
  MessageBody,
  MessageEntity,
  TextContent,
  MarkdownContent,
  CardContent,
  StreamContent,
  MessageEnvelope,
  ReplyContext,
} from "../generated/shared/v1/message_pb.js";

export type { WebhookEvent } from "../generated/shared/v1/webhook_events_pb.js";

export type { MediaFileInfo } from "../generated/shared/v1/media_pb.js";

export type {
  AgentClientFrame,
  AgentServerFrame,
} from "../generated/shared/v1/gateway_agent_frame_pb.js";

export type {
  GatewayAuthResponse,
  GatewayErrorFrame,
} from "../generated/shared/v1/gateway_common_pb.js";

export type { ErrorDetail } from "../generated/shared/v1/error_codes_pb.js";

export {
  WebhookEventType,
} from "../generated/shared/v1/webhook_events_pb.js";

export {
  AgentClientFrameType,
  AgentServerFrameType,
} from "../generated/shared/v1/gateway_agent_frame_pb.js";

export {
  AgentClientFrameSchema,
  AgentServerFrameSchema,
  AgentAuthRequestSchema,
} from "../generated/shared/v1/gateway_agent_frame_pb.js";

export {
  HeartbeatPingSchema,
  HeartbeatPongSchema,
  GatewayAuthResponseSchema,
  GatewayErrorFrameSchema,
} from "../generated/shared/v1/gateway_common_pb.js";

export {
  WebhookEventSchema,
} from "../generated/shared/v1/webhook_events_pb.js";

export {
  MessageEnvelopeSchema,
} from "../generated/shared/v1/message_pb.js";

export type {
  WebhookDeliveryConfig,
  WebSocketDeliveryConfig,
  NoDeliveryConfig,
} from "../generated/shared/v1/agent_pb.js";

export {
  WebhookDeliveryConfigSchema,
  WebSocketDeliveryConfigSchema,
  NoDeliveryConfigSchema,
} from "../generated/shared/v1/agent_pb.js";
