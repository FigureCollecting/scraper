import fs from 'fs';
import path from 'path';

/**
 * GHSA-vfj7-8cjw-p6xm (CVE-2026-93687, HIGH): braces <= 3.0.3 overflows the stack on deeply nested
 * patterns, and no braces release fixes it. It reached the shipped image only through patch-package
 * (find-yarn-workspace-root -> micromatch -> braces), a runtime dependency that has had nothing to
 * apply since the last patch went with puppeteer-extra. So the fix is to drop the path, not to
 * ignore the finding. These checks lapse on their own once a braces release above 3.0.3 exists.
 */
const AFFECTED_UP_TO = [3, 0, 3];

function isAffected(version: string): boolean {
  const parts = version.split('-')[0].split('.').map(Number);
  for (let i = 0; i < AFFECTED_UP_TO.length; i++) {
    if (parts[i] !== AFFECTED_UP_TO[i]) return parts[i] < AFFECTED_UP_TO[i];
  }
  return true;
}

describe('braces advisory GHSA-vfj7-8cjw-p6xm', () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
  const lockedBraces = Object.entries(lock.packages as Record<string, { version: string; dev?: boolean }>)
    .filter(([location]) => location === 'node_modules/braces' || location.endsWith('/node_modules/braces'));

  it('reads the affected range as <= 3.0.3', () => {
    expect(['1.8.5', '2.3.2', '3.0.2', '3.0.3'].map(isAffected)).toEqual([true, true, true, true]);
    expect(['3.0.4', '3.1.0', '4.0.0', '3.0.4-rc.1'].map(isAffected)).toEqual([false, false, false, false]);
  });

  it('declares no patch-package and runs no postinstall that needs it', () => {
    const declared = { ...pkg.dependencies, ...pkg.devDependencies };

    expect(Object.keys(declared)).not.toContain('patch-package');
    expect(pkg.scripts?.postinstall ?? '').not.toMatch(/patch-package/);
  });

  it('installs no affected braces in the production tree (npm ci --omit=dev)', () => {
    const shipped = lockedBraces.filter(([, entry]) => !entry.dev && isAffected(entry.version));

    expect(shipped.map(([location, entry]) => `${location}@${entry.version}`)).toEqual([]);
  });
});
