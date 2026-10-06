import fs from 'fs';
import path from 'path';

/**
 * Lockfile guards for advisories that fail the image and audit gates (grype pr-security-scan, Trivy,
 * npm audit), so an affected version coming back fails here too, with its lockfile location.
 *
 * - GHSA-vfj7-8cjw-p6xm (CVE-2026-93687, HIGH): braces <= 3.0.3 overflows the stack on deeply nested
 *   patterns, and no braces release fixes it. It reached the shipped image only through patch-package
 *   (find-yarn-workspace-root -> micromatch -> braces), a runtime dependency that has had nothing to
 *   apply since the last patch went with puppeteer-extra. So the fix is to drop the path, not to
 *   ignore the finding. The braces checks lapse on their own once a release above 3.0.3 exists.
 * - GHSA-jqcg-44mw-7w3h (CVE-2026-90711, CRITICAL): proxy-addr >= 1.1.0 < 2.0.8 trusts a spoofed
 *   IPv4-mapped IPv6 address. express pulls it in; the scraper never sets 'trust proxy', so it is not
 *   reachable here, but the gates fail on it, so the lockfile pins the fixed 2.0.8.
 */
type LockEntry = { name?: string; version: string; dev?: boolean };
type Lockfile = { packages: Record<string, LockEntry> };
type Advisory = { id: string; name: string; affects: (version: string) => boolean };

// Release parts compare as numbers; a prerelease sorts below its release (3.0.3-rc.1 < 3.0.3).
function compareVersions(a: string, b: string): number {
  const release = (version: string) => version.split('-')[0].split('.').map(Number);
  const [ra, rb] = [release(a), release(b)];
  for (let i = 0; i < 3; i++) {
    if (ra[i] !== rb[i]) return ra[i] - rb[i];
  }
  return Number(!a.includes('-')) - Number(!b.includes('-'));
}

const ADVISORIES: Advisory[] = [
  {
    id: 'GHSA-vfj7-8cjw-p6xm',
    name: 'braces',
    affects: (version) => compareVersions(version, '3.0.3') <= 0,
  },
  {
    id: 'GHSA-jqcg-44mw-7w3h',
    name: 'proxy-addr',
    affects: (version) => compareVersions(version, '1.1.0') >= 0 && compareVersions(version, '2.0.8') < 0,
  },
];

// Every installed copy of a package: top level, nested under another package or a workspace, and
// npm aliases (installed under another folder name; the lockfile records the real name).
function lockedCopies(lock: Lockfile, name: string): Array<[string, LockEntry]> {
  return Object.entries(lock.packages).filter(
    ([location, entry]) => (entry.name ?? location.split('node_modules/').pop()) === name,
  );
}

// `npm ci --omit=dev` (the production image) skips only entries flagged dev.
function affectedCopies(lock: Lockfile, advisory: Advisory, omitDev: boolean): string[] {
  return lockedCopies(lock, advisory.name)
    .filter(([, entry]) => !(omitDev && entry.dev) && advisory.affects(entry.version))
    .map(([location, entry]) => `${location}@${entry.version}`);
}

const [braces, proxyAddr] = ADVISORIES;

describe('lockfile advisory guard', () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const lock: Lockfile = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));

  describe('self-checks on fixtures', () => {
    it('reads the braces range as <= 3.0.3, prereleases included', () => {
      expect(['1.8.5', '2.3.2', '3.0.2', '3.0.3', '3.0.3-rc.1'].map(braces.affects)).toEqual([
        true, true, true, true, true,
      ]);
      expect(['3.0.4', '3.1.0', '4.0.0', '3.0.4-rc.1'].map(braces.affects)).toEqual([false, false, false, false]);
    });

    it('reads the proxy-addr range as >= 1.1.0 < 2.0.8, prereleases included', () => {
      expect(['1.1.0', '1.1.10', '2.0.7', '2.0.8-rc.1'].map(proxyAddr.affects)).toEqual([true, true, true, true]);
      expect(['1.0.10', '1.1.0-rc.1', '2.0.8', '2.0.10', '2.1.0', '3.0.0'].map(proxyAddr.affects)).toEqual([
        false, false, false, false, false, false,
      ]);
    });

    const fixture: Lockfile = {
      packages: {
        '': { name: 'scraper', version: '2.3.0' },
        'node_modules/braces': { version: '3.0.3' },
        'node_modules/micromatch/node_modules/braces': { version: '3.0.2', dev: true },
        'packages/plugin-contract/node_modules/braces': { version: '2.3.2' },
        'node_modules/br-alias': { name: 'braces', version: '3.0.3', dev: true },
        'node_modules/fill-range/node_modules/braces': { version: '3.0.4' },
        'node_modules/braces-utils': { version: '1.0.0' },
        'node_modules/@scope/braces': { version: '1.0.0' },
      },
    };

    it('finds every installed copy: top level, nested, under a workspace, and npm-aliased', () => {
      expect(lockedCopies(fixture, 'braces').map(([location]) => location)).toEqual([
        'node_modules/braces',
        'node_modules/micromatch/node_modules/braces',
        'packages/plugin-contract/node_modules/braces',
        'node_modules/br-alias',
        'node_modules/fill-range/node_modules/braces',
      ]);
    });

    it('reports only affected copies, and drops only dev copies from the production tree', () => {
      expect(affectedCopies(fixture, braces, true)).toEqual([
        'node_modules/braces@3.0.3',
        'packages/plugin-contract/node_modules/braces@2.3.2',
      ]);
      expect(affectedCopies(fixture, braces, false)).toEqual([
        'node_modules/braces@3.0.3',
        'node_modules/micromatch/node_modules/braces@3.0.2',
        'packages/plugin-contract/node_modules/braces@2.3.2',
        'node_modules/br-alias@3.0.3',
      ]);
    });
  });

  it('still finds the proxy-addr that express pulls in, so its checks are not vacuous', () => {
    expect(lockedCopies(lock, proxyAddr.name)).not.toHaveLength(0);
  });

  it('declares no patch-package and runs no postinstall that needs it', () => {
    const declared = { ...pkg.dependencies, ...pkg.devDependencies };

    expect(Object.keys(declared)).not.toContain('patch-package');
    expect(pkg.scripts?.postinstall ?? '').not.toMatch(/patch-package/);
  });

  describe.each(ADVISORIES.map((advisory) => [advisory.id, advisory] as const))('%s', (_id, advisory) => {
    it(`installs no affected ${advisory.name} in the production tree (npm ci --omit=dev)`, () => {
      expect(affectedCopies(lock, advisory, true)).toEqual([]);
    });

    it(`installs no affected ${advisory.name} in the dev tree either (the builder and dev images)`, () => {
      expect(affectedCopies(lock, advisory, false)).toEqual([]);
    });
  });
});
