FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Expose port (Railway uses PORT env var, typically 8080)
EXPOSE 8080

# Force IPv4 DNS — Railway's IPv6 private network has no internet egress; Node 20's
# default "verbatim" DNS order picks AAAA records first and fails immediately.
CMD ["node", "--dns-result-order=ipv4first", "dist/index.js"]
