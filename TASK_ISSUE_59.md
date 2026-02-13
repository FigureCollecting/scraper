# Task Delegation: Issue #59 - Browser Context Reuse + Cookie Auth

**FROM**: Master Orchestrator
**TO**: Page-Scraper Service Orchestrator
**ISSUE**: https://github.com/FigureCollecting/scraper/issues/59
**BRANCH**: feature/browser-context-reuse-v2.1.0 (created)
**TARGET**: scraper v2.1.0

---

## 🎯 Task Overview

Implement browser context reuse and cookie-based NSFW authentication using **vanilla Puppeteer** (no stealth plugin).

**Resolves**:
- Issue #55 - Browser session reuse beyond a single fetch
- Issue #19 - MFC authentication for NSFW content access

**Supersedes**: PR #57 (closed - stealth plugin approach abandoned)

---

## 📋 Detailed Requirements

### **Phase 1: Browser Context Reuse (Issue #55)**

#### **Problem Identified**:
```typescript
// File: src/services/genericScraper.ts
// Line 638 (CURRENT CODE):
finally {
  await page.close();
  await browser.close(); // ❌ CRITICAL BUG: Closes browser permanently!
}
```

**Impact**:
- Defeats browser pool purpose
- 3s launch time per request
- Cloudflare re-fingerprinting on each request
- Browser pool never replenishes

#### **Solution Required**:
```typescript
// Replace browser management with context management:
const context = await browser.createBrowserContext();
try {
  const page = await context.newPage();
  // ... existing scraping logic ...
} finally {
  await context.close(); // ✅ Only closes context, browser stays alive!
}
```

**Benefits**:
- 6x performance improvement (3s → 500ms)
- Browser pool actually works
- No re-fingerprinting

---

### **Phase 2: Cookie Authentication (Issue #19)**

#### **Problem**:
- NSFW/NSFW+ figures return 403 without authentication
- ~20-30% of MFC catalog inaccessible

#### **Solution**:
```typescript
// Add cookie injection before navigation
const MFC_COOKIES = {
  PHPSESSID: process.env.MFC_SESSION_ID,
  sesUID: process.env.MFC_USER_ID,
  TBv4_Iden: process.env.MFC_USER_ID,
  TBv4_Hash: process.env.MFC_SESSION_HASH
};

// Apply cookies to page
await page.setCookie(
  ...Object.entries(MFC_COOKIES).map(([name, value]) => ({
    name,
    value,
    domain: '.myfigurecollection.net'
  }))
);
```

**Manual Testing Results**: ✅
- Cookie auth works with vanilla Puppeteer
- NSFW access successful (item/422432 tested)
- No stealth plugin needed

---

## 🔬 TDD Requirements (MANDATORY)

### **Test 1: Browser Context Reuse**

#### Step 1 - Write Failing Test:
```typescript
// File: src/__tests__/unit/browserPool.test.ts
// Add new test:

it('should reuse browser instances via contexts (not close browsers)', async () => {
  const mockContext = {
    newPage: jest.fn().mockResolvedValue(mockPage),
    close: jest.fn(),
    pages: jest.fn().mockReturnValue([]),
  };
  mockBrowser.createBrowserContext = jest.fn().mockResolvedValue(mockContext);

  // Scrape two URLs
  await scrapeGeneric('https://example.com/page1', {});
  await scrapeGeneric('https://example.com/page2', {});

  // Verify behavior
  expect(mockBrowser.createBrowserContext).toHaveBeenCalledTimes(2);
  expect(mockContext.close).toHaveBeenCalledTimes(2);
  expect(mockBrowser.close).not.toHaveBeenCalled(); // ✅ Browser stays alive!
});
```

#### Step 2 - Run Test (MUST FAIL):
```bash
npm test -- --testNamePattern="should reuse browser instances"
# Expected: FAIL (browser.close() is currently called)
```

#### Step 3 - Implement Fix:
```typescript
// File: src/services/genericScraper.ts
// Modify the scraping function (around line 638):

// BEFORE:
try {
  const page = await browser.newPage();
  // ... scraping ...
} finally {
  await page.close();
  await browser.close(); // ❌ Remove this!
}

// AFTER:
const context = await browser.createBrowserContext();
try {
  const page = await context.newPage();
  // ... scraping logic (no changes needed) ...
} finally {
  await context.close(); // ✅ Only close context
  // browser stays alive for pool reuse
}
```

#### Step 4 - Verify Test Passes:
```bash
npm test -- --testNamePattern="should reuse browser instances"
# Expected: PASS
```

#### Step 5 - Verify Zero Regression:
```bash
npm test
# Expected: 220/220 tests passing
```

---

### **Test 2: Cookie Authentication**

#### Step 1 - Write Failing Test:
```typescript
// File: src/__tests__/integration/mfcAuthentication.test.ts
// Create new test file:

import { scrapeGeneric } from '../../services/genericScraper';

describe('MFC Cookie Authentication', () => {
  const NSFW_TEST_URL = 'https://myfigurecollection.net/item/422432';

  beforeAll(() => {
    // Set test cookies
    process.env.MFC_SESSION_ID = 'test_session';
    process.env.MFC_USER_ID = 'test_user';
    process.env.MFC_SESSION_HASH = 'test_hash';
  });

  it('should inject cookies for authenticated MFC requests', async () => {
    const result = await scrapeGeneric(NSFW_TEST_URL, {
      authenticated: true
    });

    // Verify cookies were set
    expect(mockPage.setCookie).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'PHPSESSID' }),
      expect.objectContaining({ name: 'sesUID' }),
      expect.objectContaining({ name: 'TBv4_Iden' }),
      expect.objectContaining({ name: 'TBv4_Hash' })
    );

    // Verify successful scrape (not redirected to login)
    expect(result).toBeDefined();
    expect(mockPage.url()).not.toContain('/session/login');
  });

  it('should skip authentication for non-MFC URLs', async () => {
    await scrapeGeneric('https://example.com', { authenticated: false });
    expect(mockPage.setCookie).not.toHaveBeenCalled();
  });
});
```

#### Step 2 - Run Test (MUST FAIL):
```bash
npm test -- mfcAuthentication.test.ts
# Expected: FAIL (cookie injection not implemented)
```

#### Step 3 - Implement Cookie Injection:
```typescript
// File: src/services/genericScraper.ts
// Add cookie injection logic:

async function scrapeGeneric(url: string, options: ScrapeOptions = {}) {
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();

    // Inject cookies if authenticated MFC request
    if (options.authenticated && url.includes('myfigurecollection.net')) {
      const mfcCookies = {
        PHPSESSID: process.env.MFC_SESSION_ID,
        sesUID: process.env.MFC_USER_ID,
        TBv4_Iden: process.env.MFC_USER_ID,
        TBv4_Hash: process.env.MFC_SESSION_HASH
      };

      await page.setCookie(
        ...Object.entries(mfcCookies)
          .filter(([, value]) => value) // Only set if env var exists
          .map(([name, value]) => ({
            name,
            value,
            domain: '.myfigurecollection.net',
            path: '/',
            httpOnly: false,
            secure: true
          }))
      );
    }

    // Continue with normal scraping...
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    // ... rest of scraping logic ...

  } finally {
    await context.close();
  }
}
```

#### Step 4 - Verify Test Passes:
```bash
npm test -- mfcAuthentication.test.ts
# Expected: PASS
```

#### Step 5 - Verify Zero Regression:
```bash
npm test
# Expected: All tests passing (220+2 new tests = 222 total)
```

---

## ✅ Acceptance Criteria

### **Code Quality**:
- [ ] TDD sequence followed with evidence (failing → passing)
- [ ] Coverage ≥85% on affected lines
- [ ] All 220+ tests passing (zero regression)
- [ ] No stealth plugin dependencies
- [ ] Commit messages: 1-2 lines, no attributions

### **Functionality**:
- [ ] Browser contexts reused (browser.close() removed)
- [ ] Performance: <500ms per scrape (warm browser)
- [ ] Cookie injection works for MFC URLs
- [ ] NSFW content accessible with proper cookies
- [ ] Non-MFC URLs unaffected

### **Evidence Required**:
- [ ] Git diff showing exact changes
- [ ] Test output: failing test before implementation
- [ ] Test output: passing test after implementation
- [ ] Coverage report for affected files
- [ ] Full test suite output (all passing)

---

## 🚫 Scope Boundaries

### **IN SCOPE**:
- ✅ Change line 638 from `browser.close()` to context management
- ✅ Add cookie injection for MFC authenticated requests
- ✅ Write 2 new tests (browser context + cookie auth)
- ✅ Update mocks for `createBrowserContext`
- ✅ Add environment variable configuration

### **OUT OF SCOPE** (Do NOT implement):
- ❌ Stealth plugin or puppeteer-extra
- ❌ OAuth flow or programmatic login
- ❌ CAPTCHA solving
- ❌ Refactoring unrelated code
- ❌ Adding new scraper features
- ❌ Changing extraction logic

---

## 📊 Verification Checklist

Before reporting back to Master Orchestrator, verify:

1. **TDD Evidence**:
   ```bash
   # Show failing test
   git add src/__tests__/unit/browserPool.test.ts
   npm test -- --testNamePattern="should reuse browser instances"
   # Screenshot/paste output showing FAIL

   # Implement fix
   git add src/services/genericScraper.ts

   # Show passing test
   npm test -- --testNamePattern="should reuse browser instances"
   # Screenshot/paste output showing PASS
   ```

2. **Coverage Verification**:
   ```bash
   npm run test:coverage
   grep -A5 "genericScraper.ts" coverage/lcov-report/index.html
   # Verify ≥85% on modified lines
   ```

3. **Zero Regression**:
   ```bash
   npm test
   # Expected: 222/222 passing (220 existing + 2 new)
   ```

4. **Git Status**:
   ```bash
   git diff --stat
   git log -1 --pretty=format:"%s%n%b"
   # Verify clean commit message
   ```

---

## 📝 Expected Deliverables

### **Files to Modify**:
1. `src/services/genericScraper.ts` - Browser context + cookie injection
2. `src/__tests__/unit/browserPool.test.ts` - Browser context test
3. `src/__tests__/integration/mfcAuthentication.test.ts` - Cookie auth test (new file)
4. `src/__tests__/__mocks__/puppeteer.ts` - Add createBrowserContext mock (if needed)
5. `README.md` - Document MFC cookie environment variables

### **Expected Commits**:
```
Commit 1: "Add browser context reuse for pool efficiency"
Commit 2: "Add cookie authentication for MFC NSFW access"
```

---

## 🔗 Resources

- [Puppeteer Browser Contexts](https://pptr.dev/api/puppeteer.browser.createbrowsercontext)
- [Puppeteer Cookie Management](https://pptr.dev/api/puppeteer.page.setcookie)
- [Issue #59](https://github.com/FigureCollecting/scraper/issues/59)
- [Release Plan v2.1.0](/RELEASE_PLAN_v2.1.0.md)

---

## 📞 Questions?

If blocked, report immediately with:
- Specific blocker description
- Files/lines affected
- Attempted solutions
- Required decisions from Master Orchestrator

---

**Timeline**: 1-2 days
**Priority**: HIGH (blocks bulk import feature)
**Risk**: LOW (isolated change, well-tested approach)

**Ready to begin implementation. Follow TDD sequence strictly.**
