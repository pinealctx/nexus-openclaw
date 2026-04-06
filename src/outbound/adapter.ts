/**
 * Outbound adapter for sending messages to Nexus AI.
 *
 * Handles text/markdown, media, and Adaptive Card messages with
 * retry logic and error classification.
 */

import type { NexusClient, NexusRpcError } from "../nexus-api/client.js";
import type { OutboundTarget, SendOptions, MediaType } from "../types.js";
import { isMarkdown } from "../utils/markdown-detect.js";
import { generateClientMessageId } from "../utils/id-gen.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MESSAGE_TYPE_TEXT = "MESSAGE_TYPE_TEXT";
const MESSAGE_TYPE_MARKDOWN = "MESSAGE_TYPE_MARKDOWN";
const MESSAGE_TYPE_CARD = "MESSAGE_TYPE_CARD";

/** Max retries for sendMessage calls. */
const SEND_MAX_RETRIES = 2;
/** Base delay (ms) for exponential backoff. */
const SEND_BACKOFF_BASE = 500;

/** Max retries for uploadFile calls. */
const UPLOAD_MAX_RETRIES = 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNexusRpcError(err: unknown): err is NexusRpcError {
  return err instanceof Error && err.name === "NexusRpcError";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Determine the Nexus message type for outbound text.
 */
function resolveTextType(text: string, options?: SendOptions): string {
  if (options?.forceMarkdown || isMarkdown(text)) {
    return MESSAGE_TYPE_MARKDOWN;
  }
  return MESSAGE_TYPE_TEXT;
}

/**
 * Map a MediaType to the corresponding Nexus message type string.
 */
function mediaTypeToMessageType(type: MediaType): string {
  switch (type) {
    case "image":
      return "MESSAGE_TYPE_IMAGE";
    case "audio":
      return "MESSAGE_TYPE_AUDIO";
    case "video":
      return "MESSAGE_TYPE_VIDEO";
    case "file":
      return "MESSAGE_TYPE_FILE";
  }
}

/**
 * Map a MediaType to the body field key used by Nexus SendMessage.
 */
function mediaTypeToBodyKey(
  type: MediaType,
): "imageContent" | "audioContent" | "videoContent" | "fileContent" {
  switch (type) {
    case "image":
      return "imageContent";
    case "audio":
      return "audioContent";
    case "video":
      return "videoContent";
    case "file":
      return "fileContent";
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
  constructor(private readonly nexusClient: NexusClient) {}

  // -----------------------------------------------------------------------
  // sendText  (Task 14.1 + 14.2)
  // -----------------------------------------------------------------------

  /**
   * Send a text or markdown message to a Nexus conversation.
   *
   * Markdown is auto-detected unless `forceMarkdown` is set.
   */
  async sendText(
    target: OutboundTarget,
    text: string,
    options?: SendOptions,
  ): Promise<void> {
    const msgType = resolveTextType(text, options);
    const clientMessageId = generateClientMessageId().toString();

    const body =
      msgType === MESSAGE_TYPE_MARKDOWN
        ? { type: msgType, markdownContent: { rawMarkdown: text } }
        : { type: msgType, textContent: { text } };

    await this.sendMessageWithRetry({
      clientMessageId,
      conversationId: String(target.conversationId),
      body,
      ...(target.replyToMessageId !== undefined && {
        replyToMessageId: String(target.replyToMessageId),
      }),
    });
  }

  // -----------------------------------------------------------------------
  // sendMedia  (Task 15.1)
  // -----------------------------------------------------------------------

  /**
   * Upload a media file and send it as a media message.
   *
   * On upload failure (after 1 retry) falls back to a text message
   * containing the URL as a link.
   */
  async sendMedia(
    target: OutboundTarget,
    media: { url: string; type: MediaType; fileName?: string },
  ): Promise<void> {
    const fileName = media.fileName ?? this.fileNameFromUrl(media.url);
    const contentType = mediaTypeToContentType(media.type);

    let fileId: string | undefined;
    try {
      const data = await this.fetchAsBase64(media.url);
      fileId = await this.uploadWithRetry(fileName, contentType, data);
    } catch {
      // Upload failed — fall back to text link.
      console.warn(
        `[NexusOutbound] media upload failed for ${media.url}, falling back to text link`,
      );
    }

    if (fileId) {
      const bodyKey = mediaTypeToBodyKey(media.type);
      const msgType = mediaTypeToMessageType(media.type);
      const clientMessageId = generateClientMessageId().toString();

      await this.sendMessageWithRetry({
        clientMessageId,
        conversationId: String(target.conversationId),
        body: {
          type: msgType,
          [bodyKey]: { fileId },
        },
        ...(target.replyToMessageId !== undefined && {
          replyToMessageId: String(target.replyToMessageId),
        }),
      });
    } else {
      // Fallback: send URL as a text link.
      await this.sendText(target, `[${fileName}](${media.url})`);
    }
  }

  // -----------------------------------------------------------------------
  // sendCard  (Task 18.1)
  // -----------------------------------------------------------------------

  /**
   * Send an Adaptive Card message.
   */
  async sendCard(
    target: OutboundTarget,
    cardJson: string,
  ): Promise<void> {
    const clientMessageId = generateClientMessageId().toString();

    await this.sendMessageWithRetry({
      clientMessageId,
      conversationId: String(target.conversationId),
      body: {
        type: MESSAGE_TYPE_CARD,
        cardContent: { cardJson },
      },
      ...(target.replyToMessageId !== undefined && {
        replyToMessageId: String(target.replyToMessageId),
      }),
    });
  }

  // -----------------------------------------------------------------------
  // answerCardAction  (Task 18.2)
  // -----------------------------------------------------------------------

  /**
   * Respond to a card action callback.
   */
  async answerCardAction(
    actionId: string,
    text?: string,
    showAlert?: boolean,
  ): Promise<void> {
    await this.nexusClient.answerCardAction({
      actionId,
      text,
      showAlert: showAlert ?? false,
    });
  }

  // -----------------------------------------------------------------------
  // editCard  (Task 18.3)
  // -----------------------------------------------------------------------

  /**
   * Update an existing card message with new JSON content.
   */
  async editCard(
    conversationId: number,
    messageId: number,
    cardJson: string,
  ): Promise<void> {
    await this.nexusClient.editMessage({
      conversationId: String(conversationId),
      messageId: String(messageId),
      newBody: {
        type: MESSAGE_TYPE_CARD,
        cardContent: { cardJson },
      },
    });
  }

  // -----------------------------------------------------------------------
  // Retry helpers  (Task 14.2)
  // -----------------------------------------------------------------------

  /**
   * Send a message with retry logic.
   *
   * - UNAUTHENTICATED: throw immediately (no retry).
   * - NOT_FOUND: log and skip (no retry).
   * - Other errors: retry up to SEND_MAX_RETRIES with exponential backoff.
   */
  private async sendMessageWithRetry(
    req: Parameters<NexusClient["sendMessage"]>[0],
  ): Promise<void> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= SEND_MAX_RETRIES; attempt++) {
      try {
        await this.nexusClient.sendMessage(req);
        return;
      } catch (err: unknown) {
        lastError = err;

        if (isNexusRpcError(err)) {
          if (err.code === "UNAUTHENTICATED") {
            throw err;
          }
          if (err.code === "NOT_FOUND") {
            console.warn(
              `[NexusOutbound] conversation not found, skipping: ${err.message}`,
            );
            return;
          }
        }

        if (attempt < SEND_MAX_RETRIES) {
          const delay = SEND_BACKOFF_BASE * Math.pow(2, attempt);
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
  private async uploadWithRetry(
    fileName: string,
    contentType: string,
    data: string,
  ): Promise<string> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
      try {
        const res = await this.nexusClient.uploadFile({
          fileName,
          contentType,
          purpose: "message_attachment",
          data,
        });
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
   * Fetch a URL and return its content as a base64-encoded string.
   */
  private async fetchAsBase64(url: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch media: ${res.status} ${res.statusText}`);
    }
    const buf = await res.arrayBuffer();
    return Buffer.from(buf).toString("base64");
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
