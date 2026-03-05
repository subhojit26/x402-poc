# ── Build stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Production stage ─────────────────────────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

RUN apk add --no-cache wget

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
ENV PORT=4021

EXPOSE 4021

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1

CMD ["node", "dist/server.js"]
