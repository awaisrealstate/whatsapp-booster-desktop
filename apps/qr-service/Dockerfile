FROM node:22-alpine

WORKDIR /app

# Copy workspace manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/providers ./packages/providers
COPY packages/shared ./packages/shared
COPY apps/qr-service ./apps/qr-service

RUN corepack enable && pnpm install --frozen-lockfile --filter @wacrm/qr-service...

# Persistent volume mount for AES-256-GCM encrypted Baileys session files
ENV QR_STORAGE_DIR=/var/lib/wacrm-qr-sessions
RUN mkdir -p /var/lib/wacrm-qr-sessions

EXPOSE 8790
CMD ["node", "apps/qr-service/src/server.ts"]
