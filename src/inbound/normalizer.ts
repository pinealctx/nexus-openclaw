/**
 * MessageNormalizer converts Nexus WebhookEvent (protojson) into
 * NexusMsgContext objects for OpenClaw consumption.
 */

import type { NexusClient } from "../nexus-api/client.js";
import type { MediaType, NexusMsgContext } from "../types.js";
import { buildSessionKey } from "../utils/session-key.js";

// ---------------------------------------------------------------------------
// Protojson shape types (camelCase, matching Nexus WebhookEvent JSON)
// ---------------------------------------------------------------------------

interface UserInfoJSON {
  userId?: number;
  nickname?: string;
  avatarUrl?: string;
}

interface GroupInfoJSON {
  groupId?: number;
  name?: string;
}

interface MentionEntityJSON {
  userId?: number;
  isAll?: boolean;
}

interface MessageEntityJSON {
  type?: string;
  offset?: number;
  length?: number;
  mention?: MentionEntityJSON;
}

interface ReplyContextJSON {
  messageId?: string | number;
  senderId?: number;
  contentPreview?: string;
}

interface MessageBodyJSON {
  type?: string;
  text?: { text?: string; entities?: MessageEntityJSON[] };
  image?: { fileId?: string };
  audio?: { fileId?: string };
  video?: { fileId?: string };
  file?: { fileId?: string };
  markdown?: { rawMarkdown?: string; entities?: MessageEntityJSON[] };
  stream?: { phase?: string; accumulatedText?: string };
  group?: unknown;
  recalled?: unknown;
}

interface MessageEnvelopeJSON {
  messageId?: string | number;
  conversationId?: string | number;
  senderId?: number;
  body?: MessageBodyJSON;
  replyTo?: ReplyContextJSON;
  conversationType?: string;
}

interface MessageEventPayloadJSON {
  message?: MessageEnvelopeJSON;
}

interface CardActionPayloadJSON {
  id?: string;
  senderId?: number;
  conversationId?: string | number;
  messageId?: string | number;
  actionData?: string;
  verb?: string;
}

interface ContactAddedPayloadJSON {
  userId?: number;
}

interface RemovedFromGroupPayloadJSON {
  groupId?: number;
  operatorId?: number;
}

interface GroupDissolvedPayloadJSON {
  groupId?: number;
  operatorId?: number;
}

interface WebhookEventJSON {
  eventType?: string;
  timestamp?: string | number;
  relatedUsers?: UserInfoJSON[];
  relatedGroups?: GroupInfoJSON[];
  messageEvent?: MessageEventPayloadJSON;
  cardAction?: CardActionPayloadJSON;
  contactAdded?: ContactAddedPayloadJSON;
  removedFromGroup?: RemovedFromGroupPayloadJSON;
  groupDissolved?: GroupDissolvedPayloadJSON;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EVENT_TYPE_MESSAGE = "WEBHOOK_EVENT_TYPE_MESSAGE";
const EVENT_TYPE_CARD_ACTION = "WEBHOOK_EVENT_TYPE_CARD_ACTION";
const EVENT_TYPE_CONTACT_ADDED = "WEBHOOK_EVENT_TYPE_CONTACT_ADDED";
const EVENT_TYPE_REMOVED_FROM_GROUP = "WEBHOOK_EVENT_TYPE_REMOVED_FROM_GROUP";
const EVENT_TYPE_GROUP_DISSOLVED = "WEBHOOK_EVENT_TYPE_GROUP_DISSOLVED";

const MSG_TYPE_TEXT = "MESSAGE_TYPE_TEXT";
const MSG_TYPE_IMAGE = "MESSAGE_TYPE_IMAGE";
const MSG_TYPE_AUDIO = "MESSAGE_TYPE_AUDIO";
const MSG_TYPE_VIDEO = "MESSAGE_TYPE_VIDEO";
const MSG_TYPE_FILE = "MESSAGE_TYPE_FILE";
const MSG_TYPE_MARKDOWN = "MESSAGE_TYPE_MARKDOWN";
const MSG_TYPE_STREAM = "MESSAGE_TYPE_STREAM";
const MSG_TYPE_GROUP = "MESSAGE_TYPE_GROUP";
const MSG_TYPE_RECALLED = "MESSAGE_TYPE_RECALLED";

const CONV_TYPE_GROUP = "CONVERSATION_TYPE_GROUP";

const STREAM_PHASE_END = "STREAM_PHASE_END";

const ENTITY_TYPE_MENTION = "MESSAGE_ENTITY_TYPE_MENTION";

/** Map Nexus message body type to MediaType. */
const MEDIA_TYPE_MAP: Record<string, MediaType> = {
  [MSG_TYPE_IMAGE]: "image",
  [MSG_TYPE_AUDIO]: "audio",
  [MSG_TYPE_VIDEO]: "video",
  [MSG_TYPE_FILE]: "file",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toNumber(v: string | number | undefined): number {
  if (v === undefined) return 0;
  return typeof v === "string" ? Number(v) : v;
}

function findUser(
  users: UserInfoJSON[] | undefined,
  userId: number,
): UserInfoJSON | undefined {
  return users?.find((u) => u.userId === userId);
}

function findGroup(
  groups: GroupInfoJSON[] | undefined,
  groupId: number,
): GroupInfoJSON | undefined {
  return groups?.find((g) => g.groupId === groupId);
}

/**
 * Extract the fileId from a media content field.
 * Handles image, audio, video, and file content shapes.
 */
function extractFileId(body: MessageBodyJSON): string | undefined {
  return (
    body.image?.fileId ??
    body.audio?.fileId ??
    body.video?.fileId ??
    body.file?.fileId
  );
}

/**
 * Check if any mention entity references the given agentUserId.
 */
function hasSelfMention(
  entities: MessageEntityJSON[] | undefined,
  agentUserId: number,
): boolean {
  if (!entities) return false;
  return entities.some(
    (e) =>
      e.type === ENTITY_TYPE_MENTION && e.mention?.userId === agentUserId,
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
    const ev = event as WebhookEventJSON;

    switch (ev.eventType) {
      case EVENT_TYPE_MESSAGE:
        return this.normalizeMessage(ev, agentUserId);
      case EVENT_TYPE_CARD_ACTION:
        return this.normalizeCardAction(ev, agentUserId);
      case EVENT_TYPE_CONTACT_ADDED:
        return this.normalizeContactAdded(ev, agentUserId);
      case EVENT_TYPE_REMOVED_FROM_GROUP:
        return this.normalizeRemovedFromGroup(ev, agentUserId);
      case EVENT_TYPE_GROUP_DISSOLVED:
        return this.normalizeGroupDissolved(ev, agentUserId);
      default:
        return null;
    }
  }

  // -------------------------------------------------------------------------
  // MESSAGE event
  // -------------------------------------------------------------------------

  private async normalizeMessage(
    ev: WebhookEventJSON,
    agentUserId: number,
  ): Promise<NexusMsgContext | null> {
    const msg = ev.messageEvent?.message;
    if (!msg?.body) return null;

    const bodyType = msg.body.type;

    // Discard recalled messages.
    if (bodyType === MSG_TYPE_RECALLED) return null;

    // GROUP body type → system notification.
    if (bodyType === MSG_TYPE_GROUP) {
      return this.buildSystemNotification(ev, msg, agentUserId, "group_event");
    }

    // STREAM: only process END phase.
    if (bodyType === MSG_TYPE_STREAM) {
      if (msg.body.stream?.phase !== STREAM_PHASE_END) return null;
    }

    const conversationId = toNumber(msg.conversationId);
    const senderId = msg.senderId ?? 0;
    const senderInfo = findUser(ev.relatedUsers, senderId);

    const ctx: NexusMsgContext = {
      sessionKey: buildSessionKey(agentUserId, conversationId),
      chatType: this.resolveChatType(msg),
      sender: {
        id: String(senderId),
        name: senderInfo?.nickname ?? "",
        avatarUrl: senderInfo?.avatarUrl,
      },
      nexusMessageType: bodyType,
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
        messageId: toNumber(msg.replyTo.messageId),
        senderId: msg.replyTo.senderId ?? 0,
        contentPreview: msg.replyTo.contentPreview ?? "",
      };
    }

    // Dispatch by body type.
    switch (bodyType) {
      case MSG_TYPE_TEXT:
        ctx.text = msg.body.text?.text ?? "";
        ctx.mentionedSelf = hasSelfMention(
          msg.body.text?.entities,
          agentUserId,
        );
        break;

      case MSG_TYPE_MARKDOWN:
        ctx.text = msg.body.markdown?.rawMarkdown ?? "";
        ctx.nexusMessageType = MSG_TYPE_MARKDOWN;
        ctx.mentionedSelf = hasSelfMention(
          msg.body.markdown?.entities,
          agentUserId,
        );
        break;

      case MSG_TYPE_STREAM:
        ctx.text = msg.body.stream?.accumulatedText ?? "";
        break;

      case MSG_TYPE_IMAGE:
      case MSG_TYPE_AUDIO:
      case MSG_TYPE_VIDEO:
      case MSG_TYPE_FILE: {
        const fileId = extractFileId(msg.body);
        if (fileId) {
          const mediaType = MEDIA_TYPE_MAP[bodyType];
          const { url } = await this.nexusClient.getDownloadUrl({ fileId });
          ctx.media = [{ type: mediaType, url }];
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
    ev: WebhookEventJSON,
    agentUserId: number,
  ): NexusMsgContext | null {
    const ca = ev.cardAction;
    if (!ca) return null;

    const conversationId = toNumber(ca.conversationId);
    const senderId = ca.senderId ?? 0;
    const senderInfo = findUser(ev.relatedUsers, senderId);

    return {
      sessionKey: buildSessionKey(agentUserId, conversationId),
      chatType: "dm",
      sender: {
        id: String(senderId),
        name: senderInfo?.nickname ?? "",
        avatarUrl: senderInfo?.avatarUrl,
      },
      nexusMessageType: "CARD_ACTION",
      cardAction: {
        actionId: ca.id ?? "",
        actionData: ca.actionData ?? "",
        verb: ca.verb ?? "",
        messageId: toNumber(ca.messageId),
      },
      mentionedSelf: false,
      rawEvent: ev,
    };
  }

  // -------------------------------------------------------------------------
  // CONTACT_ADDED event
  // -------------------------------------------------------------------------

  private normalizeContactAdded(
    ev: WebhookEventJSON,
    agentUserId: number,
  ): NexusMsgContext | null {
    const payload = ev.contactAdded;
    if (!payload) return null;

    const userId = payload.userId ?? 0;
    const userInfo = findUser(ev.relatedUsers, userId);

    return {
      sessionKey: buildSessionKey(agentUserId, 0),
      chatType: "dm",
      sender: {
        id: String(userId),
        name: userInfo?.nickname ?? "",
        avatarUrl: userInfo?.avatarUrl,
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
    ev: WebhookEventJSON,
    agentUserId: number,
  ): NexusMsgContext | null {
    const payload = ev.removedFromGroup;
    if (!payload) return null;

    const groupId = payload.groupId ?? 0;
    const operatorId = payload.operatorId ?? 0;
    const operatorInfo = findUser(ev.relatedUsers, operatorId);
    const groupInfo = findGroup(ev.relatedGroups, groupId);

    return {
      sessionKey: buildSessionKey(agentUserId, groupId),
      chatType: "group",
      sender: {
        id: String(operatorId),
        name: operatorInfo?.nickname ?? "",
        avatarUrl: operatorInfo?.avatarUrl,
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
    ev: WebhookEventJSON,
    agentUserId: number,
  ): NexusMsgContext | null {
    const payload = ev.groupDissolved;
    if (!payload) return null;

    const groupId = payload.groupId ?? 0;
    const operatorId = payload.operatorId ?? 0;
    const operatorInfo = findUser(ev.relatedUsers, operatorId);
    const groupInfo = findGroup(ev.relatedGroups, groupId);

    return {
      sessionKey: buildSessionKey(agentUserId, groupId),
      chatType: "group",
      sender: {
        id: String(operatorId),
        name: operatorInfo?.nickname ?? "",
        avatarUrl: operatorInfo?.avatarUrl,
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

  private resolveChatType(msg: MessageEnvelopeJSON): "dm" | "group" {
    return msg.conversationType === CONV_TYPE_GROUP ? "group" : "dm";
  }

  private populateGroup(
    ctx: NexusMsgContext,
    relatedGroups: GroupInfoJSON[] | undefined,
    conversationId: number,
  ): void {
    // In Nexus, group conversation_id equals int64(group_id).
    const groupInfo = findGroup(relatedGroups, conversationId);
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
    ev: WebhookEventJSON,
    msg: MessageEnvelopeJSON,
    agentUserId: number,
    notificationType: string,
  ): NexusMsgContext {
    const conversationId = toNumber(msg.conversationId);
    const senderId = msg.senderId ?? 0;
    const senderInfo = findUser(ev.relatedUsers, senderId);

    const ctx: NexusMsgContext = {
      sessionKey: buildSessionKey(agentUserId, conversationId),
      chatType: "group",
      sender: {
        id: String(senderId),
        name: senderInfo?.nickname ?? "",
        avatarUrl: senderInfo?.avatarUrl,
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
