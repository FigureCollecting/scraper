// patch-query-string.mjs — run once after every `npm ci` or `npm install` (Dockerfile development,
// test, builder and production stages, CI, local setup). Usage: node tools/patch-query-string.mjs [app-root]   (default: the cwd)
// package.json overrides decode-uri-component to 0.5.1 (GHSA-qr28-fpjm-wq7f), which is ESM-only:
// query-string 7's require() then returns the module namespace and parse throws "decodeComponent
// is not a function". This rewrites that one require to take .default. It fails loudly (exit 1,
// file untouched) unless the expected line occurs exactly once, and after writing it parses and
// stringifies through the patched module, restoring the original file if that fails. Drop it
// with the override once minio stops pulling query-string 7 (src/__tests__/unit/queryStringPatch.test.ts).
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const FROM = "const decodeComponent = require('decode-uri-component');";
const TO = "const decodeComponent = require('decode-uri-component').default;";

const fail = (msg) => { console.error(`patch-query-string: ${msg}`); process.exit(1); };

const root = path.resolve(process.argv[2] ?? '.');
const file = path.join(root, 'node_modules', 'query-string', 'index.js');
let src;
try { src = readFileSync(file, 'utf8'); } catch (e) { fail(`cannot read ${file}: ${e.message}`); }
const n = src.split(FROM).length - 1;
if (n !== 1) fail(`expected exactly 1 occurrence of ${JSON.stringify(FROM)} in ${file}, found ${n}`);
writeFileSync(file, src.replace(FROM, TO));

try {
  const qs = createRequire(path.join(root, 'package.json'))('query-string');
  const got = JSON.stringify(qs.parse(qs.stringify({ a: 'x y/%', b: '名' })));
  if (got !== '{"a":"x y/%","b":"名"}') throw new Error(`round trip gave ${got}`);
} catch (e) {
  writeFileSync(file, src);
  fail(`self-check failed, ${file} restored: ${e.message}`);
}
console.log(`patch-query-string: ${file} now takes decode-uri-component's .default`);
