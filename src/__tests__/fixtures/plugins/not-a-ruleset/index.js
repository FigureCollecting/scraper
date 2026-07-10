/**
 * Fixture: an ordinary package with NO "scraper-ruleset" keyword. This file
 * throws if it is ever imported, so pluginLoader.test.ts can prove the
 * loader filters on the keyword before importing anything.
 */
throw new Error('not-a-ruleset should never be imported by the plugin loader');
