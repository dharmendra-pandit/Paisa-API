# syntax=docker/dockerfile:1

# ---------- dependencies ----------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
# npm ci needs the lockfile; --omit=dev keeps the runtime image lean.
RUN npm ci --omit=dev

# ---------- runtime ----------
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=5000

# dumb-init reaps zombies and forwards SIGTERM, so graceful shutdown actually runs.
RUN apk add --no-cache dumb-init

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src

# Never run as root; the node image already ships an unprivileged `node` user.
USER node

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||5000)+'/api/v1/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.js"]
