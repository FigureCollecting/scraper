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
    '^.+\\.(ts|tsx|mjs|js|cjs)$': ['ts-jest', {
      tsconfig: '<rootDir>/tsconfig.test.json',
      diagnostics: {
        warnOnly: true
      }
    }]
  },
  // MSW v2 ships ESM-only deps that jest does not transform by default; the
  // transform above handles js/mjs/cjs, and this whitelist lets those specific
  // packages through (everything else in node_modules stays untransformed).
  transformIgnorePatterns: [
    '/node_modules/(?!(msw|@mswjs|@open-draft|@bundled-es-modules|until-async|rettime|strict-event-emitter|headers-polyfill|outvariant|is-node-process|tough-cookie|graphql)/)'
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts',
    '!src/initiator/run.ts',  // process entrypoint (wiring only), like src/index.ts
    '!src/utils/logger.ts',
    '!src/__tests__/**',  // Exclude all test files and mocks
  ],
  coverageDirectory: 'coverage',
  coverageReporters: [
    'text',
    'lcov',
    'html'
  ],
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.ts'],
  testTimeout: 30000,
  maxWorkers: 4,
  forceExit: true, // Force Jest to exit after all tests complete

  // Enhanced Puppeteer Mocking + ESM-import resolution.
  // Source is now pure ESM (NodeNext): relative imports carry explicit `.js`
  // extensions. Tests still run through ts-jest's CommonJS transform (so
  // jest.mock hoisting keeps working), so we strip the trailing `.js` from
  // relative specifiers back to the `.ts` source. The puppeteer mock mapping
  // MUST stay first — moduleNameMapper is evaluated top-to-bottom.
  moduleNameMapper: {
    '^puppeteer$': '<rootDir>/src/__tests__/__mocks__/puppeteer.ts',
    '^@figurecollecting/scraper-plugin-contract$': '<rootDir>/packages/plugin-contract/src/index.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  
  // Comprehensive Mock Management
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,
  
  // Performance and Stability Enhancements
  bail: false, // Allow all test suites to run even if some fail
  verbose: true,
  

};