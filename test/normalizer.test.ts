import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import {
  MarkdownContentSchema,
  MessageBodySchema,
  MessageEnvelopeSchema,
  TextContentSchema,
} from "../src/generated/shared/v1/message_pb.js";
import { MessageNormalizer } from "../src/inbound/normalizer.js";
import type { NexusClient } from "../src/nexus-api/client.js";
import { MessageType, SnUpdateSchema, UpdateSchema } from "../src/nexus-api/index.js";

function createMockClient(): NexusClient {
  return {
    discoverGatewayUrl: vi.fn().mockResolvedValue("wss://gw.test/ws"),
    sendMessage: vi.fn().mockResolvedValue({ messageId: 1n }),
    editMessage: vi.fn().mockResolvedValue({}),
    pushStreamDelta: vi.fn().mockResolvedValue(undefined),
    endStream: vi.fn().mockResolvedValue(undefined),
    errorStream: vi.fn().mockResolvedValue(undefined),
    answerCardAction: vi.fn().mockResolvedValue(undefined),
    uploadFile: vi.fn().mockResolvedValue({ file: { fileId: "f1" } }),
    getDownloadUrl: vi.fn().mockResolvedValue({ url: "https://cdn.test/file" }),
    toString: () => "MockNexusClient",
  } as unknown as NexusClient;
}

function buildTextMessageUpdate(opts: {
  conversationId: bigint;
  senderId: number;
  text: string;
  senderName?: string;
  isGroup?: boolean;
}) {
  const envelope = create(MessageEnvelopeSchema, {
    messageId: 1n,
    conversationId: opts.conversationId,
    senderId: opts.senderId,
    body: create(MessageBodySchema, {
      type: MessageType.TEXT,
      content: {
        case: "text",
        value: create(TextContentSchema, { text: opts.text }),
      },
    }),
    createdAt: BigInt(Date.now()),
  });

  return create(UpdateSchema, {
    users: [{ userId: opts.senderId, nickname: opts.senderName ?? "TestUser" } as any],
    groups: opts.isGroup ? [{ groupId: Number(opts.conversationId), name: "TestGroup" } as any] : [],
    update: {
      case: "snUpdate",
      value: create(SnUpdateSchema, {
        update: {
          case: "messageEnvelope",
          value: envelope,
        },
      }),
    },
  });
}

describe("MessageNormalizer", () => {
  const AGENT_USER_ID = 999;

  it("normalizes a text message from a DM", async () => {
    const client = createMockClient();
    const normalizer = new MessageNormalizer(client);

    const update = buildTextMessageUpdate({
      conversationId: 42n,
      senderId: 10,
      text: "Hello agent!",
    });

    const result = await normalizer.normalize(update, AGENT_USER_ID);

    expect(result).not.toBeNull();
    expect(result!.chatType).toBe("dm");
    expect(result!.text).toBe("Hello agent!");
    expect(result!.sender.id).toBe("10");
    expect(result!.sender.name).toBe("TestUser");
    expect(result!.sessionKey).toBe(`agent:${AGENT_USER_ID}:nexus:42`);
    expect(result!.mentionedSelf).toBe(false);
  });

  it("normalizes a text message from a group", async () => {
    const client = createMockClient();
    const normalizer = new MessageNormalizer(client);

    const update = buildTextMessageUpdate({
      conversationId: 100n,
      senderId: 20,
      text: "Group message",
      isGroup: true,
    });

    const result = await normalizer.normalize(update, AGENT_USER_ID);

    expect(result).not.toBeNull();
    expect(result!.chatType).toBe("group");
    expect(result!.group).toBeDefined();
    expect(result!.group!.id).toBe(100);
    expect(result!.group!.name).toBe("TestGroup");
  });

  it("returns null for empty/invalid updates", async () => {
    const client = createMockClient();
    const normalizer = new MessageNormalizer(client);

    expect(await normalizer.normalize(null, AGENT_USER_ID)).toBeNull();
    expect(await normalizer.normalize(undefined, AGENT_USER_ID)).toBeNull();
    expect(await normalizer.normalize({}, AGENT_USER_ID)).toBeNull();
  });

  it("discards recalled messages", async () => {
    const client = createMockClient();
    const normalizer = new MessageNormalizer(client);

    const envelope = create(MessageEnvelopeSchema, {
      messageId: 1n,
      conversationId: 42n,
      senderId: 10,
      body: create(MessageBodySchema, {
        type: MessageType.RECALLED,
      }),
      createdAt: BigInt(Date.now()),
    });

    const update = create(UpdateSchema, {
      users: [{ userId: 10, nickname: "User" } as any],
      groups: [],
      update: {
        case: "snUpdate",
        value: create(SnUpdateSchema, {
          update: {
            case: "messageEnvelope",
            value: envelope,
          },
        }),
      },
    });

    const result = await normalizer.normalize(update, AGENT_USER_ID);
    expect(result).toBeNull();
  });

  it("normalizes markdown messages", async () => {
    const client = createMockClient();
    const normalizer = new MessageNormalizer(client);

    const envelope = create(MessageEnvelopeSchema, {
      messageId: 1n,
      conversationId: 42n,
      senderId: 10,
      body: create(MessageBodySchema, {
        type: MessageType.MARKDOWN,
        content: {
          case: "markdown",
          value: create(MarkdownContentSchema, { rawMarkdown: "# Title" }),
        },
      }),
      createdAt: BigInt(Date.now()),
    });

    const update = create(UpdateSchema, {
      users: [{ userId: 10, nickname: "User" } as any],
      groups: [],
      update: {
        case: "snUpdate",
        value: create(SnUpdateSchema, {
          update: {
            case: "messageEnvelope",
            value: envelope,
          },
        }),
      },
    });

    const result = await normalizer.normalize(update, AGENT_USER_ID);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("# Title");
    expect(result!.nexusMessageType).toBe("MARKDOWN");
  });
});
