/**
 * Stream adapter for Nexus AI streaming messages.
 *
 * Manages the lifecycle: start → pushDelta × N → end/error.
 * Maintains a per-session seq counter and handles retry with
 * idempotent seq reuse.
 */

import type { NexusClient } from "../nexus-api/client.js";
import type { OutboundTarget, StreamSession } from "../types.js";
import { generateClientMessageId } from "../utils/id-gen.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MESSAGE_TYPE_STREAM = "MESSAGE_TYPE_STREAM";
const STREAM_PHASE_START = "STREAM_PHASE_START";

/** Max retries per pushDelta call. */
const DELTA_MAX_RETRIES = 3;
/** Consecutive failure threshold before calling errorStream. */
const CONSECUTIVE_FAILURE_THRESHOLD = 3;
/** Base delay (ms) for delta retry backoff. */
const DELTA_BACKOFF_BASE = 200;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// NexusStreamAdapter
// ---------------------------------------------------------------------------

export class NexusStreamAdapter {
  /** Track consecutive pushDelta failures per session. */
  private consecutiveFailures = new Map<string, number>();

  constructor(private readonly nexusClient: NexusClient) {}

  // -----------------------------------------------------------------------
  // startStream
  // -----------------------------------------------------------------------

  /**
   * Create a new streaming message and return a StreamSession.
   */
  async startStream(target: OutboundTarget): Promise<StreamSession> {
    const clientMessageId = generateClientMessageId().toString();

    const res = await this.nexusClient.sendMessage({
      clientMessageId,
      conversationId: String(target.conversationId),
      body: {
        type: MESSAGE_TYPE_STREAM,
        streamContent: { phase: STREAM_PHASE_START },
      },
      ...(target.replyToMessageId !== undefined && {
        replyToMessageId: String(target.replyToMessageId),
      }),
    });

    const session: StreamSession = {
      messageId: Number(res.messageId),
      conversationId: target.conversationId,
      seq: 0,
    };

    this.consecutiveFailures.set(this.sessionKey(session), 0);
    return session;
  }

  // -----------------------------------------------------------------------
  // pushDelta
  // -----------------------------------------------------------------------

  /**
   * Push an incremental text delta to the stream.
   *
   * Increments seq, retries with the same seq on failure (idempotent).
   * If consecutive failures exceed the threshold, calls errorStream.
   */
  async pushDelta(session: StreamSession, delta: string): Promise<void> {
    session.seq += 1;
    const seq = session.seq;
    const key = this.sessionKey(session);

    for (let attempt = 0; attempt < DELTA_MAX_RETRIES; attempt++) {
      try {
        await this.nexusClient.pushStreamDelta({
          conversationId: String(session.conversationId),
          messageId: String(session.messageId),
          seq,
          delta,
        });
        // Reset consecutive failure counter on success.
        this.consecutiveFailures.set(key, 0);
        return;
      } catch (err: unknown) {
        const failures = (this.consecutiveFailures.get(key) ?? 0) + 1;
        this.consecutiveFailures.set(key, failures);

        if (failures >= CONSECUTIVE_FAILURE_THRESHOLD) {
          console.error(
            `[NexusStream] consecutive failures (${failures}) exceeded threshold, terminating stream`,
          );
          await this.errorStream(
            session,
            "Stream terminated due to consecutive push failures",
          );
          return;
        }

        if (attempt < DELTA_MAX_RETRIES - 1) {
          await sleep(DELTA_BACKOFF_BASE * Math.pow(2, attempt));
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // endStream
  // -----------------------------------------------------------------------

  /**
   * Finalize the stream with the full accumulated text.
   */
  async endStream(session: StreamSession, fullText: string): Promise<void> {
    await this.nexusClient.endStream({
      conversationId: String(session.conversationId),
      messageId: String(session.messageId),
      accumulatedText: fullText,
    });
    this.consecutiveFailures.delete(this.sessionKey(session));
  }

  // -----------------------------------------------------------------------
  // errorStream
  // -----------------------------------------------------------------------

  /**
   * Terminate the stream with an error message.
   */
  async errorStream(session: StreamSession, error: string): Promise<void> {
    await this.nexusClient.errorStream({
      conversationId: String(session.conversationId),
      messageId: String(session.messageId),
      errorMessage: error,
    });
    this.consecutiveFailures.delete(this.sessionKey(session));
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private sessionKey(session: StreamSession): string {
    return `${session.conversationId}:${session.messageId}`;
  }
}
