# The headless router with the official CLIs it uses for sign-in and renewal.
# State lives in /state; see docs/docker.md.

# The web dashboard's UI, built with its pinned dependencies; only the output ships.
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS ui
WORKDIR /build/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY ui ./
RUN npm run build

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

# The Codex binary verifies TLS against the system certificate store, which
# the slim image lacks.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ARG CLAUDE_CODE_VERSION=2.1.295
ARG CODEX_VERSION=0.162.0
RUN npm install -g --no-fund --no-audit \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
  && npm cache clean --force

WORKDIR /opt/aar
COPY package.json ./
COPY src ./src
COPY --from=ui /build/ui/dist ./ui/dist
COPY docker/entrypoint.sh /usr/local/bin/aar-container

ENV AAR_STATE_DIR=/state
USER node
ENTRYPOINT ["aar-container"]
CMD ["serve"]
