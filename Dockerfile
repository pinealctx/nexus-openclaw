# -----------------------------------------------------------------------
# nexus-openclaw — OpenClaw channel plugin for Nexus AI
# -----------------------------------------------------------------------
# Both stages use the same base image (already pulled locally).
#
# Usage:
#   NEXUS_OPENCLAW_TOKEN=nxa_... NEXUS_OPENCLAW_USER_ID=42 \
#     docker compose --profile openclaw up -d --build
# -----------------------------------------------------------------------

# ---- Build stage ----
FROM alpine/openclaw:latest AS builder
WORKDIR /build

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY tsconfig.json openclaw.plugin.json ./
COPY src/ src/
RUN pnpm build
RUN pnpm install --frozen-lockfile --prod

# ---- Runtime stage ----
FROM alpine/openclaw:latest
COPY --from=builder /build /opt/nexus-openclaw
