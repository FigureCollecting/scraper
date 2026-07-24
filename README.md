# Scraper Service

A web scraping microservice with browser automation, browser pooling, priority queuing, and full MFC collection sync. Designed to bypass Cloudflare protection and handle dynamic content. Features a 3-tier priority queue, HMAC-signed webhook callbacks, session management with pause/resume, and comprehensive test coverage across 26 test suites.

## Features

- **Generic Scraping**: Configurable selectors for any website
- **Browser Pool**: Pre-launched browsers for instant responses (3-5 second scraping vs 15+ seconds)
- **Site Configurations**: Pre-built configs for common sites (MFC, extensible to others)
- **Cloudflare Bypass**: Real Chromium browsers with fresh sessions per request
- **MFC NSFW Authentication**: Support for authenticated scraping with user's own session cookies
- **Stealth Mode**: Anti-detection for authenticated requests (bypasses Cloudflare bot protection)
- **Full Collection Sync**: End-to-end workflow: validate cookies, export CSV, parse items, queue for scraping
- **3-Tier Priority Queue**: HOT/WARM/COLD priority lanes with deduplication and adaptive rate limiting
- **Session Management**: Cookie validation caching, automatic pause on failures, cooldown periods
- **HMAC Webhook Callbacks**: Signed callbacks to backend with SHA-256 authentication
- **Schema v3 Extraction**: Company/artist extraction, release date/price parsing, field auditing
- **Label Registry**: Regex-based MFC label pattern matching
- **Robust Error Handling**: Handles timeouts, challenges, and extraction failures
- **RESTful API**: HTTP interface with scraping, sync, and management endpoints
- **Docker Ready**: Optimized container with Chrome for Testing on Ubuntu 24.04
- **Comprehensive Testing**: 760+ tests across 26 suites with Jest, Supertest, and testcontainers

## Ethical Use & Legal Compliance

### Intended Use Cases

This scraper is designed for **personal data management** and **legitimate collection organization**:

✅ **Authorized Use Cases:**
- Scraping your own user data from websites where you have an account
- Managing personal figure collections with enhanced organization
- Aggregating content you own or have permission to access
- Educational research and personal archival
- Building better UIs for your own data

❌ **Prohibited Use Cases:**
- Scraping copyrighted content for redistribution
- Bypassing paywalls or authentication for unauthorized access
- Bulk data harvesting for competitive purposes
- Automated scraping that violates a site's Terms of Service
- Any use that could harm the target website or its users

### MFC NSFW Authentication

The NSFW authentication feature uses **stealth browser technology** to bypass Cloudflare's bot detection. This functionality is provided **exclusively for users to access their own authenticated content**:

- **User's Own Data**: Only scrape figures visible to the authenticated user
- **Personal Use**: For organizing and managing the user's own collection
- **Session Cookies**: User provides their own valid session cookies
- **No Credential Storage**: Cookies are time-limited bearer tokens, not permanent credentials
- **Respects Permissions**: User can only access content allowed by their MFC account settings

**Privacy Model**: Similar to how Plex manages your movie library or Calibre organizes your ebooks - this tool helps you better organize content you legitimately own or have access to.

### Legal Disclaimer

By using this service, you agree to:
1. Only scrape content you have permission to access
2. Comply with all applicable Terms of Service
3. Respect robots.txt and rate limiting
4. Use scraped data only for personal, non-commercial purposes
5. Not redistribute scraped copyrighted content

**This software is provided for legitimate personal use only. Users are solely responsible for ensuring their use complies with applicable laws and website terms of service.**

## Services Architecture

The scraper is composed of 12 service modules (6,897 total lines):

| Service | Lines | Purpose |
|---------|-------|---------|
| `genericScraper.ts` | 1,110 | Browser pool management, base scraping logic |
| `scrapeQueue.ts` | 1,050 | 3-tier priority queue (HOT/WARM/COLD), deduplication, rate limiting |
| `syncOrchestrator.ts` | 862 | Full sync workflow: validate → export → parse → queue |
| `sessionManager.ts` | 851 | Cookie validation caching, pause/cooldown management |
| `mfcListsFetcher.ts` | 843 | Fetch user lists and items from MFC |
| `mfcCsvExporter.ts` | 538 | CSV export from MFC Manager |
| `companyArtistExtractor.ts` | 461 | Schema v3 company/artist extraction |
| `cacheConfig.ts` | 326 | Cache TTL calculation |
| `releaseExtractor.ts` | 304 | Release date and price extraction |
| `webhookClient.ts` | 277 | HMAC-SHA256 signed callbacks to backend |
| `mfcLabelRegistry.ts` | 180 | Regex-based MFC label pattern registry |
| `fieldAuditCollector.ts` | 95 | Field completeness auditing |

## API Endpoints

### Scraper Routes

### POST /scrape
Generic scraping with custom configuration.

**Request Body:**
```json
{
  "url": "https://example.com/item/123",
  "config": {
    "imageSelector": ".product-image img",
    "manufacturerSelector": ".brand-name",
    "nameSelector": ".product-title",
    "scaleSelector": ".scale-info",
    "waitTime": 2000
  }
}
```

### POST /scrape/mfc
Convenience endpoint for MyFigureCollection (uses pre-built config).

**Request Body (Public Content):**
```json
{
  "url": "https://myfigurecollection.net/item/597971"
}
```

**Request Body (NSFW Content with Authentication):**
```json
{
  "url": "https://myfigurecollection.net/item/422432",
  "config": {
    "mfcAuth": {
      "sessionCookies": {
        "PHPSESSID": "your_session_id",
        "sesUID": "your_user_id",
        "TBv4_Iden": "your_user_id",
        "TBv4_Hash": "your_hash_value"
      }
    }
  }
}
```

**How to Get MFC Session Cookies:**
1. Log into MyFigureCollection in your browser
2. Open DevTools (F12) → Application/Storage → Cookies
3. Find `myfigurecollection.net` domain
4. Copy the four required cookie values
5. ⚠️ **Security**: Cookies expire (typically monthly), treat like passwords

**Note**: NSFW scraping uses stealth browser mode to bypass Cloudflare protection and requires valid authentication cookies from your own MFC account.

**Response (both endpoints):**
```json
{
  "success": true,
  "data": {
    "imageUrl": "https://images.goodsmile.info/...",
    "manufacturer": "Good Smile Company",
    "name": "Nendoroid Hatsune Miku",
    "scale": "1/1"
  }
}
```

### GET /configs
Get available pre-built site configurations.

**Response:**
```json
{
  "success": true,
  "data": {
    "mfc": {
      "imageSelector": ".item-picture .main img",
      "manufacturerSelector": "span[switch]",
      "nameSelector": "span[switch]:nth-of-type(2)",
      "scaleSelector": ".item-scale a[title=\"Scale\"]"
    }
  }
}
```

### GET /health
Health check endpoint for monitoring.

### GET /health/detailed
Detailed health check with browser pool and queue status.

### GET /version
Get service version information for version management.

**Response:**
```json
{
  "name": "scraper",
  "version": "2.2.0",
  "status": "healthy"
}
```

### GET /mfc/cookie-allowlist
Get the list of allowed MFC cookie names for authenticated scraping.

### POST /reset-pool (Test Environment Only)
**This endpoint is only available in non-production environments.**

Manually reset the browser pool for testing or emergency situations.

**Security:**
- **Environment Protection**: Only registered in non-production environments
- **Authentication Required**: Must provide valid `x-admin-token` header
- **Async Operation**: Properly closes all browsers before resetting

**Request Headers:**
```
x-admin-token: <admin-token-value>
```

**Response (Success):**
```json
{
  "success": true,
  "message": "Browser pool reset successfully"
}
```

**Response (Unauthorized):**
```json
{
  "success": false,
  "message": "Forbidden"
}
```

**Features:**
- Clears all existing browser instances safely
- Recreates the browser pool
- Useful for manual browser pool management during testing
- Can be used to mitigate Cloudflare detection issues

**Use Cases:**
- Force browser pool refresh during testing
- Reset pool after detecting browser fingerprinting changes
- Emergency recovery from browser cache/session issues in test environments

### Sync Routes

### POST /sync/validate-cookies
Validate MFC session cookies before starting a sync operation.

### POST /sync/export-csv
Export user collection data from MFC as CSV.

### POST /sync/from-csv
Parse a CSV export and queue items for scraping.

### POST /sync/full
Full sync workflow: validates cookies, exports CSV, parses items, and queues them for scraping.

### GET /sync/status
Get the current status of the sync operation.

### GET /sync/queue-stats
Get detailed queue statistics for monitoring.

**Response:**
```json
{
  "success": true,
  "data": {
    "queues": { "hot": 10, "warm": 5, "cold": 100 },
    "total": 115,
    "processing": 1,
    "completed": 50,
    "failed": 2,
    "rateLimit": {
      "active": false,
      "currentDelayMs": 3000
    }
  }
}
```

### Session Management Endpoints

#### GET /sync/sessions
Get all active sessions with their status.

**Response:**
```json
{
  "success": true,
  "data": {
    "sessions": [
      {
        "sessionId": "abc12345...",
        "isPaused": true,
        "consecutiveFailures": 3,
        "failedMfcIds": ["123456", "789012"],
        "inCooldown": false,
        "cooldownRemainingMs": 0
      }
    ],
    "count": 1,
    "pausedCount": 1,
    "inCooldownCount": 0
  }
}
```

#### POST /sync/sessions/:sessionId/resume
Resume a paused session to continue processing.

**Response:**
```json
{
  "success": true,
  "message": "Session resumed, processing will continue"
}
```

#### POST /sync/sessions/:sessionId/cancel-failed
Cancel all failed items for a session (removes them from queue).

**Response:**
```json
{
  "success": true,
  "message": "Cancelled 3 failed items",
  "data": { "cancelledCount": 3 }
}
```

## Testing

The scraper includes comprehensive test coverage with 26 test suites and containerized test execution.

### Test Coverage Overview

- **Total Test Suites**: 26 suites
- **Total Tests**: ~760 passing tests
- **Code Coverage**: 80%+ (Codecov quality gate)
- **Testing Framework**: Jest 30 + TypeScript + Supertest 7 + testcontainers
- **Mocking Strategy**: Complete Puppeteer API mocking
- **Containerized Testing**: Docker-based test execution with coverage extraction

### Test Structure

```
src/__tests__/
├── unit/
│   ├── browserPool.test.ts                    # Browser pool management
│   ├── cacheConfig.test.ts                    # Cache TTL calculation
│   ├── cacheConfigExtended.test.ts            # Extended cache scenarios
│   ├── companyArtistExtraction.test.ts        # Company/artist extraction
│   ├── companyArtistExtractorExtended.test.ts # Extended extraction scenarios
│   ├── fieldAuditCollector.test.ts            # Field completeness auditing
│   ├── genericScraperExtended.test.ts         # Extended scraper scenarios
│   ├── mfcCookieRetry.test.ts                 # MFC cookie retry logic
│   ├── mfcCsvExporter.test.ts                 # CSV export logic
│   ├── mfcLabelRegistry.test.ts               # Label pattern matching
│   ├── mfcListsFetcher.test.ts                # MFC list fetching
│   ├── performance.test.ts                    # Performance benchmarks
│   ├── releaseExtraction.test.ts              # Release date/price extraction
│   ├── releaseExtractorExtended.test.ts       # Extended release extraction
│   ├── scrapeQueue.test.ts                    # Priority queue logic
│   ├── scrapeQueueExtended.test.ts            # Extended queue scenarios
│   ├── scrapeQueueProcessing.test.ts          # Queue processing logic
│   ├── security.test.ts                       # Security and auth tests
│   ├── sessionManager.test.ts                 # Session management
│   ├── stringComparison.test.ts               # String comparison utilities
│   ├── syncOrchestrator.test.ts               # Sync workflow orchestration
│   ├── syncOrchestratorExtended.test.ts       # Extended sync scenarios
│   ├── syncRoutes.test.ts                     # Sync route handlers
│   └── webhookClient.test.ts                  # HMAC webhook callbacks
├── integration/
│   ├── scraperRoutes.test.ts                  # Scraper API endpoint tests
│   ├── syncRoutes.test.ts                     # Sync API endpoint tests
│   ├── setup.ts                               # Test environment setup
│   └── inter-service/
│       └── backendCommunication.test.ts       # Cross-service communication
```

### Running Tests

```bash
# Install dependencies
npm install

# Run all tests
npm test

# Run with coverage report
npm run test:coverage

# Run in watch mode (development)
npm run test:watch

# Run CI tests (no watch)
npm run test:ci

# Run containerized tests with coverage extraction
./test-container-coverage.sh

# Run specific test suite
npx jest src/__tests__/unit/scrapeQueue.test.ts

# Run tests matching pattern
npx jest --testNamePattern="sync orchestrator"
```

### Test Configuration

**TypeScript Test Configuration (`tsconfig.test.json`):**
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "strict": false,
    "noImplicitAny": false,
    "strictNullChecks": false,
    "skipLibCheck": true,
    "types": ["jest", "node"]
  },
  "include": [
    "src/**/__tests__/**/*",
    "src/**/__mocks__/**/*"
  ]
}
```

**Jest Configuration (`jest.config.js`):**
```javascript
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: [
    '**/__tests__/**/*.test.ts',
    '**/?(*.)+(spec|test).ts'
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/__tests__/__mocks__/',
    '/__tests__/fixtures/',
    '/__tests__/setup.ts'
  ],
  transform: {
    '^.+\.ts$': ['ts-jest', {
      tsconfig: '<rootDir>/tsconfig.test.json',
      diagnostics: { warnOnly: true }
    }]
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.ts'],
  testTimeout: 30000,
  maxWorkers: 4,

  moduleNameMapper: {
    '^puppeteer$': '<rootDir>/src/__tests__/__mocks__/puppeteer.ts'
  },

  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,

  bail: false,
  verbose: true
};
```

### Performance Benchmarks

**Target Metrics:**
- Response Time: 3-5 seconds per scraping operation
- Concurrent Capacity: 10+ simultaneous requests
- Browser Pool Efficiency: <1 second pool operations
- Memory Management: Proper cleanup after each operation

### Containerized Testing

The service includes a containerized testing script that runs all tests in a Docker environment:

```bash
# Run tests in isolated Docker container
./test-container-coverage.sh
```

**Features:**
- Isolated test environment with all dependencies
- Automated coverage report extraction
- Cross-platform compatibility
- Automatic browser opening of coverage reports (when available)
- Test results exported to `./test-results/` directory

**Output:**
- Coverage reports: `./test-results/coverage/lcov-report/index.html`
- Test results: `./test-results/reports/`

### CI/CD Integration

```bash
# CI test command
NODE_ENV=test npm run test:ci

# Coverage reporting for CI
NODE_ENV=test npm run test:coverage

# Containerized testing (isolates dependencies)
./test-container-coverage.sh
```

### Testing Documentation

See `TESTING.md` for comprehensive testing documentation including:
- Complete test strategy and methodology
- Detailed coverage breakdown
- Performance benchmarking
- Mock data and fixtures
- Maintenance guidelines

## Development

### Environment Setup

**Configuration Files:**
- `.env.example` - Template showing all environment variables
- `.env` - Your local configuration (gitignored, never commit this!)

**Quick Start:**
```bash
# Copy example (optional - defaults work for most cases)
cp .env.example .env

# Scraper typically works with defaults - no secrets required!
```

See `.env.example` for all configuration options including:
- Server port configuration
- Puppeteer Chrome path (for CI/CD)
- Admin token (for /reset-pool endpoint)
- Debug logging settings

### Local Development

```bash
# Install dependencies
npm install

# Start development server (uses tsx for fast startup)
npm run dev

# Build for production
npm run build

# Start production server
npm start

# Run tests in development
npm run test:watch
```

### Build Output

The build process generates JavaScript files and source maps:
- `routes/` - Compiled route handlers
- `services/` - Compiled service modules
- `index.js` - Main application entry point
- Source maps (`.js.map`) for debugging compiled code

### Testing in Development

```bash
# Watch mode for continuous testing
npm run test:watch

# Test specific functionality
npx jest browserPool --watch

# Performance testing
npx jest performance.test.ts
```

## Deployment

### Docker

The service uses a multi-stage Dockerfile with Ubuntu 24.04 base and Chrome for Testing 146:

```bash
# Development (with hot reload, port 3080)
docker build --target development -t scraper:dev .
docker run -p 3080:3080 -e PORT=3080 --shm-size=2gb scraper:dev

# Test environment (port 3070)
docker build --target test -t scraper:test .
docker run -p 3070:3070 -e PORT=3070 --shm-size=2gb scraper:test

# Production (default, port 3050)
docker build -t scraper:prod .
docker run -p 3050:3050 -e PORT=3050 --shm-size=2gb scraper:prod
```

**Available stages:**
- `base`: Ubuntu 24.04 with Chrome for Testing 146 and Puppeteer dependencies
- `development`: Includes devDependencies and tsx for hot reload
- `test`: Test environment for CI/CD
- `builder`: Compiles TypeScript to JavaScript
- `production`: Optimized image with production dependencies only (default)

**Note**: `--shm-size=2gb` is required for Puppeteer to avoid memory issues with Chrome.

### Environment Variables

See `.env.example` for complete configuration template.

**Required:**
- `PORT`: Server port (prod: 3050, local dev: 3080, test: 3070, Coolify dev: 3090)
- `NODE_ENV`: Environment mode (development, test, production)

**Required in Docker/Production:**
- `BACKEND_URL`: Backend service URL for webhook callbacks during MFC sync
  - Docker prod: `http://backend:5050`
  - Docker Coolify dev: `http://backend:5090`
  - Local dev: `http://localhost:5080`
  - (Must be reachable from the scraper container; used by the webhook client to send sync progress to backend)

**Optional:**
- `PUPPETEER_EXECUTABLE_PATH`: Custom Chrome/Chromium executable path
  - Useful for CI/CD environments or custom browser installations
  - Example: `/usr/bin/chromium-browser`
- `ADMIN_TOKEN`: Authentication token for admin endpoints
  - Required for `/reset-pool` endpoint in non-production environments
  - Simple string token for basic protection
- `PLUGIN_DIR`: Directory scanned for ruleset plugin packages at boot
  - Default: the service's own `node_modules`
  - Use when plugins are injected at runtime (e.g. a mounted volume in a container) instead of being installed as dependencies
  - Example: `/plugins/node_modules`
  - An explicit `nodeModulesDir` option passed to the plugin bootstrap takes precedence

**MFC Cookie Security:**
- `MFC_ALLOWED_COOKIES`: Whitelist of cookie names allowed during authenticated MFC scraping
  - **Default**: `PHPSESSID,sesUID,sesDID,cf_clearance`
  - **Purpose**: Security filter that only allows known MFC session cookies
  - **Format**: Comma-separated list of cookie names (case-sensitive)
  - **Why needed**: Prevents users from accidentally or maliciously injecting arbitrary cookies
  - Users provide session cookies via the API; this env var controls which ones are actually used

**Debug Logging:**
- `DEBUG`: Enable debug namespaces (e.g., `scraper:*`, `scraper:mfc`, `scraper:browser`)
- `SERVICE_AUTH_TOKEN_DEBUG`: Show partial tokens in logs for debugging (default: false)

## Integration

Update your main application to call this service instead of direct scraping:

```javascript
// MFC scraping (use environment-specific URL)
const scraperUrl = process.env.SCRAPER_SERVICE_URL || 'http://scraper:3000';
const response = await fetch(`${scraperUrl}/scrape/mfc`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: mfcLink })
});

// Generic scraping
const response = await fetch(`${scraperUrl}/scrape`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url: 'https://example.com/item/123',
    config: { imageSelector: '.product img' }
  })
});
```

## Architecture

This service runs separately from your main application to:
- Isolate browser automation resource usage
- Prevent main app crashes from scraping failures
- Allow independent scaling and updates
- Provide better browser fingerprinting

### Data Flow

```
Sync Workflow:
  validate-cookies → export-csv → parse CSV → queue items
       ↓                                          ↓
  sessionManager                          scrapeQueue (HOT/WARM/COLD)
                                                  ↓
                                          genericScraper (browser pool)
                                                  ↓
                                          extractors (company, artist, release, price)
                                                  ↓
                                          webhookClient → backend (HMAC-signed)
```

### Key Design Decisions

- **3-Tier Priority Queue**: HOT items (recently updated) are scraped first, WARM next, COLD last. Deduplication prevents redundant scrapes.
- **Session Pause/Resume**: Automatic pause after consecutive failures with configurable cooldown, plus manual resume via API.
- **HMAC Webhooks**: All callbacks to backend are signed with SHA-256 HMAC for authentication.
- **Browser Pool**: Pre-launched browsers eliminate startup delay. Fresh sessions per request prevent fingerprint accumulation.

## Performance

- **Browser Pool**: Pre-launched browsers eliminate 2-3 second startup delay
- **Fresh Sessions**: Each request gets clean browser to bypass anti-bot detection
- **Auto-Replenishment**: Pool automatically replaces used browsers in background
- **Optimized Chrome**: Container-optimized flags for minimal resource usage
- **Graceful Shutdown**: Proper browser cleanup on service termination
- **Adaptive Rate Limiting**: Queue automatically adjusts delay based on failure rates

## Adding New Sites

To add support for a new site, update `SITE_CONFIGS` in `src/services/genericScraper.ts`:

```javascript
export const SITE_CONFIGS = {
  mfc: { /* existing config */ },
  hobbylink: {
    imageSelector: '.product-main-image img',
    manufacturerSelector: '.maker-name',
    nameSelector: '.product-name h1',
    scaleSelector: '.scale-info .value',
    waitTime: 1500
  }
};
```
