FROM node:22-alpine AS build

WORKDIR /workspace

RUN corepack enable

COPY . .

RUN pnpm install --frozen-lockfile \
  && pnpm --filter @restaurant-suite/api... run build \
  && pnpm --filter @restaurant-suite/api deploy --legacy --prod /deploy

FROM node:22-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY --from=build --chown=node:node /workspace/services/api/dist ./dist
COPY --from=build --chown=node:node /deploy/node_modules ./node_modules

USER node

EXPOSE 3000

CMD ["node", "dist/server.js"]
