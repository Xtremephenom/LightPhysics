# syntax=docker/dockerfile:1.7
# The digest is the linux/amd64 manifest observed for the exact Node tag on
# 2026-10-18. Phase 0 downloads the hash-checked FFmpeg artifact during the
# network-enabled base stage; the test/runtime stages use the installed binary
# without network access.
ARG BASE_IMAGE=node:24.18.0-bookworm-slim@sha256:d45d78e7929b46875bbd4e29bea672d5bc48186c6c3588306521c815e78352d6

FROM ${BASE_IMAGE} AS base
ARG NODE_VERSION=24.18.0
ARG PNPM_VERSION=12.14.0
ARG UV_VERSION=UNKNOWN
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=UTC \
    SOURCE_DATE_EPOCH=0 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_DEFAULT_TO_LATEST=0 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

USER root
COPY docker/apt-packages.txt /tmp/lp-apt-packages.txt
RUN apt-get update \
    && awk '!/^[[:space:]]*#/ && NF { print }' /tmp/lp-apt-packages.txt | xargs -r apt-get install -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* /tmp/lp-apt-packages.txt
COPY tools.lock.json scripts/install-tools.mjs scripts/install-ffmpeg.mjs scripts/ffmpeg-smoke.mjs docker/bootstrap.sh /opt/lp-bootstrap/
RUN chmod 0755 /opt/lp-bootstrap/bootstrap.sh \
    && /opt/lp-bootstrap/bootstrap.sh --check-only \
    && ffmpeg_path="$(node /opt/lp-bootstrap/install-ffmpeg.mjs --lock /opt/lp-bootstrap/tools.lock.json --platform linux-x64 --destination /opt/lp-tools/ffmpeg)" \
    && chmod 0555 /opt/lp-tools/ffmpeg \
    && test -x "$ffmpeg_path" \
    && node /opt/lp-bootstrap/ffmpeg-smoke.mjs --ffmpeg "$ffmpeg_path" --timeout-ms 30000 \
    && ln -s "$ffmpeg_path" /usr/local/bin/ffmpeg \
    && corepack enable \
    && corepack prepare pnpm@12.14.0 --activate \
    && if getent passwd lp >/dev/null 2>&1; then \
         usermod --home /lp --shell /bin/sh lp; \
       else \
         useradd --create-home --uid 10001 --shell /bin/sh lp; \
       fi \
     && mkdir -p /lp \
     && chown lp:lp /lp \
     && mkdir -p /opt/ms-playwright \
     && chown -R lp:lp /opt/ms-playwright
WORKDIR /app
USER root
RUN chown lp:lp /app
USER lp
RUN printf '%s\n' '{"packageManager":"pnpm@12.14.0"}' > /lp/package.json \
    && cd /lp \
    && pnpm --version \
    && rm /lp/package.json

FROM base AS deps
COPY --chown=lp:lp package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .node-version .python-version tools.lock.json ./
COPY --chown=lp:lp apps/cli/package.json apps/cli/package.json
COPY --chown=lp:lp apps/electron/package.json apps/electron/package.json
COPY --chown=lp:lp apps/lpd/package.json apps/lpd/package.json
COPY --chown=lp:lp packages/config/package.json packages/config/package.json
COPY --chown=lp:lp packages/core-api/package.json packages/core-api/package.json
COPY --chown=lp:lp packages/ledger/package.json packages/ledger/package.json
COPY --chown=lp:lp packages/logging/package.json packages/logging/package.json
COPY --chown=lp:lp packages/memory/package.json packages/memory/package.json
COPY --chown=lp:lp packages/forge/package.json packages/forge/package.json
COPY --chown=lp:lp packages/runner/package.json packages/runner/package.json
COPY --chown=lp:lp packages/schemas/package.json packages/schemas/package.json
COPY --chown=lp:lp packages/warden/package.json packages/warden/package.json
RUN pnpm install --frozen-lockfile
# Playwright 1.64.1 selects Chromium revision 1248. Install it once in the
# network-enabled dependency stage so the test stage is fully usable offline.
RUN pnpm exec playwright install chromium \
    && test -x /opt/ms-playwright/chromium-1248/chrome-linux64/chrome

FROM deps AS test
COPY --chown=lp:lp . .
# COPY overlays workspace source directories after the dependency layer. A
# frozen offline install restores pnpm's workspace links without contacting a
# registry or adding anything to the lockfile.
RUN pnpm install --offline --frozen-lockfile
RUN pnpm run test
CMD ["sh", "-c", "pnpm run test && pnpm run test:e2e"]

FROM base AS runtime
COPY --from=test --chown=lp:lp /app /app
USER root
COPY --chown=lp:lp docker/healthcheck.sh /usr/local/bin/lp-healthcheck
RUN chmod 0555 /usr/local/bin/lp-healthcheck
ENV LP_PHASE=0-bootstrap \
    LP_IN_CONTAINER=1 \
    LP_BIND=0.0.0.0 \
    LP_PORT=4317
WORKDIR /app
USER lp
HEALTHCHECK --interval=5s --timeout=5s --start-period=2s --retries=3 CMD ["/usr/local/bin/lp-healthcheck"]
CMD ["pnpm", "run", "lpd"]
