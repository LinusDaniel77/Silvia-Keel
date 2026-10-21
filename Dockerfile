# Manipulation Shield API + console. Runs TypeScript directly with tsx (the repo has no build step).
FROM node:22-slim

RUN corepack enable
WORKDIR /app

# Dependencies first, for layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/tactics/package.json packages/tactics/
COPY packages/llm/package.json packages/llm/
COPY packages/engine/package.json packages/engine/
COPY packages/eval/package.json packages/eval/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/cli/package.json apps/cli/
COPY apps/demo/package.json apps/demo/
COPY apps/copilot/package.json apps/copilot/
RUN pnpm install --frozen-lockfile

COPY . .
RUN chown -R node:node /app
USER node

ENV SHIELD_LLM=off
EXPOSE 4180
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4180/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["pnpm", "api", "--host", "0.0.0.0"]
