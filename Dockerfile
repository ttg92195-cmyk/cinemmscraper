FROM node:20-slim

# Install Playwright system dependencies
RUN apt-get update && apt-get install -y \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libatspi2.0-0 \
    libwayland-client0 \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Install bun
RUN npm install -g bun

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json bun.lock* ./

# Install dependencies
RUN bun install

# Install Playwright browsers
RUN npx playwright install chromium --with-deps

# Copy all files
COPY . .

# Generate Prisma client
RUN bun run db:generate || true

# Build the Next.js app
RUN bun run build

# Set environment variables
ENV NODE_ENV=production
ENV PORT=$PORT
ENV HOST=0.0.0.0

# Expose port (Railway sets $PORT automatically)
EXPOSE 3000

# Start the app — Railway sets $PORT env var
CMD ["sh", "-c", "NODE_ENV=production bun .next/standalone/server.js"]
