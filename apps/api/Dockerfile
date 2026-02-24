FROM oven/bun:latest AS deps

WORKDIR /app

COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/

RUN bun install --frozen-lockfile --production

FROM oven/bun:latest

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules

COPY apps/api/src ./apps/api/src
COPY apps/api/package.json apps/api/tsconfig.json ./apps/api/
COPY package.json ./

EXPOSE 3000

USER bun

CMD ["bun", "run", "apps/api/src/index.ts"]
