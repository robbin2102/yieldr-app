# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Copy package files and install production deps only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built files
COPY --from=builder /app/dist ./dist

# Expose WebSocket port (configurable via WS_PORT env var, default 5050)
EXPOSE 5050

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "const p=process.env.WS_PORT||5050;require('http').get('http://localhost:'+p, (r) => process.exit(r.statusCode === 426 ? 0 : 1))" || exit 1

# Run the worker
CMD ["node", "dist/index.js"]
