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

# Start server
CMD ["npm", "start"]
