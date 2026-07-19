FROM node:20-slim

# Install Playwright system dependencies + git + sqlite3 + findutils (for backup script)
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
    git \
    sqlite3 \
    findutils \
    && rm -rf /var/lib/apt/lists/*

# Install bun
RUN npm install -g bun

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json bun.lock* ./

# Install dependencies
RUN bun install

# Install Playwright browsers (full playwright, not playwright-core)
RUN bun add playwright && npx playwright install chromium --with-deps

# Copy all files
COPY . .

# Generate Prisma client
RUN bun run db:generate || true

# Build the Next.js app
RUN bun run build

# Set environment variables
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# Expose port
EXPOSE 3000

# Start the app — Railway sets $PORT env var automatically
# HOSTNAME=0.0.0.0 binds to all interfaces (required by Railway healthcheck)
# DB tables are created automatically on first request via db.ensureSchema()
# in src/lib/db.ts — no runtime migration command needed.
CMD ["sh", "-c", "NODE_ENV=production HOSTNAME=0.0.0.0 PORT=${PORT:-3000} bun .next/standalone/server.js"]
