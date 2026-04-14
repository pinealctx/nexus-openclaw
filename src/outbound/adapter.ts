/**
 * Outbound adapter for sending messages to Nexus AI.
 *
 * Handles text/markdown, media, and Adaptive Card messages with
 * retry logic and error classification.
 */

import { create } from "@bufbuild/protobuf";
import { Code as ConnectCode, ConnectError } from "@connectrpc/connect";
import {
  AudioContentSchema,
  CardContentSchema,
  FileContentSchema,
  ImageContentSchema,
  MarkdownContentSchema,
  TextContentSchema,
  VideoContentSchema,
} from "../generated/shared/v1/message_pb.js";
import { consoleLogger, type NexusLogger } from "../logger.js";
import type { NexusClient } from "../nexus-api/client.js";
import {
  AnswerCardActionRequestSchema,
  EditMessageRequestSchema,
  MediaPurpose,
  MessageBodySchema,
  MessageType,
  SendMessageRequestSchema,
  toBid,
  toBidOpt,
  UploadFileRequestSchema,
} from "../nexus-api/index.js";
import type { MediaType, OutboundTarget, SendOptions } from "../types.js";
import { generateClientMessageId } from "../utils/id-gen.js";
import { isMarkdown } from "../utils/markdown-detect.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max retries for sendMessage calls. */
const SEND_MAX_RETRIES = 2;
/** Base delay (ms) for exponential backoff. */
const SEND_BACKOFF_BASE = 500;

/** Max retries for uploadFile calls. */
const UPLOAD_MAX_RETRIES = 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Determine the Nexus message type for outbound text.
 */
function resolveTextType(text: string, options?: SendOptions): MessageType {
  if (options?.forceMarkdown || isMarkdown(text)) {
    return MessageType.MARKDOWN;
  }
  return MessageType.TEXT;
}

/**
 * Map a MediaType to the corresponding Nexus MessageType enum value.
 */
function _mediaTypeToMessageType(type: MediaType): MessageType {
  switch (type) {
    case "image":
      return MessageType.IMAGE;
    case "audio":
      return MessageType.AUDIO;
    case "video":
      return MessageType.VIDEO;
    case "file":
      return MessageType.FILE;
  }
}

/**
 * Build a MessageBody for a media type using the oneof content pattern.
 * Each case is handled individually so TypeScript narrows the literal type.
 */
function buildMediaBody(type: MediaType, fileId: string) {
  switch (type) {
    case "image":
      return create(MessageBodySchema, {
        type: MessageType.IMAGE,
        content: { case: "image", value: create(ImageContentSchema, { fileId }) },
      });
    case "audio":
      return create(MessageBodySchema, {
        type: MessageType.AUDIO,
        content: { case: "audio", value: create(AudioContentSchema, { fileId }) },
      });
    case "video":
      return create(MessageBodySchema, {
        type: MessageType.VIDEO,
        content: { case: "video", value: create(VideoContentSchema, { fileId }) },
      });
    case "file":
      return create(MessageBodySchema, {
        type: MessageType.FILE,
        content: { case: "file", value: create(FileContentSchema, { fileId }) },
      });
  }
}

/**
 * Map a MediaType to a MIME content-type hint for upload.
 */
function mediaTypeToContentType(type: MediaType): string {
  switch (type) {
    case "image":
      return "image/*";
    case "audio":
      return "audio/*";
    case "video":
      return "video/*";
    case "file":
      return "application/octet-stream";
  }
}

// ---------------------------------------------------------------------------
// NexusOutboundAdapter
// ---------------------------------------------------------------------------

export class NexusOutboundAdapter {
  private readonly log: NexusLogger;

  constructor(
    private readonly nexusClient: NexusClient,
    logger?: NexusLogger,
  ) {
    this.log = logger ?? consoleLogger;
  }

  // -----------------------------------------------------------------------
  // sendText
  // -----------------------------------------------------------------------

  /**
   * Send a text or markdown message to a Nexus conversation.
   *
   * Markdown is auto-detected unless `forceMarkdown` is set.
   */
  async sendText(target: OutboundTarget, text: string, options?: SendOptions): Promise<void> {
    const msgType = resolveTextType(text, options);
    const clientMessageId = generateClientMessageId();

    const body = create(MessageBodySchema, {
      type: msgType,
      content:
        msgType === MessageType.MARKDOWN
          ? { case: "markdown", value: create(MarkdownContentSchema, { rawMarkdown: text }) }
          : { case: "text", value: create(TextContentSchema, { text }) },
    });

    await this.sendMessageWithRetry(
      create(SendMessageRequestSchema, {
        clientMessageId,
        conversationId: toBid(target.conversationId),
        body,
        replyToMessageId: toBidOpt(target.replyToMessageId),
      }),
    );
  }

  // -----------------------------------------------------------------------
  // sendMedia
  // -----------------------------------------------------------------------

  /**
   * Upload a media file and send it as a media message.
   *
   * On upload failure (after 1 retry) falls back to a text message
   * containing the URL as a link.
   */
  async sendMedia(target: OutboundTarget, media: { url: string; type: MediaType; fileName?: string }): Promise<void> {
    const fileName = media.fileName ?? this.fileNameFromUrl(media.url);
    const contentType = mediaTypeToContentType(media.type);

    let fileId: string | undefined;
    try {
      const data = await this.fetchAsUint8Array(media.url);
      fileId = await this.uploadWithRetry(fileName, contentType, data);
    } catch {
      // Upload failed — fall back to text link.
      this.log.warn(`[NexusOutbound] media upload failed for ${media.url}, falling back to text link`);
    }

    if (fileId) {
      const clientMessageId = generateClientMessageId();
      const body = buildMediaBody(media.type, fileId);

      await this.sendMessageWithRetry(
        create(SendMessageRequestSchema, {
          clientMessageId,
          conversationId: toBid(target.conversationId),
          body,
          replyToMessageId: toBidOpt(target.replyToMessageId),
        }),
      );
    } else {
      // Fallback: send URL as a text link.
      await this.sendText(target, `[${fileName}](${media.url})`);
    }
  }

  // -----------------------------------------------------------------------
  // sendCard
  // -----------------------------------------------------------------------

  /**
   * Send an Adaptive Card message.
   */
  async sendCard(target: OutboundTarget, cardJson: string): Promise<void> {
    const clientMessageId = generateClientMessageId();

    await this.sendMessageWithRetry(
      create(SendMessageRequestSchema, {
        clientMessageId,
        conversationId: toBid(target.conversationId),
        body: create(MessageBodySchema, {
          type: MessageType.CARD,
          content: { case: "card", value: create(CardContentSchema, { cardJson }) },
        }),
        replyToMessageId: toBidOpt(target.replyToMessageId),
      }),
    );
  }

  // -----------------------------------------------------------------------
  // answerCardAction
  // -----------------------------------------------------------------------

  /**
   * Respond to a card action callback.
   */
  async answerCardAction(actionId: string, text?: string, showAlert?: boolean): Promise<void> {
    await this.nexusClient.answerCardAction(
      create(AnswerCardActionRequestSchema, {
        actionId,
        text,
        showAlert: showAlert ?? false,
      }),
    );
  }

  // -----------------------------------------------------------------------
  // editCard
  // -----------------------------------------------------------------------

  /**
   * Update an existing card message with new JSON content.
   */
  async editCard(conversationId: number, messageId: number, cardJson: string): Promise<void> {
    await this.nexusClient.editMessage(
      create(EditMessageRequestSchema, {
        conversationId: toBid(conversationId),
        messageId: toBid(messageId),
        newBody: create(MessageBodySchema, {
          type: MessageType.CARD,
          content: { case: "card", value: create(CardContentSchema, { cardJson }) },
        }),
      }),
    );
  }

  // -----------------------------------------------------------------------
  // Retry helpers
  // -----------------------------------------------------------------------

  /**
   * Send a message with retry logic.
   *
   * - UNAUTHENTICATED: throw immediately (no retry).
   * - NOT_FOUND: log and skip (no retry).
   * - Other errors: retry up to SEND_MAX_RETRIES with exponential backoff.
   */
  private async sendMessageWithRetry(req: Parameters<NexusClient["sendMessage"]>[0]): Promise<void> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= SEND_MAX_RETRIES; attempt++) {
      try {
        await this.nexusClient.sendMessage(req);
        return;
      } catch (err: unknown) {
        lastError = err;

        if (err instanceof ConnectError) {
          if (err.code === ConnectCode.Unauthenticated) {
            throw err;
          }
          if (err.code === ConnectCode.NotFound) {
            this.log.warn(`[NexusOutbound] conversation not found, skipping: ${err.message}`);
            return;
          }
        }

        if (attempt < SEND_MAX_RETRIES) {
          const delay = SEND_BACKOFF_BASE * 2 ** attempt;
          await sleep(delay);
        }
      }
    }

    throw lastError;
  }

  /**
   * Upload a file with up to UPLOAD_MAX_RETRIES retries.
   * Returns the file_id on success.
   */
  private async uploadWithRetry(fileName: string, contentType: string, data: Uint8Array): Promise<string> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
      try {
        const res = await this.nexusClient.uploadFile(
          create(UploadFileRequestSchema, {
            fileName,
            contentType,
            purpose: MediaPurpose.MESSAGE,
            data,
          }),
        );
        const fileId = res.file?.fileId;
        if (!fileId) {
          throw new Error("UploadFile response missing file_id");
        }
        return fileId;
      } catch (err: unknown) {
        lastError = err;
        if (attempt < UPLOAD_MAX_RETRIES) {
          await sleep(SEND_BACKOFF_BASE);
        }
      }
    }

    throw lastError;
  }

  // -----------------------------------------------------------------------
  // Internal utilities
  // -----------------------------------------------------------------------

  /**
   * Fetch a URL and return its content as a Uint8Array.
   */
  private async fetchAsUint8Array(url: string): Promise<Uint8Array> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch media: ${res.status} ${res.statusText}`);
    }
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }

  /**
   * Extract a reasonable file name from a URL path.
   */
  private fileNameFromUrl(url: string): string {
    try {
      const pathname = new URL(url).pathname;
      const segments = pathname.split("/").filter(Boolean);
      return segments[segments.length - 1] ?? "file";
    } catch {
      return "file";
    }
  }
}
