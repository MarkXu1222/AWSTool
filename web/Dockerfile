FROM node:20-slim

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* pnpm-lock.yaml* ./
RUN npm install --production=false

# Copy source
COPY . .

# Build client + server
RUN npm run build

# Production
ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/server/index.js"]
