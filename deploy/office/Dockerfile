# syntax=docker/dockerfile:1.7
# HyperLevel with the optional Office editors and engines (docs/office.md): the HyperLevel image plus the pinned upstream releases from
# versions.env, fetched and checked by install.sh at build time. Nothing of it is part of HyperLevel's own image.
#
#   docker build -t gohigh-office deploy/office                                     # from the published HyperLevel image
#   docker build -t gohigh-office --build-arg GOHIGH_IMAGE=gohigh:local deploy/office # from your own build
#   docker build -t gohigh-office --build-arg OFFICE_KINDS=docx,pdf deploy/office     # only some kinds
#
# The engines are glibc programs (≥ 2.35), so this image runs HyperLevel on Debian (bookworm) instead of Alpine – same app, same
# /data volume, same start script and user. The editors are static files (about 13–40 MB each, precompressed .gz next to them).

ARG GOHIGH_IMAGE=ghcr.io/baisesystems/hyperlevel:latest
ARG NODE_VERSION=22

FROM debian:bookworm-slim AS office
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip gzip brotli \
 && rm -rf /var/lib/apt/lists/*
COPY versions.env install.sh /tmp/office/
ARG OFFICE_KINDS=docx,xlsx,pptx,pdf
RUN bash /tmp/office/install.sh --web-dir /opt/office/web --bin-dir /opt/office/bin --kinds "$OFFICE_KINDS"

FROM ${GOHIGH_IMAGE} AS gohigh

FROM node:${NODE_VERSION}-bookworm-slim
LABEL org.opencontainers.image.title="HyperLevel with Office" \
      org.opencontainers.image.licenses="AGPL-3.0-only AND (MIT OR Apache-2.0)"
ENV NODE_ENV=production \
    PGHL_DATA_DIR=/data \
    PGHL_BEHIND_PROXY=1 \
    PORT=4700 \
    PGHL_OFFICE_DIR=/opt/office/web \
    PGHL_OFFICE_BIN_DIR=/opt/office/bin
WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY --from=gohigh /app /app
COPY --from=office /opt/office /opt/office
COPY THIRD-PARTY.md /opt/office/THIRD-PARTY.md
VOLUME /data
EXPOSE 4700
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4700)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["node", "--no-warnings", "docker-start.mjs"]
