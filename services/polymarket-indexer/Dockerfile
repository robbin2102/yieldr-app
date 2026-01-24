# Polymarket Indexer Dockerfile
# Build context should be the project root (yieldr-app/)

FROM node:20-alpine

WORKDIR /app

# Copy package files from root (for shared dependencies)
COPY package*.json ./

# Install all dependencies
RUN npm ci --only=production=false

# Copy source files
COPY . .

# Build TypeScript
RUN npm run build 2>/dev/null || true

# Set working directory for the indexer
WORKDIR /app

# Run the indexer
CMD ["npx", "tsx", "services/polymarket-indexer/src/index.ts"]
