/**
 * MessageNormalizer converts Nexus Update objects into
 * NexusMsgContext objects for OpenClaw consumption.
 */

import { create } from "@bufbuild/protobuf";
import type { Update } from "../generated/api/v1/gateway_frame_pb.js";
import type { MessageEntity, MessageEnvelope } from "../generated/shared/v1/message_pb.js";
import type { NexusClient } from "../nexus-api/client.js";
import { GetDownloadURLRequestSchema, MessageEntityType, MessageType } from "../nexus-api/index.js";
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
function hasSelfMention(entities: readonly MessageEntity[] | undefined, agentUserId: number): boolean {
  if (!entities) return false;
  return entities.some(
    (e) => e.type === MessageEntityType.MENTION && e.data.case === "mention" && e.data.value.userId === agentUserId,
  );
}

// ---------------------------------------------------------------------------
// MessageNormalizer
// ---------------------------------------------------------------------------

export class MessageNormalizer {
  constructor(private readonly nexusClient: NexusClient) {}

  /**
   * Convert a Nexus Update into a NexusMsgContext.
   * The event is an Update object emitted by ws-connector (already deserialized).
   * Returns null for updates that should be discarded (e.g. RECALLED).
   */
  async normalize(event: unknown, agentUserId: number): Promise<NexusMsgContext | null> {
    const update = event as Update;
    if (!update?.update) {
      return null;
    }

    switch (update.update.case) {
      case "snUpdate": {
        const sn = update.update.value;
        switch (sn.update.case) {
          case "messageEnvelope":
            return this.normalizeMessage(update, agentUserId);
          case "contactAdded":
            return this.normalizeContactAdded(update, agentUserId);
          case "removedFromGroup":
            return this.normalizeRemovedFromGroup(update, agentUserId);
          case "groupDissolved":
            return this.normalizeGroupDissolved(update, agentUserId);
          default:
            return null;
        }
      }
      case "nonSnUpdate": {
        const nonSn = update.update.value;
        switch (nonSn.update.case) {
          case "cardAction":
            return this.normalizeCardAction(update, agentUserId);
          default:
            return null;
        }
      }
      default:
        return null;
    }
  }

  // -------------------------------------------------------------------------
  // MESSAGE event (SnUpdate.messageEnvelope)
  // -------------------------------------------------------------------------

  private async normalizeMessage(update: Update, agentUserId: number): Promise<NexusMsgContext | null> {
    if (update.update.case !== "snUpdate") return null;
    const sn = update.update.value;
    if (sn.update.case !== "messageEnvelope") return null;
    const msg = sn.update.value;
    if (!msg?.body) return null;

    const bodyType = msg.body.type;

    // Discard recalled messages.
    if (bodyType === MessageType.RECALLED) return null;

    // GROUP body type → system notification.
    if (bodyType === MessageType.GROUP) {
      return this.buildSystemNotification(update, msg, agentUserId, "group_event");
    }

    // STREAM: only process END phase.
    if (bodyType === MessageType.STREAM) {
      const content = msg.body.content;
      if (content.case !== "stream" || content.value.phase !== 3 /* StreamPhase.END */) return null;
    }

    const conversationId = Number(msg.conversationId);
    const senderId = msg.senderId;
    const senderInfo = update.users.find((u) => u.userId === senderId);

    const ctx: NexusMsgContext = {
      sessionKey: buildSessionKey(agentUserId, conversationId),
      chatType: this.resolveChatType(msg, update),
      sender: {
        id: String(senderId),
        name: senderInfo?.nickname ?? "",
        avatarUrl: senderInfo?.avatarUrl || undefined,
      },
      nexusMessageType: MessageType[bodyType] ?? "UNKNOWN",
      mentionedSelf: false,
      rawEvent: update,
    };

    // Populate group field for GROUP conversations.
    if (ctx.chatType === "group") {
      this.populateGroup(ctx, update.groups, conversationId);
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
          const mediaType = MEDIA_TYPE_MAP[bodyType as MessageType];
          if (mediaType) {
            const { url } = await this.nexusClient.getDownloadUrl(create(GetDownloadURLRequestSchema, { fileId }));
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
  // CARD_ACTION event (NonSnUpdate.cardAction)
  // -------------------------------------------------------------------------

  private normalizeCardAction(update: Update, agentUserId: number): NexusMsgContext | null {
    if (update.update.case !== "nonSnUpdate") return null;
    const nonSn = update.update.value;
    if (nonSn.update.case !== "cardAction") return null;
    const ca = nonSn.update.value;
    const conversationId = Number(ca.conversationId);
    const senderId = ca.senderId;
    const senderInfo = update.users.find((u) => u.userId === senderId);

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
        actionId: ca.actionId,
        actionData: ca.actionData,
        verb: ca.verb,
        messageId: Number(ca.messageId),
      },
      mentionedSelf: false,
      rawEvent: update,
    };
  }

  // -------------------------------------------------------------------------
  // CONTACT_ADDED event (SnUpdate.contactAdded)
  // -------------------------------------------------------------------------

  private normalizeContactAdded(update: Update, agentUserId: number): NexusMsgContext | null {
    if (update.update.case !== "snUpdate") return null;
    const sn = update.update.value;
    if (sn.update.case !== "contactAdded") return null;
    const payload = sn.update.value;
    const userId = payload.peerUserId;
    const userInfo = update.users.find((u) => u.userId === userId);

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
      rawEvent: update,
    };
  }

  // -------------------------------------------------------------------------
  // REMOVED_FROM_GROUP event (SnUpdate.removedFromGroup)
  // -------------------------------------------------------------------------

  private normalizeRemovedFromGroup(update: Update, agentUserId: number): NexusMsgContext | null {
    if (update.update.case !== "snUpdate") return null;
    const sn = update.update.value;
    if (sn.update.case !== "removedFromGroup") return null;
    const payload = sn.update.value;
    const groupId = payload.groupId;
    const operatorId = payload.operatorId;
    const operatorInfo = update.users.find((u) => u.userId === operatorId);
    const groupInfo = update.groups.find((g) => g.groupId === groupId);

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
      rawEvent: update,
    };
  }

  // -------------------------------------------------------------------------
  // GROUP_DISSOLVED event (SnUpdate.groupDissolved)
  // -------------------------------------------------------------------------

  private normalizeGroupDissolved(update: Update, agentUserId: number): NexusMsgContext | null {
    if (update.update.case !== "snUpdate") return null;
    const sn = update.update.value;
    if (sn.update.case !== "groupDissolved") return null;
    const payload = sn.update.value;
    const groupId = payload.groupId;
    const operatorId = payload.operatorId;
    const operatorInfo = update.users.find((u) => u.userId === operatorId);
    const groupInfo = update.groups.find((g) => g.groupId === groupId);

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
      rawEvent: update,
    };
  }

  // -------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------

  /**
   * Determine whether a message is from a group or DM conversation.
   *
   * Primary signal: the Update.groups array contains a GroupInfo whose
   * groupId matches the conversation. This is populated by the server
   * for all group-originated updates.
   *
   * Fallback: if sender_id is 0 (system/group event messages), treat
   * as group since DMs always have a real sender.
   */
  private resolveChatType(msg: MessageEnvelope, update: Update): "dm" | "group" {
    const conversationId = Number(msg.conversationId);
    if (update.groups.some((g) => g.groupId === conversationId)) {
      return "group";
    }
    // sender_id 0 is used for group system messages (member join/leave, etc.)
    if (msg.senderId === 0) {
      return "group";
    }
    return "dm";
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
    update: Update,
    msg: MessageEnvelope,
    agentUserId: number,
    notificationType: string,
  ): NexusMsgContext {
    const conversationId = Number(msg.conversationId);
    const senderId = msg.senderId;
    const senderInfo = update.users.find((u) => u.userId === senderId);

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
      rawEvent: update,
    };

    this.populateGroup(ctx, update.groups, conversationId);
    return ctx;
  }
}
