# Changelog

All notable changes to the Scraper service will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.6] - 2026-01-01

### Fixed
- **Concurrent Processing Race Condition**: Fixed scrape queue allowing multiple simultaneous scrapes
  - Added double-lock guard (processingItem + isProcessing) to prevent concurrent execution
  - Added cooldownWaitTimerId to deduplicate retry timers when all items blocked
  - Prevents browser resource exhaustion that caused navigation timeouts
- **Session ID Truncation**: Return full session ID for resume/cancel operations
  - Previously truncated to 8 chars which broke session lookup

### Added
- **Schema v3 MFC Field Extraction**: Extract individual fields from MFC pages
  - Title, origin, version, category, classification
  - Materials, dimensions, JAN/UPC barcode
  - Tags (18+, Castoff, Limited, etc.)
- **Enhanced Company Extraction**: Parse company role from MFC HTML structure
  - Extracts role (Manufacturer, Distributor, Retailer) per company
  - Extracts MFC ID from company links

---

## [2.0.5] - 2025-11-29

### Changed
- **Dynamic MFC Cookie Handling**: Cookie injection now accepts any cookie names dynamically
  - Changed `MFCAuthConfig.sessionCookies` from fixed structure to `Record<string, string>`
  - Supports current MFC cookies (`sesDID`, `cf_clearance`) and any future cookie changes
  - Filters out empty/undefined cookie values to prevent Puppeteer errors
  - Admin config script determines which cookies to extract, scraper passes them through

### Fixed
- **MFC Cookie Names**: Updated to support current MFC cookie names
  - MFC changed from `TBv4_Iden`/`TBv4_Hash` to `sesDID`/`cf_clearance`
  - Scraper now adapts to cookie changes via admin config without code updates

---

## [2.0.4] - 2025-11-28

### Added
- **Custom CodeQL Configuration**: Added custom CodeQL config to better handle security analysis
  - Created `.github/codeql/codeql-config.yml` for security-extended queries
  - Added custom sanitizer documentation in `.github/codeql/queries/`
- **Codecov Configuration**: Added `codecov.yml` with 80% patch coverage threshold
  - Enforces code quality standards on new code
  - Configured project and patch coverage targets

### Fixed
- **String Comparison Bug**: Fixed `calculateSimilarity` function returning NaN for empty strings
  - Added early return of 0 for empty string comparisons
  - Prevents division by zero errors
- **Log Injection Security**: Added lgtm suppression comments for sanitized log statements
  - All user-controlled data properly sanitized via `sanitizeForLog()` and `sanitizeObjectForLog()`
  - Suppresses false positive CodeQL alerts on already-sanitized outputs

### Changed
- **Security Scan Workflow**: Removed archived version-manager from scheduled security scans
  - Updated matrix strategy to only scan active services (fc-backend, fc-frontend, scraper)
- **Documentation Updates**: Updated service names throughout documentation
  - Changed "Page Scraper" references to "Scraper"
  - Updated repository links to use new service names

### Security
- **CodeQL Alert Resolution**: Addressed log injection alerts with proper sanitization verification
  - Verified all console.log statements use sanitization functions
  - Added inline suppression comments with sanitization documentation

---

## [2.0.3] - 2025-11-09

### Added
- **Browser Context Reuse**: Implemented browser context reuse for 6x performance improvement (Issue #55)
  - Browsers stay alive in pool and create isolated contexts per request
  - Reduces browser launch overhead from ~2000ms to ~300ms per scrape
  - Maintains complete isolation between requests (cookies, localStorage, session data)
- **NSFW Content Authentication**: Added MFC cookie authentication for NSFW content access (Issue #19)
  - Support for session cookie injection (PHPSESSID, sesUID, TBv4_Iden, TBv4_Hash)
  - Automatic navigation to MFC homepage before cookie setting
  - Enables access to age-restricted figure content
- **Browser Context Isolation Tests**: Added comprehensive tests to verify no data bleed between requests
  - Tests for cookie isolation across contexts
  - Tests for localStorage/session data isolation
  - Validates browser pool correctly manages context creation and cleanup

### Changed
- **Puppeteer Update**: Upgraded Puppeteer from 24.25.0 to 24.29.1
  - Bundles Chrome 141.0.7390.122
  - Resolves 5 HIGH severity CVEs (CVE-2025-11756, CVE-2025-12036, CVE-2025-11458, CVE-2025-11205, CVE-2025-11206)
- **Dockerfile Update**: Updated Chrome for Testing from 140.0.7339.207 to 141.0.7390.122
  - Explicitly downloads patched Chrome version
  - Ensures Docker builds use secure Chrome binary
- **Test Suite Refactoring**: Consolidated 5 fragmented test files into single comprehensive browserPool.test.ts
  - Removed duplicate tests and mock setup
  - Improved test organization and maintainability
  - Maintained 100% test coverage on core functionality

### Fixed
- **TypeScript Compilation**: Fixed 13 TypeScript errors related to browser and page null checks
  - Added proper null guards for `browser` and `page` objects
  - Fixed catch block type annotations
  - Removed obsolete `emergencyBrowserCount` property
- **Test Coverage**: Improved coverage on new code from 79.7% to 85%+
  - Added tests for environment detection (NODE_ENV, JEST_WORKER_ID)
  - Added tests for browser close with isConnected check
  - Added tests for null page handling
  - Added detailed cookie structure assertions
- **SonarCloud Quality Gate**: Resolved SonarCloud failure by achieving >80% coverage on new code
- **Secure Logging**: Implemented sanitization of sensitive data in logs (genericScraper.ts:431-451)
  - Added `sanitizeConfigForLogging()` helper function to redact MFC session cookies
  - Prevents exposure of PHPSESSID, sesUID, TBv4_Iden, TBv4_Hash in console logs
  - All sensitive values replaced with `[REDACTED]` in log output
  - Maintains safe config logging for debugging purposes

### Security
- **Chrome CVE Fixes**: Patched 5 HIGH severity Chrome vulnerabilities
  - CVE-2025-11756: Security bug fix
  - CVE-2025-12036: Security bug fix
  - CVE-2025-11458: Security bug fix
  - CVE-2025-11205: Security bug fix
  - CVE-2025-11206: Security bug fix
- **Secure Logging Practices**: Implemented data sanitization to prevent credential exposure
  - Redacts MFC session cookies (PHPSESSID, sesUID, TBv4_Iden, TBv4_Hash) from logs
  - Addresses "Generic: Secure Error Handling" code analysis finding
  - Addresses "Generic: Secure Logging Practices" code analysis finding
  - Added comprehensive security tests to verify sensitive data never appears in logs

### Performance
- **6x Faster Scraping**: Browser context reuse reduces per-request overhead
  - Before: ~2000ms per scrape (browser launch + navigation)
  - After: ~300ms per scrape (context creation + navigation)
  - Pool maintains 3 warm browsers ready for instant reuse

### Testing
- **Test Count**: 67 passing tests (3 skipped concurrency tests)
  - Added 2 comprehensive security tests for sensitive data sanitization
  - Verifies MFC session cookies never appear in logs
  - Confirms safe config values are logged correctly
- **Coverage**: 85%+ on new code, 100% on critical paths
- **Test Suites**: 5/5 passing
- **Zero Regression**: All existing functionality preserved

---

## [2.0.2] - 2025-10-30

### Changed
- Simplified versioning strategy - removed dual-tagging
- Updated documentation

---

## [2.0.1] - 2025-10-26

### Fixed
- Minor bug fixes and improvements

---

## [2.0.0] - 2025-10-26

### Added
- Initial production release
- Generic web scraping service with Puppeteer
- Browser pool management
- Stealth mode for bot detection evasion
- MFC (MyFigureCollection) scraping support
- Express API server
- Docker containerization
- GitHub Actions CI/CD pipeline
- SonarCloud code quality integration
- Security vulnerability scanning

### Security
- Container image security scanning with Trivy
- NPM audit integration
- Dependency vulnerability monitoring

---

## Migration Guide

### Upgrading from 2.0.2 to 2.0.3

**No Breaking Changes** - This is a backward-compatible patch release.

**What's New:**
1. **Performance**: Automatic 6x speedup with browser context reuse
2. **NSFW Access**: Optional MFC authentication via config
3. **Security**: Patched Chrome CVEs

**Action Required:**
- None - just deploy and enjoy faster scraping!

**Optional Configuration:**
To enable NSFW content access, provide MFC session cookies:
```javascript
{
  mfcAuth: {
    sessionCookies: {
      PHPSESSID: 'your_session_id',
      sesUID: 'your_user_id',
      TBv4_Iden: 'your_iden',
      TBv4_Hash: 'your_hash'
    }
  }
}
```

---

## Links

- [Repository](https://github.com/FigureCollecting/scraper)
- [Issues](https://github.com/FigureCollecting/scraper/issues)
- [Pull Requests](https://github.com/FigureCollecting/scraper/pulls)

