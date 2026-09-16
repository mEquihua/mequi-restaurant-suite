FROM node:22-alpine AS build

WORKDIR /workspace

RUN corepack enable

COPY . .

RUN pnpm install --frozen-lockfile \
  && pnpm --filter @restaurant-suite/worker... run build \
  && pnpm --filter @restaurant-suite/worker deploy --legacy --prod /deploy

FROM node:22-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY --from=build --chown=node:node /workspace/services/worker/dist ./dist
COPY --from=build --chown=node:node /deploy/node_modules ./node_modules

USER node

CMD ["node", "dist/index.js"]
