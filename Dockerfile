# syntax=docker/dockerfile:1.7
#
# Roxstar backend image.
#
# Built from the REPOSITORY ROOT, not from /backend, because the image needs
# both the compiled server and /database/migrations -- a revision must never
# start against a schema older than the code it is running.
#
#   docker build -t roxstar-backend .
#
# Multi-stage so the runtime layer carries no compiler, no dev dependencies and
# no test code. Non-root by default; nothing here needs elevated privileges.

# ---------------------------------------------------------------------------
# Stage 1 - dependencies (cached independently of source changes)
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY backend/package.json backend/package-lock.json* ./
# `npm ci` respects the lockfile exactly -- a reproducible build is the whole
# point of packaging this with Docker.
RUN npm ci

# ---------------------------------------------------------------------------
# Stage 2 - build
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY backend/ ./
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 3 - production dependencies only
# ---------------------------------------------------------------------------
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY backend/package.json backend/package-lock.json* ./
RUN npm ci --omit=dev

# ---------------------------------------------------------------------------
# Stage 4 - runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

# wget backs the HEALTHCHECK; tini reaps zombies and forwards SIGTERM so the
# graceful shutdown path in server.ts actually runs on a Cloud Run revision swap.
RUN apk add --no-cache tini wget

ENV NODE_ENV=production \
    PORT=8080 \
    MIGRATIONS_DIR=/app/database/migrations

WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build     /app/dist         ./dist
COPY backend/package.json ./
COPY database/migrations ./database/migrations

# node:alpine already provides an unprivileged `node` user (uid 1000).
USER node

EXPOSE 8080

# Liveness only -- deliberately does not touch the database (D32), so a brief
# Cloud SQL blip cannot turn into a container restart storm.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
