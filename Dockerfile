# =============================================================================
# BASE STAGE - Secure Ubuntu 26.04 + Node 24.20.0 LTS + Chrome 152.0.7977.54
# =============================================================================
FROM ubuntu:26.04 AS base

# Cache-bust ARG to invalidate Docker layers when dependencies change
ARG CACHE_BUST=2026-09-01-node-24.20.0-chrome-152.0.7977.54-estate

# Update all packages for latest security patches (openssl, gnupg, glibc)
# Install Node.js 24 using official binaries (avoids NodeSource CVE false positives)
RUN apt-get update && apt-get upgrade -y \
    && apt-get install -y \
    curl \
    xz-utils \
    && NODE_VERSION=v24.20.0 \
    && curl -fsSLO https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz \
    && tar -xJf node-${NODE_VERSION}-linux-x64.tar.xz -C /usr/local --strip-components=1 \
    && rm node-${NODE_VERSION}-linux-x64.tar.xz \
    && rm -rf /var/lib/apt/lists/*

# Pin npm to the 11.x line (estate precedent: fixes bundled tar/brace-expansion CVEs without jumping to npm 12)
RUN npm install -g npm@11 && npm cache clean --force

WORKDIR /app

# Install dependencies for Puppeteer and ensure latest security updates
RUN apt-get update && apt-get upgrade -y \
    && apt-get install -y \
    ca-certificates \
    procps \
    libxss1 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libatspi2.0-0 \
    libxkbcommon0 \
    libgbm1 \
    libgtk-3-0 \
    libasound2t64 \
    && rm -rf /var/lib/apt/lists/*

# Install fonts for Puppeteer
RUN apt-get update && apt-get upgrade -y \
    && apt-get install -y fonts-liberation fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf \
    && apt-get autoremove -y --purge \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Download and install Chrome for Testing (152.0.7977.54) - the exact build puppeteer 25.9.0 pins in PUPPETEER_REVISIONS.
# Verified: puppeteer 25.9.0 drives 152 with identical fixture extraction vs 151 (A/B tested).
RUN apt-get update && apt-get install -y wget unzip \
    && wget -q https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.54/linux64/chrome-linux64.zip \
    && unzip chrome-linux64.zip \
    && mv chrome-linux64 /opt/chrome \
    && rm chrome-linux64.zip \
    && chmod +x /opt/chrome/chrome \
    && apt-get remove -y wget unzip \
    && rm -rf /var/lib/apt/lists/*

# Set Chrome path for Puppeteer and skip download
ENV PUPPETEER_EXECUTABLE_PATH=/opt/chrome/chrome
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_SKIP_DOWNLOAD=true

# =============================================================================
# DEVELOPMENT STAGE - For local development with hot reload
# =============================================================================
FROM base AS development

# Copy package files
COPY package*.json .npmrc ./
# patches/ must be present before npm install so the patch-package postinstall applies
COPY patches ./patches
# plugin-contract manifest must be present so the file: dependency resolves at npm install
COPY packages/plugin-contract/package.json ./packages/plugin-contract/

# Install all dependencies (Puppeteer won't download Chrome due to ENV vars)
RUN npm config set fetch-timeout 300000 && npm config set fetch-retry-maxtimeout 300000
RUN --mount=type=secret,id=node_auth_token \
    NODE_AUTH_TOKEN="$(cat /run/secrets/node_auth_token)" timeout 600 npm ci --no-audit --no-fund

# Remove any Chrome that might have been downloaded by Puppeteer
RUN rm -rf /root/.cache/puppeteer \
    && rm -rf node_modules/puppeteer/.local-chromium \
    && rm -rf node_modules/puppeteer-core/.local-chromium

# Copy source code
COPY . .

# Expose port for development
EXPOSE 3080

CMD ["npm", "run", "dev"]

# =============================================================================
# TEST STAGE - For running tests in CI/CD
# =============================================================================
FROM development AS test

# Tests are run separately in CI/CD pipelines
# This stage provides the test environment
CMD ["npm", "run", "test:ci"]

# =============================================================================
# BUILDER STAGE - Build production assets
# =============================================================================
FROM base AS builder

# Copy package files
COPY package*.json .npmrc ./
# patches/ must be present before npm install so the patch-package postinstall applies
COPY patches ./patches
# plugin-contract manifest must be present so the file: dependency resolves at npm install
COPY packages/plugin-contract/package.json ./packages/plugin-contract/

# Install all dependencies for build
RUN npm config set fetch-timeout 300000 && npm config set fetch-retry-maxtimeout 300000
RUN --mount=type=secret,id=node_auth_token \
    NODE_AUTH_TOKEN="$(cat /run/secrets/node_auth_token)" timeout 600 npm ci --no-audit --no-fund

# Remove any Chrome that might have been downloaded by Puppeteer
RUN rm -rf /root/.cache/puppeteer \
    && rm -rf node_modules/puppeteer/.local-chromium \
    && rm -rf node_modules/puppeteer-core/.local-chromium

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# =============================================================================
# PRODUCTION STAGE - Final production image
# =============================================================================
FROM base AS production

# Copy package files
COPY package*.json .npmrc ./
# patches/ must be present before npm install so the patch-package postinstall applies
COPY patches ./patches
# plugin-contract manifest must be present so the file: dependency resolves at npm install
COPY packages/plugin-contract/package.json ./packages/plugin-contract/

# Install only production dependencies
RUN npm config set fetch-timeout 300000 && npm config set fetch-retry-maxtimeout 300000
RUN --mount=type=secret,id=node_auth_token \
    NODE_AUTH_TOKEN="$(cat /run/secrets/node_auth_token)" timeout 600 npm ci --no-audit --no-fund --omit=dev

# Remove any Chrome that might have been downloaded by Puppeteer
RUN rm -rf /root/.cache/puppeteer \
    && rm -rf node_modules/puppeteer/.local-chromium \
    && rm -rf node_modules/puppeteer-core/.local-chromium

# Remove the global npm/npx CLI: npm bundles its own transitive deps (e.g. brace-expansion)
# that scanners flag in the shipped image, though they run only at install time. The runtime
# launches via `node dist/...` (see CMD), so npm is not needed in the final image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Remove Canonical's Pebble service manager: baked into the ubuntu:26.04 base layer
# (not dpkg-owned, no apt rdepends) but never invoked here — the container runs
# `node dist/index.js` directly (see CMD), never pebble. Its bundled Go stdlib trips
# grype High/Critical advisories (GO-2026-5026/6089/6090/5972) that block the PR
# security gate for every change. (2026-08-19)
RUN rm -rf /usr/bin/pebble /var/lib/pebble

# Copy built application from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/packages/plugin-contract/dist ./packages/plugin-contract/dist

# Create non-root user for security
RUN groupadd -r pptruser && useradd -r -g pptruser -G audio,video pptruser \
    && mkdir -p /home/pptruser/Downloads \
    && chown -R pptruser:pptruser /home/pptruser \
    && chown -R pptruser:pptruser /app

# Switch to non-root user
USER pptruser

# Expose port
EXPOSE 3050

# Health check with 30s start period for Puppeteer initialization
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3050/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "--import", "./dist/tracing.js", "dist/index.js"]
