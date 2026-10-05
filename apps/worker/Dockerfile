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
COPY apps/worker apps/worker
COPY packages packages
RUN npm run build:packages && npm run build -w @mona/build-worker

FROM node:24-bookworm-slim
ARG PACKSQUASH_VERSION=0.4.1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip \
  && curl -fsSL "https://github.com/ComunidadAylas/PackSquash/releases/download/v${PACKSQUASH_VERSION}/packsquash-x86_64-unknown-linux-gnu.zip" -o /tmp/packsquash.zip \
  && unzip /tmp/packsquash.zip -d /tmp/packsquash \
  && install -m 0755 /tmp/packsquash/packsquash /usr/local/bin/packsquash \
  && rm -rf /var/lib/apt/lists/* /tmp/packsquash /tmp/packsquash.zip
ENV NODE_ENV=production PACKSQUASH_BINARY=/usr/local/bin/packsquash
WORKDIR /app
COPY --from=build /app /app
USER node
CMD ["node", "apps/worker/dist/index.js"]
