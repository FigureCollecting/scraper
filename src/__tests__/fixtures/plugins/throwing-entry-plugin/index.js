/**
 * Fixture: advertises the "scraper-ruleset" keyword, but its entry file throws as it is imported
 * (a broken build, a missing dependency). Used to prove the loader reports it as a failed candidate
 * and the bootstrap lists it as refused, instead of the engine coming up as if it were not installed.
 */
throw new Error('throwing-entry-plugin refuses to load');
