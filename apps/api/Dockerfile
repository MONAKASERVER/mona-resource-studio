FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/minecraft/package.json packages/minecraft/package.json
COPY packages/build/package.json packages/build/package.json
COPY packages/cit/package.json packages/cit/package.json
COPY packages/pixel/package.json packages/pixel/package.json
RUN npm ci
COPY apps/api apps/api
COPY packages packages
RUN npm run build:packages && npm run build -w @mona/api

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 4100
CMD ["sh", "-c", "node apps/api/dist/db/migrate.js && node apps/api/dist/server.js"]
