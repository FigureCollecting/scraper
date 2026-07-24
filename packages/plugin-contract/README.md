# @figurecollecting/scraper-plugin-contract

Single source of truth for the contract between the scraper engine and its
ruleset plugin packages: the `ScraperPlugin` interface family (registry,
context, engine services, site config, extraction types) plus the
`isScraperPlugin` runtime guard the plugin loader uses to validate modules.

The engine consumes this package in-repo via a `file:` dependency; plugin
packages consume the published version from GitHub Packages:

```
npm install @figurecollecting/scraper-plugin-contract
```

with an `.npmrc` scoping `@figurecollecting` to `https://npm.pkg.github.com`.

The package is types-plus-one-guard only — no engine runtime code. It compiles
to CommonJS with type declarations, so it is importable from both CJS and ESM
consumers. Publishing happens from CI (`publish-plugin-contract.yml`) when the
package changes on `develop`; npm versions are immutable, so bump `version`
here to release.
