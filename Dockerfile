# syntax=docker/dockerfile:1.7
# HyperLevel – production image: small Alpine runtime, app runs as a non-root user, data on the /data volume.
#
#   docker build -t gohigh .
#   docker run -d -p 4700:4700 -v gohigh-data:/data -e PGHL_BASE_URL=https://crm.example.com gohigh
#
# The build stage runs once on the build machine's own architecture: its output (compiled server, web
# bundle, pure-JavaScript runtime dependencies) is the same for every CPU, so the multi-arch image
# (linux/amd64 + linux/arm64) needs no slow emulated npm install.

ARG NODE_VERSION=22

FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
ENV CI=true
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY . .
RUN npm run build \
 && node scripts/check-licenses.mjs --texts dist-web/THIRD_PARTY_LICENSES.txt \
 && npm prune --omit=dev --no-audit --no-fund \
 && rm -rf node_modules/.cache

FROM node:${NODE_VERSION}-alpine AS runtime
LABEL org.opencontainers.image.title="HyperLevel" \
      org.opencontainers.image.description="The open-source, self-hosted alternative to GoHighLevel and HubSpot" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.source="https://github.com/gohyperlevel/gohyperlevel"
ENV NODE_ENV=production \
    PGHL_DATA_DIR=/data \
    PGHL_BEHIND_PROXY=1 \
    PORT=4700
WORKDIR /app
# The app runs as the image's unprivileged "node" user (uid 1000). docker-start.mjs starts as root only to
# hand /data to that user (volumes and platform disks are often root-owned) and then drops privileges
# before the server loads; `docker run --user 1000:1000` skips that step entirely.
RUN mkdir -p /data && chown node:node /data
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/dist-web ./dist-web
# Guides for the in-app academy, plus the license files.
COPY --from=build /app/docs ./docs
COPY --from=build /app/README.md /app/README.de.md /app/LICENSE /app/NOTICE /app/CHANGELOG.md ./
COPY --from=build /app/scripts/docker-start.mjs ./docker-start.mjs
# Local bridge for the AI agent (downloaded from /api/agent/bridge/script)
COPY --from=build /app/bridge ./bridge
VOLUME /data
EXPOSE 4700
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4700)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["node", "--no-warnings", "docker-start.mjs"]
