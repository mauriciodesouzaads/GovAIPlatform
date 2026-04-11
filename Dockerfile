# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN npm ci --omit=dev && cp -R node_modules /prod_modules && \
    rm -rf /prod_modules/vitest /prod_modules/@vitest
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build
RUN mkdir -p /app/dist/lib/opa && \
    (cp /app/src/lib/opa/policy.wasm /app/dist/lib/opa/ || \
    cp /app/lib/opa/policy.wasm /app/dist/lib/opa/ || \
    echo "Warning: policy.wasm not found during build")
# Copy non-TS assets that tsc skips: .proto definitions consumed at runtime
# by openclaude-client.ts via @grpc/proto-loader (FASE 5b)
RUN mkdir -p /app/dist/proto && \
    cp /app/src/proto/openclaude.proto /app/dist/proto/openclaude.proto
# Test stage — retains devDependencies for running Vitest inside Docker
FROM node:20-alpine AS test

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/src ./src

CMD ["npm", "run", "test", "--", "--reporter=verbose"]

# Production stage — minimal image, no devDependencies or source code
FROM node:20-alpine AS production

WORKDIR /app

# Non-root user for security
RUN apk add --no-cache bash curl postgresql-client && addgroup -g 1001 -S govai && adduser -S govai -u 1001 -G govai


COPY --chown=govai:govai --from=builder /prod_modules ./node_modules
COPY --chown=govai:govai --from=builder /app/dist ./dist
COPY --chown=govai:govai package.json ./
# Copy scripts and migrations
COPY --chown=govai:govai scripts ./scripts
COPY --chown=govai:govai *.sql ./

# FASE 5-hardening: pre-create the shared volume mount points with govai
# ownership so when docker mounts the named volumes on top, they inherit
# the right uid/gid. Required because the api process runs as the
# unprivileged govai user but writes per-work-item workspace dirs there.
RUN mkdir -p /tmp/govai-workspaces /var/run/govai && \
    chown -R govai:govai /tmp/govai-workspaces /var/run/govai

USER govai

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["npm", "start"]

