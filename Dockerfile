FROM node:24-bookworm-slim AS build

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY src ./src
COPY scripts/build-temporal.mjs ./scripts/build-temporal.mjs
RUN pnpm build:server && pnpm build:temporal

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY --from=build --chown=node:node /app/dist ./dist

USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
