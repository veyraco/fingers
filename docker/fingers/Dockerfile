# ghcr.io/veyraco/fingers:<version>: the `fingers` CLI on Node 24 (Debian bookworm), the base of
# Veyra Hands sandbox images.
#
# Build context: the directory scripts/image-install-root.mjs writes from a release artifact set
# (install/ holds the release tarballs and the coding-agent install lock rewritten to use them).
# The release workflow (.github/workflows/release.yml) builds it for linux/amd64 and linux/arm64
# and runs `fingers --version` in it before pushing. Locally:
#
#   npm run build && node scripts/pack-packages.mjs --skip-build --out .artifacts/release
#   node scripts/image-install-root.mjs --manifest .artifacts/release/manifest.json --out .artifacts/image
#   docker build -f docker/fingers/Dockerfile -t fingers:local .artifacts/image
#
# Runs as uid 1000 (the image's `node` user) in /workspace. Fingers makes no request of its own at
# start (no version check here, git/ripgrep/fd are installed, so no tool download).
#
# Chromium is installed for the `browser` built-in tool (managed RPC `tools.builtin`). Its own sandbox
# needs user namespaces, which a Kubernetes pod usually does not grant, so FINGERS_BROWSER_NO_SANDBOX=1
# runs it without; the pod is the sandbox. docker/fingers/browser-smoke.mjs checks it in the image.

FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS install
WORKDIR /opt/fingers
COPY install/ ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
	&& rm -rf tarballs /root/.npm

FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
ARG FINGERS_VERSION=unknown
LABEL org.opencontainers.image.title="Veyra Fingers" \
	org.opencontainers.image.description="The fingers coding agent CLI" \
	org.opencontainers.image.source="https://github.com/veyraco/fingers" \
	org.opencontainers.image.licenses="MIT" \
	org.opencontainers.image.version="${FINGERS_VERSION}"
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates git ripgrep fd-find tini chromium fonts-liberation \
	&& ln -s /usr/bin/fdfind /usr/local/bin/fd \
	&& rm -rf /var/lib/apt/lists/*
COPY --from=install /opt/fingers /opt/fingers
RUN ln -s /opt/fingers/node_modules/.bin/fingers /usr/local/bin/fingers \
	&& mkdir -p /workspace \
	&& chown 1000:1000 /workspace
ENV HOME=/home/node \
	FINGERS_SKIP_VERSION_CHECK=1 \
	FINGERS_BROWSER_PATH=/usr/bin/chromium \
	FINGERS_BROWSER_NO_SANDBOX=1 \
	NODE_ENV=production
USER 1000:1000
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "fingers"]
