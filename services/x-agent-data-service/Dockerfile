# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (tsx needed at runtime for pipeline scripts)
RUN npm install

# Copy source
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript (compiles src/ only, scripts/ are run via tsx)
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Copy package files and install all deps (tsx needed at runtime)
COPY package*.json ./
RUN npm install --production=false

# Copy built service files
COPY --from=builder /app/dist ./dist

# Copy pipeline scripts (ESM, run via tsx at runtime)
COPY scripts ./scripts

# Expose HTTP port for health checks
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))" || exit 1

# Run the service
CMD ["node", "dist/index.js"]
