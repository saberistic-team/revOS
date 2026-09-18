FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/engine/package.json packages/engine/package.json
COPY packages/temporal/package.json packages/temporal/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY tests ./tests
RUN pnpm build
FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/packages/database/migrations ./packages/database/migrations
COPY --from=build --chown=node:node /app/apps/api/src/playground.html ./dist/apps/api/src/playground.html
COPY --from=build --chown=node:node /app/apps/api/src/builder.html ./dist/apps/api/src/builder.html
COPY --from=build --chown=node:node /app/apps/api/src/output-view.js ./dist/apps/api/src/output-view.js
COPY --from=build --chown=node:node /app/apps/api/src/output-view.css ./dist/apps/api/src/output-view.css
COPY --from=build --chown=node:node /app/apps/api/src/knowledge.html ./dist/apps/api/src/knowledge.html
COPY --from=build --chown=node:node /app/apps/api/src/knowledge.js ./dist/apps/api/src/knowledge.js
COPY --from=build --chown=node:node /app/apps/api/src/knowledge.css ./dist/apps/api/src/knowledge.css
COPY --from=build --chown=node:node /app/apps/api/src/section-assistant.js ./dist/apps/api/src/section-assistant.js
COPY --from=build --chown=node:node /app/apps/api/src/section-assistant.css ./dist/apps/api/src/section-assistant.css
COPY --from=build --chown=node:node /app/apps/api/src/engagement-ui.js ./dist/apps/api/src/engagement-ui.js
COPY --from=build --chown=node:node /app/apps/api/src/engagements.css ./dist/apps/api/src/engagements.css
COPY --from=build --chown=node:node /app/apps/api/src/next ./dist/apps/api/src/next
COPY --from=build --chown=node:node /app/apps/api/src/customer-portal ./dist/apps/api/src/customer-portal
USER node
CMD ["node", "dist/apps/api/src/index.js"]
