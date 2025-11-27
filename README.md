# Page Scraper Service

A generic web page scraping microservice with browser automation, featuring browser pooling and configurable site support. Designed to bypass Cloudflare protection and handle dynamic content. Includes comprehensive test coverage with enhanced Cloudflare detection and containerized testing infrastructure.

## Features

- **Generic Scraping**: Configurable selectors for any website
- **Browser Pool**: Pre-launched browsers for instant responses (3-5 second scraping vs 15+ seconds)
- **Site Configurations**: Pre-built configs for common sites (MFC, extensible to others)
- **Cloudflare Bypass**: Real Chromium browsers with fresh sessions per request
- **MFC NSFW Authentication**: Support for authenticated scraping with user's own session cookies
- **Stealth Mode**: Anti-detection for authenticated requests (bypasses Cloudflare bot protection)
- **Robust Error Handling**: Handles timeouts, challenges, and extraction failures
- **RESTful API**: Simple HTTP interface with both generic and site-specific endpoints
- **Docker Ready**: Optimized container with all browser dependencies
- **Comprehensive Testing**: Multi-suite test coverage with Jest, Puppeteer mocking, and containerized test execution

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

## API Endpoints

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

### GET /version
Get service version information for version management.

**Response:**
```json
{
  "name": "scraper",
  "version": "1.0.0",
  "status": "healthy"
}
```

### POST /reset-pool (Test Environment Only)
**⚠️ This endpoint is only available in non-production environments**

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

## 🧪 Testing

The scraper includes comprehensive test coverage with enhanced testing infrastructure and containerized test execution.

### Test Coverage Overview

- **Total Test Suites**: 10 test suites
- **Total Tests**: 215 passing tests
- **Code Coverage**: 80%+ (Codecov quality gate)
- **Testing Framework**: Jest + TypeScript + Supertest
- **Mocking Strategy**: Complete Puppeteer API mocking
- **Containerized Testing**: Docker-based test execution with coverage extraction
- **Enhanced Cloudflare Detection**: Dedicated test suite for Cloudflare bypass validation

### Test Structure

```
src/__tests__/
├── unit/
│   ├── genericScraper.test.ts        # Core scraping functionality
│   ├── browserPool.test.ts           # Browser pool management
│   ├── puppeteerAutomation.test.ts   # Browser automation
│   ├── errorHandling.test.ts         # Error scenarios
│   ├── mfcScraping.test.ts           # MFC-specific tests
│   ├── performance.test.ts           # Performance benchmarks
│   └── cloudflareDetection.test.ts   # Enhanced Cloudflare detection
└── integration/
    ├── scraperRoutes.test.ts         # API endpoint tests
    └── inter-service/
        └── backendCommunication.test.ts   # Cross-service communication
```

### Test Categories

**Unit Tests (7 suites):**
- **Generic Scraper**: SITE_CONFIGS validation, scraping logic, error handling
- **Browser Pool**: Pool management, concurrency, memory management
- **Puppeteer Automation**: Browser configuration, navigation, data extraction
- **Error Handling**: Network failures, timeouts, resource issues
- **MFC Scraping**: MFC-specific functionality and edge cases
- **Performance**: Response time benchmarks and efficiency tests
- **Cloudflare Detection**: Enhanced Cloudflare bypass validation and fuzzy matching

**Integration Tests (1 suite):**
- **API Routes**: All HTTP endpoints with various scenarios

### Key Testing Features

**Complete Puppeteer Mocking:**
```typescript
// Mock browser and page instances
const mockBrowser = {
  newPage: jest.fn(),
  close: jest.fn()
};

const mockPage = {
  goto: jest.fn(),
  evaluate: jest.fn(),
  close: jest.fn(),
  setViewport: jest.fn(),
  setUserAgent: jest.fn()
};
```

**Performance Testing:**
```typescript
// Example: Testing response time targets
it('should complete scraping within 5 seconds', async () => {
  const startTime = Date.now();
  await genericScraper.scrape(testUrl, config);
  const duration = Date.now() - startTime;
  expect(duration).toBeLessThan(5000);
});
```

**Error Scenario Testing:**
```typescript
// Example: Testing browser failure handling
it('should handle browser launch failure', async () => {
  mockPuppeteer.launch.mockRejectedValue(new Error('Browser launch failed'));
  
  await expect(browserPool.getBrowser())
    .rejects
    .toThrow('Browser launch failed');
});
```

### Running Tests

```bash
# WSL Setup Required: Install Node.js via NVM (see ../WSL_TEST_FIX_SOLUTION.md)

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
npx jest src/__tests__/unit/genericScraper.test.ts

# Run tests matching pattern
npx jest --testNamePattern="MFC scraping"
```

### Test Configuration

**TypeScript Test Configuration (`tsconfig.test.json`):**
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "strict": false,           // Relaxed type checking for tests
    "noImplicitAny": false,    // Allow implicit 'any' types
    "strictNullChecks": false, // More flexible null handling
    "skipLibCheck": true,      // Skip type checking of declaration files
    "types": ["jest", "node"]  // Include Jest and Node types
  },
  "include": [
    "src/**/__tests__/**/*",   // Include all test files
    "src/**/__mocks__/**/*"    // Include mock implementations
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
  
  // Enhanced Puppeteer Mocking
  moduleNameMapper: {
    '^puppeteer$': '<rootDir>/src/__tests__/__mocks__/puppeteer.ts'
  },
  
  // Comprehensive Mock Management
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,
  
  // Performance and Stability Enhancements
  bail: false,
  verbose: true
};
```

**Key Testing Improvements:**
- Introduced `tsconfig.test.json` for more flexible test compilation
- Relaxed TypeScript strict mode for easier test writing
- Added comprehensive type configuration for Jest and Node.js
- Improved mock type handling to reduce compilation friction
- Enhanced test file discovery and coverage reporting
- Added containerized testing with `test-container-coverage.sh` script
- Enhanced Cloudflare detection testing with fuzzy matching validation
- Cross-service communication validation tests

### Performance Benchmarks

**Target Metrics:**
- Response Time: 3-5 seconds per scraping operation
- Concurrent Capacity: 10+ simultaneous requests
- Browser Pool Efficiency: <1 second pool operations
- Memory Management: Proper cleanup after each operation

### Recent Improvements

**Security Enhancements (Latest):**
- Protected `/reset-pool` endpoint with authentication (x-admin-token)
- Conditional endpoint registration (not available in production)
- Async browser cleanup in `BrowserPool.reset()`
- Removed sensitive error details from API responses
- Enhanced Docker security (explicit file copying, no recursive COPY)

**Docker Production Improvements:**
- Fixed Chromium executable path for Alpine Linux (/usr/bin/chromium-browser)
- Dynamic healthcheck respects PORT environment variable
- Removed build fallback for fail-fast behavior
- Fixed .dockerignore to not exclude Dockerfiles from build context
- Added writable home directory for non-root user (Chromium requirement)
- Improved healthcheck security (no shell substitution)

**Test Coverage Improvements:**
- Achieved 80%+ code coverage (Codecov quality gate)
- Added comprehensive test suites for all routes
- Enhanced security testing for protected endpoints
- Improved mock implementations for async operations
- Better test isolation using `jest.isolateModules()` instead of `jest.resetModules()`
- Added try-finally blocks for guaranteed environment cleanup

**BrowserPool Enhancements:**
- Improved concurrency management
- Enhanced Cloudflare detection mechanism
- Optimized static state reset for better test isolation
- Proper async cleanup of browser resources

**Concurrency Management Strategy:**
```typescript
// New BrowserPool concurrency control
const browserPool = new ConcurrentBrowserPool({
  maxConcurrent: 10,  // Configurable concurrent browser limit
  maxQueueSize: 50,   // Prevent overwhelming browser resources
  timeoutMs: 30000    // Configurable request timeout
});
```

### Mock Test Data

**HTML Fixtures:**
```typescript
const MFC_FIGURE_HTML = `
<div class="item-picture">
  <img src="https://images.goodsmile.info/test.jpg" alt="Test Figure">
</div>
<div class="item-details">
  <span switch="Company">Test Company</span>
  <span switch="Character">Test Character</span>
</div>
`;
```

### CI/CD Integration

```bash
# CI test command
NODE_ENV=test npm run test:ci

# Coverage reporting for CI
NODE_ENV=test npm run test:coverage

# Containerized testing (isolates dependencies)
./test-container-coverage.sh
```

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

# Start development server
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

The service uses a multi-stage Dockerfile with the following build targets:

```bash
# Development (with hot reload, port 3010)
docker build --target development -t scraper:dev .
docker run -p 3010:3010 -e PORT=3010 --shm-size=2gb scraper:dev

# Test environment (port 3005)
docker build --target test -t scraper:test .
docker run -p 3005:3005 -e PORT=3005 --shm-size=2gb scraper:test

# Production (default, port 3000)
docker build -t scraper:prod .
docker run -p 3000:3000 -e PORT=3000 --shm-size=2gb scraper:prod
```

**Available stages:**
- `base`: Alpine Linux with Chromium and Puppeteer dependencies
- `development`: Includes devDependencies and nodemon for hot reload
- `test`: Test environment for CI/CD
- `builder`: Compiles TypeScript to JavaScript
- `production`: Optimized image with production dependencies only (default)

**Note**: `--shm-size=2gb` is required for Puppeteer to avoid memory issues with Chromium.

### Environment Variables

See `.env.example` for complete configuration template.

**Required:**
- `PORT`: Server port (default: 3000, dev: 3010, test: 3005)
- `NODE_ENV`: Environment mode (development, test, production)

**Optional:**
- `PUPPETEER_EXECUTABLE_PATH`: Custom Chrome/Chromium executable path
  - Useful for CI/CD environments or custom browser installations
  - Example: `/usr/bin/chromium-browser`
- `ADMIN_TOKEN`: Authentication token for admin endpoints
  - Required for `/reset-pool` endpoint in non-production environments
  - Simple string token for basic protection

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

## Performance

- **Browser Pool**: 3 pre-launched browsers eliminate 2-3 second startup delay
- **Fresh Sessions**: Each request gets clean browser to bypass anti-bot detection
- **Auto-Replenishment**: Pool automatically replaces used browsers in background
- **Optimized Chrome**: Container-optimized flags for minimal resource usage
- **Graceful Shutdown**: Proper browser cleanup on service termination

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