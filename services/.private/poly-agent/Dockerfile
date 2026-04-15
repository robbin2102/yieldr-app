FROM node:20-slim

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm install tsx

# Copy compiled source (built via tsc before Docker build)
COPY dist ./dist

# Copy scripts directory (ESM, run via tsx at runtime)
COPY scripts ./scripts

# Copy env template (actual secrets injected by Railway)
# COPY env.polyagent .env

EXPOSE 3001

# Default: run the pipeline service
# Override CMD in Railway to run the trading bot instead (node dist/index.js)
CMD ["node", "dist/pipeline-service.js"]
