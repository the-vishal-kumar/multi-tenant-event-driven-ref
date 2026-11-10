# Build context is the repository root (the image also carries db/migrations).
FROM node:22-alpine AS deps
WORKDIR /app/api
COPY api/package.json api/package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY api/ ./
RUN npm run build

# Source, dev dependencies and migrations: used for tests and the demo.
FROM build AS test
COPY db/migrations /app/db/migrations
ENV MIGRATIONS_DIR=/app/db/migrations

FROM node:22-alpine AS runtime
ENV NODE_ENV=production MIGRATIONS_DIR=/app/db/migrations
WORKDIR /app/api
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/api/dist ./dist
COPY db/migrations /app/db/migrations
USER node
EXPOSE 3000
CMD ["node", "--require", "./dist/tracing.js", "dist/server.js"]
