import { isScraperPlugin } from '@figurecollecting/scraper-plugin-contract';

describe('isScraperPlugin', () => {
  it('accepts an object with only the required fields (name/version/register)', () => {
    expect(isScraperPlugin({ name: 'p', version: '1.0.0', register: async () => {} })).toBe(true);
  });

  it('accepts an object that also has valid optional registerRoutes/shutdown functions', () => {
    expect(
      isScraperPlugin({
        name: 'p',
        version: '1.0.0',
        register: async () => {},
        registerRoutes: () => {},
        shutdown: async () => {},
      })
    ).toBe(true);
  });

  it.each([null, undefined, 'a string', 42, true])('rejects a non-object value: %p', value => {
    expect(isScraperPlugin(value)).toBe(false);
  });

  it('rejects an object missing name', () => {
    expect(isScraperPlugin({ version: '1.0.0', register: async () => {} })).toBe(false);
  });

  it('rejects an object missing version', () => {
    expect(isScraperPlugin({ name: 'p', register: async () => {} })).toBe(false);
  });

  it('rejects an object missing register', () => {
    expect(isScraperPlugin({ name: 'p', version: '1.0.0' })).toBe(false);
  });

  it('rejects an object where register is not a function', () => {
    expect(isScraperPlugin({ name: 'p', version: '1.0.0', register: 'not-a-function' })).toBe(false);
  });

  it('rejects an object where registerRoutes is present but not a function', () => {
    expect(
      isScraperPlugin({ name: 'p', version: '1.0.0', register: async () => {}, registerRoutes: 'nope' })
    ).toBe(false);
  });

  it('rejects an object where shutdown is present but not a function', () => {
    expect(isScraperPlugin({ name: 'p', version: '1.0.0', register: async () => {}, shutdown: 'nope' })).toBe(false);
  });
});
