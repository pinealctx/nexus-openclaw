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
  MessageBody,
  MessageEntity,
  TextContent,
  MarkdownContent,
  CardContent,
  StreamContent,
  MessageEnvelope,
  ReplyContext,
} from "../generated/shared/v1/message_pb.js";

export type { MediaFileInfo } from "../generated/shared/v1/media_pb.js";

// Unified gateway frame types (api/v1/gateway_frame_pb)
export type {
  ClientFrame,
  ServerFrame,
  GatewayAuthResponse,
  GatewayErrorFrame,
  Update,
} from "../generated/api/v1/gateway_frame_pb.js";

export {
  ClientFrameType,
  ServerFrameType,
} from "../generated/api/v1/gateway_frame_pb.js";

export {
  ClientFrameSchema,
  ServerFrameSchema,
  AuthRequestSchema,
  UpdateSchema,
  HeartbeatPingSchema,
  HeartbeatPongSchema,
  GatewayAuthResponseSchema,
  GatewayErrorFrameSchema,
} from "../generated/api/v1/gateway_frame_pb.js";

// Update sub-types (shared/v1/updates_pb)
export type {
  SnUpdate,
  NonSnUpdate,
  CardActionPayload,
  CardActionAnswer,
} from "../generated/shared/v1/updates_pb.js";

export {
  SnUpdateSchema,
  NonSnUpdateSchema,
} from "../generated/shared/v1/updates_pb.js";

export type { ErrorDetail } from "../generated/shared/v1/error_codes_pb.js";

export {
  MessageEnvelopeSchema,
} from "../generated/shared/v1/message_pb.js";
