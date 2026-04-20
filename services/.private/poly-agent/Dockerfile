FROM node:20-slim

WORKDIR /app

# ── 1. Install ALL deps (including devDeps for tsc) ──────────────
COPY package.json package-lock.json* ./
RUN npm ci

# ── 2. Copy source and compile ───────────────────────────────────
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── 3. Copy runtime assets ────────────────────────────────────────
# scripts/ are ESM, spawned at runtime via `npx tsx` — not compiled
COPY scripts ./scripts
# analyze-allocations.ts, sell-position.ts, redeem-positions.ts live at root — copy explicitly
COPY analyze-allocations.ts sell-position.ts redeem-positions.ts ./

# ── 4. Prune devDeps, keep tsx for runtime script spawning ────────
RUN npm prune --omit=dev && npm install tsx

# ── 5. Expose health port (Railway injects PORT automatically) ────
EXPOSE 3001

# Default: pipeline service
# To run the copy-trading bot instead: CMD ["node", "dist/index.js"]
CMD ["node", "dist/pipeline-service.js"]
