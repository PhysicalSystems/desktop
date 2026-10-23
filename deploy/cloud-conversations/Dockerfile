FROM oven/bun:1.3.14
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY patches ./patches
COPY packages ./packages
COPY deploy/cloud-conversations ./deploy/cloud-conversations
RUN bun install --frozen-lockfile --ignore-scripts
RUN mkdir -p /workspace /state && chown -R bun:bun /workspace /state
USER bun
ENV PORT=4096 CLOUD_WORKSPACE=/workspace CLOUD_STATE_DIR=/state
EXPOSE 4096
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 CMD ["bun", "run", "deploy/cloud-conversations/health.ts"]
CMD ["bun", "run", "deploy/cloud-conversations/start.ts"]
