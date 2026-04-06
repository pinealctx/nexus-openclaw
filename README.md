# nexus-openclaw

OpenClaw channel plugin for [Nexus AI](https://github.com/pinealctx/nexus-ai) IM platform.

Enables OpenClaw LLM agents to operate as Nexus AI agents — receiving and sending messages across private and group conversations with support for text, Markdown, streaming, media, and Adaptive Cards.

## Features

- **WebSocket-first**: connects to Nexus Gateway via `/ws/agent` for real-time event delivery (no public URL needed)
- **Webhook fallback**: optional HTTP endpoint for production deployments
- **Gateway auto-discovery**: only `serverUrl` required — Gateway address resolved via `GetClientConfig`
- **Streaming messages**: maps OpenClaw block streaming to Nexus `STREAM` → `PushStreamDelta` → `EndStream`
- **Markdown**: auto-detects Markdown syntax and sends as `MESSAGE_TYPE_MARKDOWN`
- **Media**: upload and send images, audio, video, and files
- **Adaptive Cards**: send interactive cards, handle `Action.Submit` callbacks
- **Group support**: DM and group conversations with @mention detection

## Quick Start

```bash
npm install nexus-openclaw
openclaw plugins install nexus-openclaw
```

Add to your `~/.openclaw/openclaw.json`:

```json5
{
  "channels": {
    "nexus": {
      "accounts": {
        "default": {
          "agentToken": "nxa_your_token_here",
          "agentUserId": 42,
          "serverUrl": "http://localhost:8443",
          "deliveryMode": "websocket"
        }
      }
    }
  }
}
```

Restart the OpenClaw gateway. The plugin auto-discovers the Nexus Gateway WebSocket URL and connects.

## Configuration

| Field | Required | Default | Description |
|:------|:---------|:--------|:------------|
| `agentToken` | yes | — | Nexus Agent token (`nxa_` prefix) |
| `agentUserId` | yes | — | Agent user ID in Nexus |
| `serverUrl` | yes | — | Nexus Server URL (HTTP or HTTPS) |
| `deliveryMode` | no | `websocket` | `websocket` or `webhook` |

### WebSocket options (optional)

| Field | Default | Description |
|:------|:--------|:------------|
| `websocket.heartbeatInterval` | `30000` | Heartbeat interval (ms) |
| `websocket.maxReconnectAttempts` | `-1` | Max reconnect attempts (-1 = infinite) |
| `websocket.reconnectBaseDelay` | `1000` | Reconnect base delay (ms) |
| `websocket.reconnectMaxDelay` | `30000` | Reconnect max delay (ms) |

### Webhook options (required when `deliveryMode: "webhook"`)

| Field | Default | Description |
|:------|:--------|:------------|
| `webhook.webhookSecret` | — | HMAC-SHA256 signing secret |
| `webhook.port` | — | HTTP server port |
| `webhook.path` | `/webhook` | HTTP server path |
| `webhook.host` | `0.0.0.0` | Bind address |

## Development

```bash
git clone https://github.com/pinealctx/nexus-openclaw.git
cd nexus-openclaw
npm install
npm test
npm run build
```

## License

MIT
