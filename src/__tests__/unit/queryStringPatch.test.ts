/**
 * decode-uri-component 0.5.1 (GHSA-qr28-fpjm-wq7f, quadratic DoS on malformed percent runs).
 *
 * package.json overrides decode-uri-component to 0.5.1, which is ESM-only, so query-string 7's
 * require() gets the module namespace and parse() throws "decodeComponent is not a function".
 * tools/patch-query-string.mjs rewrites that one require to take `.default` after every `npm ci`
 * (Dockerfile stages and CI). The only dependent is minio -> query-string 7.1.3. Offline: file
 * reads, temp fixtures and child node processes only. Drop the override and the script once minio
 * stops pulling query-string 7.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PATCH = path.join(ROOT, 'tools', 'patch-query-string.mjs');
const DUC = 'decode-uri-component';
const QS = 'query-string';
const LINE_FROM = `const decodeComponent = require('${DUC}');`;
const LINE_TO = `const decodeComponent = require('${DUC}').default;`;

const readJson = (rel: string) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));
const installedIndex = () => readFileSync(path.join(ROOT, 'node_modules', QS, 'index.js'), 'utf8');
const count = (s: string, sub: string) => s.split(sub).length - 1;

/** Run `node -e script` in the app root (plain node, outside jest's module system). */
function nodeEval(script: string) {
  const r = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8' });
  return { rc: r.status, out: `${r.stdout}${r.stderr}`.trim() };
}

describe('decode-uri-component 0.5.1 override and the query-string require patch', () => {
  describe('the lockfile and package.json', () => {
    it('overrides decode-uri-component to exactly 0.5.1', () => {
      expect(readJson('package.json').overrides[DUC]).toBe('0.5.1');
    });

    it('locks one copy of decode-uri-component, at 0.5.1, needed only by query-string', () => {
      const lock = readJson('package-lock.json') as { packages: Record<string, { version?: string; dependencies?: Record<string, string> }> };
      const copies = Object.keys(lock.packages).filter((k) => k.endsWith(`node_modules/${DUC}`));
      expect(copies).toEqual([`node_modules/${DUC}`]);
      expect(lock.packages[copies[0]].version).toBe('0.5.1');
      const dependents = Object.entries(lock.packages)
        .filter(([, p]) => p.dependencies !== undefined && DUC in p.dependencies)
        .map(([k]) => k);
      expect(dependents).toEqual([`node_modules/${QS}`]);
    });

    it('has no scanner ignore for the advisory (it is fixed, not ignored)', () => {
      for (const f of ['.grype.yaml', '.trivyignore']) {
        const live = readFileSync(path.join(ROOT, f), 'utf8')
          .split('\n')
          .filter((l) => !/^\s*#/.test(l))
          .join('\n');
        expect(live).not.toMatch(/GHSA-qr28-fpjm-wq7f|CVE-2026-118664|decode-uri-component|query-string/);
      }
    });
  });

  describe('the installed tree (after npm ci and the patch script)', () => {
    it('installs decode-uri-component 0.5.1 as an ES module', () => {
      const pkg = readJson(`node_modules/${DUC}/package.json`);
      expect(pkg.version).toBe('0.5.1');
      expect(pkg.type).toBe('module');
    });

    it('has query-string patched to take .default, with no unpatched require left', () => {
      const src = installedIndex();
      expect({ patched: count(src, LINE_TO), unpatched: count(src.replace(LINE_TO, ''), LINE_FROM) }).toEqual({ patched: 1, unpatched: 0 });
    });

    it('parses and stringifies under plain node, through the module minio loads', () => {
      const r = nodeEval(`
        const qs = require('${QS}');
        const s = qs.stringify({ a: 'x y/%', b: '名', c: ['1', '2'] });
        const p = qs.parse(s);
        const bad = qs.parse('bad=%E0%A4%A&q=' + '%'.repeat(2000));
        require('minio');
        console.log(JSON.stringify([s, p, bad.bad, bad.q.length]));
      `);
      expect(r.rc).toBe(0);
      expect(JSON.parse(r.out)).toEqual([
        'a=x%20y%2F%25&b=%E5%90%8D&c=1&c=2',
        { a: 'x y/%', b: '名', c: ['1', '2'] },
        '%E0%A4%A',
        2000,
      ]);
    });

    it('parses and stringifies inside jest (the path every minio unit test takes)', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const qs = require(QS) as typeof import('query-string');
      expect(qs.stringify({ a: 'x y', n: '名' })).toBe('a=x%20y&n=%E5%90%8D');
      expect(qs.parse('a=x%20y&n=%E5%90%8D&c=1&c=2')).toEqual({ a: 'x y', n: '名', c: ['1', '2'] });
      expect(qs.parse('q=' + '%'.repeat(2000)).q).toHaveLength(2000);
    });
  });

  describe('tools/patch-query-string.mjs on fixtures', () => {
    let tmp: string;
    beforeAll(() => { tmp = mkdtempSync(path.join(os.tmpdir(), 'scraper-qs-patch-')); });
    afterAll(() => rmSync(tmp, { recursive: true, force: true }));

    /** A fixture app root: query-string with the given index.js, a decoder, the other deps linked. */
    function fixture(label: string, indexJs: string | null, decoder?: { pkg: object; index: string }) {
      const app = path.join(tmp, label);
      const nm = path.join(app, 'node_modules');
      mkdirSync(nm, { recursive: true });
      writeFileSync(path.join(app, 'package.json'), '{"name":"fixture","private":true}\n');
      const realNm = path.join(ROOT, 'node_modules');
      if (indexJs !== null) {
        mkdirSync(path.join(nm, QS));
        cpSync(path.join(realNm, QS, 'package.json'), path.join(nm, QS, 'package.json'));
        writeFileSync(path.join(nm, QS, 'index.js'), indexJs);
        const deps = Object.keys(readJson(`node_modules/${QS}/package.json`).dependencies as Record<string, string>);
        for (const d of deps.filter((x) => x !== DUC)) symlinkSync(path.join(realNm, d), path.join(nm, d), 'dir');
      }
      if (decoder) {
        mkdirSync(path.join(nm, DUC));
        writeFileSync(path.join(nm, DUC, 'package.json'), JSON.stringify(decoder.pkg));
        writeFileSync(path.join(nm, DUC, 'index.js'), decoder.index);
      } else {
        symlinkSync(path.join(realNm, DUC), path.join(nm, DUC), 'dir');
      }
      const file = path.join(nm, QS, 'index.js');
      const run = () => {
        const r = spawnSync(process.execPath, [PATCH, app], { encoding: 'utf8' });
        return { rc: r.status, out: `${r.stdout}${r.stderr}`, after: indexJs === null ? null : readFileSync(file, 'utf8') };
      };
      return { app, run };
    }

    // The unpatched query-string index.js: the installed one with the patch undone.
    const pristine = () => installedIndex().replace(LINE_TO, LINE_FROM);

    it('rewrites the one expected require and nothing else', () => {
      const orig = pristine();
      const r = fixture('one', orig).run();
      expect(r.rc).toBe(0);
      expect(r.after).toBe(orig.replace(LINE_FROM, LINE_TO));
    });

    it('fails on a second run, leaving the file as it was (no silent no-op)', () => {
      const f = fixture('twice', pristine());
      expect(f.run().rc).toBe(0);
      const second = f.run();
      expect(second.rc).toBe(1);
      expect(second.out).toMatch(/patch-query-string: expected exactly 1 occurrence .* found 0/);
      expect(second.after).toBe(pristine().replace(LINE_FROM, LINE_TO));
    });

    it('fails with the file untouched when the expected line is missing', () => {
      const r = fixture('missing', "'use strict';\nconst decodeComponent = require('other');\n").run();
      expect(r.rc).toBe(1);
      expect(r.out).toMatch(/found 0/);
      expect(r.after).toBe("'use strict';\nconst decodeComponent = require('other');\n");
    });

    it('fails with the file untouched when the expected line occurs twice', () => {
      const twice = `${LINE_FROM}\n${LINE_FROM}\n`;
      const r = fixture('dup', twice).run();
      expect(r.rc).toBe(1);
      expect(r.out).toMatch(/found 2/);
      expect(r.after).toBe(twice);
    });

    it('fails when query-string is not installed', () => {
      const r = fixture('absent', null).run();
      expect(r.rc).toBe(1);
      expect(r.out).toMatch(/cannot read .*query-string/);
    });

    it('restores the file when the decoder is CommonJS (a future upstream drift: .default is undefined)', () => {
      const orig = pristine();
      const r = fixture('cjs', orig, {
        pkg: { name: DUC, version: '9.9.9', main: 'index.js' },
        index: 'module.exports = (s) => decodeURIComponent(s);\n',
      }).run();
      expect(r.rc).toBe(1);
      expect(r.out).toMatch(/self-check failed/);
      expect(r.after).toBe(orig);
    });

    it('restores the file when the decoder decodes wrongly', () => {
      const orig = pristine();
      const r = fixture('wrong', orig, {
        pkg: { name: DUC, version: '9.9.9', main: 'index.js' },
        index: 'module.exports = { default: (s) => s.toUpperCase() };\n',
      }).run();
      expect(r.rc).toBe(1);
      expect(r.out).toMatch(/self-check failed/);
      expect(r.after).toBe(orig);
    });

    it('defaults the app root to the cwd', () => {
      const f = fixture('cwd', pristine());
      const r = spawnSync(process.execPath, [PATCH], { cwd: f.app, encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(existsSync(path.join(f.app, 'node_modules', QS, 'index.js'))).toBe(true);
    });
  });

  describe('documentation', () => {
    const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const header = readFileSync(PATCH, 'utf8').split('\n').slice(0, 12).join('\n');

    it('tells every README install step to run the patch', () => {
      const installs = count(readme, '```bash\n# Install dependencies\nnpm install\n');
      expect(installs).toBeGreaterThan(0);
      expect(count(readme, 'npm install\nnode tools/patch-query-string.mjs')).toBe(installs);
    });

    it('names the development stage and a test file that exists', () => {
      expect(header).toMatch(/development/);
      const named = header.match(/src\/[\w/.-]+\.test\.ts/g) ?? [];
      expect(named.length).toBeGreaterThan(0);
      for (const f of named) expect(existsSync(path.join(ROOT, f))).toBe(true);
    });
  });
});
