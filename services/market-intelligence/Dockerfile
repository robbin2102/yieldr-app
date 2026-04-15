FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist/ ./dist/
EXPOSE 3000
# Force IPv4 DNS — Railway's IPv6 private network has no internet egress; Node 20's
# default "verbatim" DNS order picks AAAA records first and fails immediately.
CMD ["node", "--dns-result-order=ipv4first", "dist/index.js"]
