FROM node:22-alpine AS build

WORKDIR /workspace

RUN corepack enable

COPY . .

RUN pnpm install --frozen-lockfile \
  && pnpm --filter @restaurant-suite/admin... \
    --filter @restaurant-suite/staff... \
    --filter @restaurant-suite/kitchen... \
    --filter @restaurant-suite/self-service... \
    --filter @restaurant-suite/customer... run build

FROM nginx:1.27-alpine AS runtime

COPY infra/compose/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/admin/dist /usr/share/nginx/html/admin
COPY --from=build /workspace/apps/staff/dist /usr/share/nginx/html/staff
COPY --from=build /workspace/apps/kitchen/dist /usr/share/nginx/html/kitchen
COPY --from=build /workspace/apps/self-service/dist /usr/share/nginx/html/self-service
COPY --from=build /workspace/apps/customer/dist /usr/share/nginx/html/customer
