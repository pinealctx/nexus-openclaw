// Unified gateway frame types (api/v1/gateway_frame_pb)
export type {
  ClientFrame,
  GatewayAuthResponse,
  GatewayErrorFrame,
  ServerFrame,
  Update,
} from "../generated/api/v1/gateway_frame_pb.js";
export {
  AuthRequestSchema,
  ClientFrameSchema,
  ClientFrameType,
  GatewayAuthResponseSchema,
  GatewayErrorFrameSchema,
  HeartbeatPingSchema,
  HeartbeatPongSchema,
  ServerFrameSchema,
  ServerFrameType,
  UpdateSchema,
} from "../generated/api/v1/gateway_frame_pb.js";
export type {
  GetDownloadURLRequest,
  GetDownloadURLResponse,
  UploadFileRequest,
  UploadFileResponse,
} from "../generated/api/v1/media_service_pb.js";
// Re-export generated message types
export type {
  AnswerCardActionRequest,
  EditMessageRequest,
  EditMessageResponse,
  EndStreamRequest,
  ErrorStreamRequest,
  PushStreamDeltaRequest,
  SendMessageRequest,
  SendMessageResponse,
} from "../generated/api/v1/message_service_pb.js";
export type { ErrorDetail } from "../generated/shared/v1/error_codes_pb.js";
export type { MediaFileInfo } from "../generated/shared/v1/media_pb.js";

export type {
  CardContent,
  MarkdownContent,
  MessageBody,
  MessageEntity,
  MessageEnvelope,
  ReplyContext,
  StreamContent,
  TextContent,
} from "../generated/shared/v1/message_pb.js";
export { MessageEnvelopeSchema } from "../generated/shared/v1/message_pb.js";
// Update sub-types (shared/v1/updates_pb)
export type {
  CardActionAnswer,
  CardActionPayload,
  NonSnUpdate,
  SnUpdate,
} from "../generated/shared/v1/updates_pb.js";
export {
  NonSnUpdateSchema,
  SnUpdateSchema,
} from "../generated/shared/v1/updates_pb.js";
// Re-export generated types for convenience
export {
  AnswerCardActionRequestSchema,
  createNexusClient,
  EditMessageRequestSchema,
  EndStreamRequestSchema,
  ErrorStreamRequestSchema,
  GetDownloadURLRequestSchema,
  MediaPurpose,
  MessageBodySchema,
  MessageEntityType,
  MessageType,
  NexusClient,
  PushStreamDeltaRequestSchema,
  SendMessageRequestSchema,
  StreamPhase,
  toBid,
  toBidOpt,
  toNum,
  UploadFileRequestSchema,
} from "./client.js";
