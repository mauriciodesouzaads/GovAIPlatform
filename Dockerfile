# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production && cp -R node_modules /prod_modules
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build
RUN mkdir -p /app/dist/lib/opa && cp /app/src/lib/opa/policy.wasm /app/dist/lib/opa/ || echo "No WASM module present, continuing"
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
RUN addgroup -g 1001 -S govai && adduser -S govai -u 1001 -G govai

COPY --chown=govai:govai --from=builder /prod_modules ./node_modules
COPY --chown=govai:govai --from=builder /app/dist ./dist
COPY --chown=govai:govai --from=builder /app/package.json ./
# Copy scripts for migration
COPY --chown=govai:govai scripts ./scripts

USER govai

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["npm", "start"]

