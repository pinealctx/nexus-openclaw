/**
 * MessageNormalizer converts Nexus WebhookEvent (protojson) into
 * NexusMsgContext objects for OpenClaw consumption.
 */

import { fromJson, create } from "@bufbuild/protobuf";

import type { NexusClient } from "../nexus-api/client.js";
import {
  MessageType,
  MessageEntityType,
  WebhookEventSchema,
  WebhookEventType,
  GetDownloadURLRequestSchema,
} from "../nexus-api/index.js";
import type { WebhookEvent } from "../generated/shared/v1/webhook_events_pb.js";
import type { MessageEnvelope, MessageEntity } from "../generated/shared/v1/message_pb.js";
import type { MediaType, NexusMsgContext } from "../types.js";
import { buildSessionKey } from "../utils/session-key.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Map Nexus MessageType enum to MediaType. */
const MEDIA_TYPE_MAP: Partial<Record<MessageType, MediaType>> = {
  [MessageType.IMAGE]: "image",
  [MessageType.AUDIO]: "audio",
  [MessageType.VIDEO]: "video",
  [MessageType.FILE]: "file",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if any mention entity references the given agentUserId.
 */
function hasSelfMention(
  entities: readonly MessageEntity[] | undefined,
  agentUserId: number,
): boolean {
  if (!entities) return false;
  return entities.some(
    (e) =>
      e.type === MessageEntityType.MENTION &&
      e.data.case === "mention" &&
      e.data.value.userId === agentUserId,
  );
}

// ---------------------------------------------------------------------------
// MessageNormalizer
// ---------------------------------------------------------------------------

export class MessageNormalizer {
  constructor(private readonly nexusClient: NexusClient) {}

  /**
   * Convert a Nexus WebhookEvent (protojson) into a NexusMsgContext.
   * Returns null for events that should be discarded (e.g. RECALLED).
   */
  async normalize(
    event: unknown,
    agentUserId: number,
  ): Promise<NexusMsgContext | null> {
    let ev: WebhookEvent;
    try {
      ev = fromJson(WebhookEventSchema, event as Parameters<typeof fromJson<typeof WebhookEventSchema>>[1]);
    } catch {
      return null;
    }

    switch (ev.eventType) {
      case WebhookEventType.MESSAGE:
        return this.normalizeMessage(ev, agentUserId);
      case WebhookEventType.CARD_ACTION:
        return this.normalizeCardAction(ev, agentUserId);
      case WebhookEventType.CONTACT_ADDED:
        return this.normalizeContactAdded(ev, agentUserId);
      case WebhookEventType.REMOVED_FROM_GROUP:
        return this.normalizeRemovedFromGroup(ev, agentUserId);
      case WebhookEventType.GROUP_DISSOLVED:
        return this.normalizeGroupDissolved(ev, agentUserId);
      default:
        return null;
    }
  }

  // -------------------------------------------------------------------------
  // MESSAGE event
  // -------------------------------------------------------------------------

  private async normalizeMessage(
    ev: WebhookEvent,
    agentUserId: number,
  ): Promise<NexusMsgContext | null> {
    if (ev.payload.case !== "messageEvent") return null;
    const msg = ev.payload.value.message;
    if (!msg?.body) return null;

    const bodyType = msg.body.type;

    // Discard recalled messages.
    if (bodyType === MessageType.RECALLED) return null;

    // GROUP body type → system notification.
    if (bodyType === MessageType.GROUP) {
      return this.buildSystemNotification(ev, msg, agentUserId, "group_event");
    }

    // STREAM: only process END phase.
    if (bodyType === MessageType.STREAM) {
      const content = msg.body.content;
      if (content.case !== "stream" || content.value.phase !== 3 /* StreamPhase.END */) return null;
    }

    const conversationId = Number(msg.conversationId);
    const senderId = msg.senderId;
    const senderInfo = ev.relatedUsers.find((u) => u.userId === senderId);

    const ctx: NexusMsgContext = {
      sessionKey: buildSessionKey(agentUserId, conversationId),
      chatType: this.resolveChatType(msg, ev),
      sender: {
        id: String(senderId),
        name: senderInfo?.nickname ?? "",
        avatarUrl: senderInfo?.avatarUrl || undefined,
      },
      nexusMessageType: MessageType[bodyType] ?? "UNKNOWN",
      mentionedSelf: false,
      rawEvent: ev,
    };

    // Populate group field for GROUP conversations.
    if (ctx.chatType === "group") {
      this.populateGroup(ctx, ev.relatedGroups, conversationId);
    }

    // Extract reply_to context.
    if (msg.replyTo) {
      ctx.replyTo = {
        messageId: Number(msg.replyTo.messageId),
        senderId: msg.replyTo.senderId,
        contentPreview: msg.replyTo.contentPreview,
      };
    }

    // Dispatch by body content oneof.
    const content = msg.body.content;
    switch (content.case) {
      case "text":
        ctx.text = content.value.text;
        ctx.mentionedSelf = hasSelfMention(content.value.entities, agentUserId);
        break;

      case "markdown":
        ctx.text = content.value.rawMarkdown;
        ctx.nexusMessageType = "MARKDOWN";
        ctx.mentionedSelf = hasSelfMention(content.value.entities, agentUserId);
        break;

      case "stream":
        ctx.text = content.value.accumulatedText;
        break;

      case "image":
      case "audio":
      case "video":
      case "file": {
        const fileId = content.value.fileId;
        if (fileId) {
          const mediaType = MEDIA_TYPE_MAP[bodyType];
          if (mediaType) {
            const { url } = await this.nexusClient.getDownloadUrl(
              create(GetDownloadURLRequestSchema, { fileId }),
            );
            ctx.media = [{ type: mediaType, url }];
          }
        }
        break;
      }

      default:
        // Unknown body type — pass through with no text/media.
        break;
    }

    return ctx;
  }

  // -------------------------------------------------------------------------
  // CARD_ACTION event
  // -------------------------------------------------------------------------

  private normalizeCardAction(
    ev: WebhookEvent,
    agentUserId: number,
  ): NexusMsgContext | null {
    if (ev.payload.case !== "cardAction") return null;
    const ca = ev.payload.value;
    const conversationId = Number(ca.conversationId);
    const senderId = ca.senderId;
    const senderInfo = ev.relatedUsers.find((u) => u.userId === senderId);

    return {
      sessionKey: buildSessionKey(agentUserId, conversationId),
      chatType: "dm",
      sender: {
        id: String(senderId),
        name: senderInfo?.nickname ?? "",
        avatarUrl: senderInfo?.avatarUrl || undefined,
      },
      nexusMessageType: "CARD_ACTION",
      cardAction: {
        actionId: ca.id,
        actionData: ca.actionData,
        verb: ca.verb,
        messageId: Number(ca.messageId),
      },
      mentionedSelf: false,
      rawEvent: ev,
    };
  }

  // -------------------------------------------------------------------------
  // CONTACT_ADDED event
  // -------------------------------------------------------------------------

  private normalizeContactAdded(
    ev: WebhookEvent,
    agentUserId: number,
  ): NexusMsgContext | null {
    if (ev.payload.case !== "contactAdded") return null;
    const payload = ev.payload.value;
    const userId = payload.userId;
    const userInfo = ev.relatedUsers.find((u) => u.userId === userId);

    return {
      sessionKey: buildSessionKey(agentUserId, 0),
      chatType: "dm",
      sender: {
        id: String(userId),
        name: userInfo?.nickname ?? "",
        avatarUrl: userInfo?.avatarUrl || undefined,
      },
      nexusMessageType: "CONTACT_ADDED",
      text: "contact_added",
      mentionedSelf: false,
      rawEvent: ev,
    };
  }

  // -------------------------------------------------------------------------
  // REMOVED_FROM_GROUP event
  // -------------------------------------------------------------------------

  private normalizeRemovedFromGroup(
    ev: WebhookEvent,
    agentUserId: number,
  ): NexusMsgContext | null {
    if (ev.payload.case !== "removedFromGroup") return null;
    const payload = ev.payload.value;
    const groupId = payload.groupId;
    const operatorId = payload.operatorId;
    const operatorInfo = ev.relatedUsers.find((u) => u.userId === operatorId);
    const groupInfo = ev.relatedGroups.find((g) => g.groupId === groupId);

    return {
      sessionKey: buildSessionKey(agentUserId, groupId),
      chatType: "group",
      sender: {
        id: String(operatorId),
        name: operatorInfo?.nickname ?? "",
        avatarUrl: operatorInfo?.avatarUrl || undefined,
      },
      nexusMessageType: "REMOVED_FROM_GROUP",
      text: "removed_from_group",
      group: {
        id: groupId,
        name: groupInfo?.name ?? "",
      },
      mentionedSelf: false,
      rawEvent: ev,
    };
  }

  // -------------------------------------------------------------------------
  // GROUP_DISSOLVED event
  // -------------------------------------------------------------------------

  private normalizeGroupDissolved(
    ev: WebhookEvent,
    agentUserId: number,
  ): NexusMsgContext | null {
    if (ev.payload.case !== "groupDissolved") return null;
    const payload = ev.payload.value;
    const groupId = payload.groupId;
    const operatorId = payload.operatorId;
    const operatorInfo = ev.relatedUsers.find((u) => u.userId === operatorId);
    const groupInfo = ev.relatedGroups.find((g) => g.groupId === groupId);

    return {
      sessionKey: buildSessionKey(agentUserId, groupId),
      chatType: "group",
      sender: {
        id: String(operatorId),
        name: operatorInfo?.nickname ?? "",
        avatarUrl: operatorInfo?.avatarUrl || undefined,
      },
      nexusMessageType: "GROUP_DISSOLVED",
      text: "group_dissolved",
      group: {
        id: groupId,
        name: groupInfo?.name ?? "",
      },
      mentionedSelf: false,
      rawEvent: ev,
    };
  }

  // -------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------

  private resolveChatType(
    msg: MessageEnvelope,
    ev: WebhookEvent,
  ): "dm" | "group" {
    const conversationId = Number(msg.conversationId);
    const isGroup = ev.relatedGroups.some((g) => g.groupId === conversationId);
    return isGroup ? "group" : "dm";
  }

  private populateGroup(
    ctx: NexusMsgContext,
    relatedGroups: { groupId: number; name: string }[],
    conversationId: number,
  ): void {
    const groupInfo = relatedGroups.find((g) => g.groupId === conversationId);
    ctx.group = {
      id: conversationId,
      name: groupInfo?.name ?? "",
    };
  }

  /**
   * Build a system notification MsgContext for group events delivered
   * as MESSAGE with GROUP body type.
   */
  private buildSystemNotification(
    ev: WebhookEvent,
    msg: MessageEnvelope,
    agentUserId: number,
    notificationType: string,
  ): NexusMsgContext {
    const conversationId = Number(msg.conversationId);
    const senderId = msg.senderId;
    const senderInfo = ev.relatedUsers.find((u) => u.userId === senderId);

    const ctx: NexusMsgContext = {
      sessionKey: buildSessionKey(agentUserId, conversationId),
      chatType: "group",
      sender: {
        id: String(senderId),
        name: senderInfo?.nickname ?? "",
        avatarUrl: senderInfo?.avatarUrl || undefined,
      },
      nexusMessageType: notificationType,
      text: notificationType,
      mentionedSelf: false,
      rawEvent: ev,
    };

    this.populateGroup(ctx, ev.relatedGroups, conversationId);
    return ctx;
  }
}
