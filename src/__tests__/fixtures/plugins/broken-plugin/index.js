/**
 * Fixture: advertises the "scraper-ruleset" keyword but does NOT implement
 * the ScraperPlugin contract (no register function). Used to prove the
 * loader's type guard rejects malformed packages instead of crashing.
 */
module.exports = {
  name: 'broken-plugin',
  version: '1.0.0',
  // register intentionally omitted
};
