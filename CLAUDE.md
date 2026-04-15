# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenClaw channel plugin enabling OpenClaw LLM agents to operate as Nexus AI agents. Supports text, Markdown, streaming, media upload, and Adaptive Cards across private (DM) and group conversations. MIT licensed.

## Commands

```bash
pnpm install         # Install dependencies
pnpm generate        # Generate TypeScript from protobuf (buf + protoc-gen-es)
pnpm test            # Run tests once (vitest --run)
pnpm test:watch      # Run tests in watch mode
pnpm build           # Compile TypeScript (tsc)
pnpm lint            # biome check + tsc --noEmit
pnpm lint:fix        # biome check --write
pnpm format          # biome format --write
```

**Prerequisites for `pnpm generate`**: `buf` CLI and `protoc-gen-es` must be installed. Proto definitions are in `nexus-proto/proto/`.

Linting via Biome (`@biomejs/biome`) + `tsc --noEmit`.

## Architecture

### Protobuf Code Generation

All Nexus protocol types are generated from protobuf definitions (`nexus-proto/proto/`) using `buf` + `protoc-gen-es` (v2). Generated code lives in `src/generated/` and is committed to the repository.

- **Toolchain**: `@bufbuild/protobuf` v2 + `@connectrpc/connect-web` v2 + `@connectrpc/connect` v2
- **Config**: `buf.gen.ts.yaml` — generates `src/generated/` from `nexus-proto/proto/{shared,api}`
- **Transport**: Connect RPC over HTTP POST/JSON (`createConnectTransport` + `createClient`)
- **WS frames**: Binary protobuf (`toBinary`/`fromBinary` on `AgentClientFrame`/`AgentServerFrame`)
- **Webhook inbound**: `fromJson(WebhookEventSchema, rawJson)` for protojson parsing
- **int64 boundary**: Generated types use `bigint` for int64 fields. `toNum()`/`toBid()`/`toBidOpt()` convert at plugin boundaries.
- **oneof access**: Discriminated union pattern (`body.content.case === "text"` with `body.content.value`)
- **Message construction**: `create(Schema, { ... })` from `@bufbuild/protobuf`
- **Errors**: `ConnectError` from `@connectrpc/connect` with `Code` enum

### Plugin System

Two entry points exported:
1. **Default** (`./dist/index.js`): `register()` function that OpenClaw calls to initialize the plugin.
2. **Dock** (`./dist/dock.js`): Lightweight metadata (capabilities, labels) without heavy dependencies.

`openclaw.plugin.json` at project root tells OpenClaw where to find both.

### Data Flow

```
Nexus Server
     │
     ▼
GatewayManager ──► WebSocketConnector (default) or WebhookServer (fallback)
     │
     ▼
MessageNormalizer (inbound): converts Nexus WebhookEvent (protojson) → NexusMsgContext
  Handles: MESSAGE, CARD_ACTION, CONTACT_ADDED, REMOVED_FROM_GROUP, GROUP_DISSOLVED
     │
     ▼
OpenClaw dispatch (accountId + msgCtx)
     │
     ▼
NexusOutboundAdapter / NexusStreamAdapter (outbound)
  sendText, sendMedia, sendCard, answerCardAction, editCard
  startStream → pushDelta × N → endStream / errorStream
     │
     ▼
NexusClient (Connect RPC typed clients via generated service descriptors)
  Services: AuthService, MessageService, MediaService, AgentService
```

### Per-Account Runtime

Each configured account gets its own: NexusAccountConfig, NexusClient, MessageNormalizer, NexusOutboundAdapter, NexusStreamAdapter. A single GatewayManager manages delivery connectors across all accounts.

### Gateway Modes

1. **WebSocket** (default): Binary protobuf frames to `/ws/agent` (`AgentClientFrame`/`AgentServerFrame`). Auth via `AUTH_REQUEST`, heartbeat keepalive with `HEARTBEAT_PING`/`HEARTBEAT_PONG`, event push via `EVENT_PUSH`. Exponential backoff reconnection with jitter.
2. **Webhook** (fallback): HTTP server with configurable path. Validates HMAC-SHA256 signature and timestamp (5-minute window). Raw JSON passed to normalizer which uses `fromJson()`.

## Project Structure

```
src/
  index.ts            Public API re-exports
  channel.ts          OpenClaw Channel implementation for Nexus
  runtime.ts          Plugin runtime lifecycle
  dock.ts             Lightweight metadata export
  config.ts           NexusAccountConfig interface + validateConfig()
  config-accessor.ts  Config accessor utilities
  const.ts            Constants
  logger.ts           Logging utilities
  types.ts            Core types (SessionKey, NexusMsgContext, StreamSession, etc.)
  generated/          Generated protobuf code (committed to repo)
    buf/validate/     buf.validate annotations
    api/v1/           Service descriptors, request/response types
    shared/v1/        Enums, message types, webhook events, gateway frames
  gateway/
    manager.ts        GatewayManager: WebSocket vs Webhook selection per account
    ws-connector.ts   WebSocketConnector: binary protobuf frames, auth, heartbeat, reconnect
    webhook-server.ts WebhookServer: HTTP server with HMAC-SHA256 verification
  inbound/
    normalizer.ts     MessageNormalizer: WebhookEvent → NexusMsgContext (fromJson + oneof dispatch)
  outbound/
    adapter.ts        NexusOutboundAdapter: send text/markdown/media/card with retry
    stream.ts         NexusStreamAdapter: streaming message lifecycle
  nexus-api/
    client.ts         NexusClient: Connect RPC typed clients + int64 boundary helpers
    index.ts          Barrel re-exports of generated types, schemas, enums
  utils/
    session-key.ts    buildSessionKey(): agent:{id}:nexus:{convId}
    hmac.ts           HMAC-SHA256 compute/verify
    markdown-detect.ts isMarkdown(): regex-based detection
    id-gen.ts         generateClientMessageId(): snowflake-like bigint IDs
test/
  config.test.ts      Config validation tests
  utils.test.ts       Session key, HMAC, markdown, ID generator tests
  nexus-client.test.ts NexusClient tests with fetch mocking
  normalizer.test.ts  MessageNormalizer tests
  outbound-adapter.test.ts Outbound adapter tests
  stream-adapter.test.ts Stream adapter tests
  webhook-server.test.ts Webhook server tests
```

## Key Design Decisions

- **Protobuf code generation**: All types, enums, service descriptors generated from `nexus-proto/proto/`. No hand-written protocol types.
- **Connect RPC**: Typed service clients via `createClient(ServiceDesc, transport)`. Auth interceptor adds Bearer token. JSON transport mode.
- **Binary protobuf WS frames**: `toBinary()`/`fromBinary()` for WebSocket communication, matching the server proto protocol.
- **Snowflake-like IDs**: 42-bit timestamp + 22-bit counter for uniqueness within a single process. Returned as `bigint`, converted to `number` at plugin boundary.
- **Markdown auto-detection**: Outbound text auto-classified via `isMarkdown()` → `MessageType.MARKDOWN` or `MessageType.TEXT`.
- **Retry**: Outbound messages retry up to 2x with backoff. Media uploads retry once. Stream deltas retry up to 3x per push.
- **Non-recoverable errors**: AUTH_FAILED, TOKEN_REVOKED, TOKEN_EXPIRED, UNAUTHENTICATED stop reconnection.
- **Media fallback**: If upload fails, sends URL as Markdown text link.

## Code Style

- ESM modules with `.js` extension in imports. `"type": "module"` in package.json. `moduleResolution: "bundler"` (required for generated protobuf code).
- Class-based architecture with barrel `index.ts` files per directory.
- Config validation returns discriminated union: `{ valid: true; config } | { valid: false; errors }`.
- `as const` for capability declarations. JSDoc on public APIs.
- Error handling via `ConnectError` from `@connectrpc/connect`.
