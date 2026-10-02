/**
 * No engine file names a hands-off site, a denied host or an AI agent token (hands-off plan v2,
 * unit C1). Which hosts are off limits, and why, is ruleset DATA: the rulesets plugin registers it
 * through the plugin contract (registerHandsOffPolicy / registerRobotsClassifier) and the engine
 * only indexes and looks it up. So the names below may appear in tests, never in engine source.
 *
 * The engine predates that rule: the files in BASELINE named these hosts before the plan (comments
 * that record where a behaviour was measured, plus a few code paths such as the session canary).
 * They are frozen here at their 2026-10-02 counts (develop 26c145a8). The list may only shrink: a
 * file outside it that names one, or a baseline file that names more, fails.
 */
import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SCANNED_ROOTS = ['src', 'packages/plugin-contract/src'];

/** The hands-off hosts of the static list (R0) and the permanently denied host, as name stems. */
const HOST_NAMES = ['myfigurecollection', 'suruga-ya', 'hobby-genki', 'vndb', 'hpoi', 'otakumode'];
/** AI agent tokens a robots.txt names; the classifier that reads them lives in the plugin. */
const AI_TOKENS = [
  'claudebot', 'claude-user', 'claude-searchbot', 'claude-web', 'anthropic-ai',
  'gptbot', 'chatgpt-user', 'oai-searchbot', 'perplexitybot', 'perplexity-user',
  'ccbot', 'google-extended', 'bytespider', 'applebot-extended', 'meta-externalagent',
  'amazonbot', 'cohere-ai',
];
const NAMES = new RegExp([...HOST_NAMES, ...AI_TOKENS].map(n => n.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('|'), 'gi');

const BASELINE: Readonly<Record<string, number>> = {
  'packages/plugin-contract/src/index.ts': 1,
  'src/crawler/crawler.ts': 1,
  'src/crawler/ledger.ts': 1,
  'src/services/browserChallenge.ts': 2,
  'src/services/captureSink.ts': 1,
  'src/services/engineServices/challengeDetect.ts': 1,
  'src/services/engineServices/extractContext.ts': 2,
  'src/services/engineServices/extractRecords.ts': 1,
  'src/services/engineServices/runtimeConfig.ts': 2,
  'src/services/gatedBrowsers.ts': 2,
  'src/services/genericScraper.ts': 5,
  'src/services/images/httpBytesFetch.ts': 1,
  'src/services/images/imageBytes.ts': 2,
  'src/services/images/imageHostPolicy.ts': 5,
  'src/services/recordFetchGate.ts': 4,
  'src/services/residentialEgress.ts': 1,
  'src/services/scrapeQueue.ts': 2,
  'src/services/sessionCanary.ts': 2,
};

/** Every engine source file (tests excluded) that names one, with its count. */
function scan(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const root of SCANNED_ROOTS) {
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, root), { recursive: true, encoding: 'utf8' })) {
      const rel = path.posix.join(root, entry.split(path.sep).join('/'));
      if (!rel.endsWith('.ts') || rel.split('/').includes('__tests__')) continue;
      const count = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').match(NAMES)?.length ?? 0;
      if (count > 0) found[rel] = count;
    }
  }
  return found;
}

describe('engine source names no hands-off site, denied host or AI token', () => {
  const found = scan();

  it('no file outside the pre-plan baseline names one', () => {
    const newcomers = Object.entries(found)
      .filter(([file]) => !(file in BASELINE))
      .map(([file, count]) => `${file}: ${count}`);

    expect(newcomers).toEqual([]);
  });

  it('no baseline file names more of them than before the plan (the list only shrinks)', () => {
    const grown = Object.entries(found)
      .filter(([file, count]) => file in BASELINE && count > BASELINE[file])
      .map(([file, count]) => `${file}: ${BASELINE[file]} -> ${count}`);

    expect(grown).toEqual([]);
  });

  it('the baseline is exact: a file that names fewer must lower its count here, so it cannot grow back', () => {
    const drifted = Object.entries(BASELINE)
      .filter(([file, count]) => (found[file] ?? 0) !== count)
      .map(([file, count]) => `${file}: ${count} -> ${found[file] ?? 0}`);

    expect(drifted).toEqual([]);
  });

  it('catches a hands-off or denied site named by its siteId, not only by its host', () => {
    const source = [
      "if (siteId === 'mfc') return;",
      'const id = "surugaya";',
      'const store = `vndb`;',
      "{ site: 'hpoi' }",
      "const BANNED = 'tom';",
      "case 'hobbygenki':",
      "siteId === 'hobby-genki'",
    ].join('\n');

    expect(source.match(NAMES)).toHaveLength(7);
  });

  it('does not count an identifier or a word that merely contains a short siteId', () => {
    expect('mfcSessionStale customfc tomorrow atom tom mfc "tomato" \'xmfc\''.match(NAMES)).toBeNull();
  });

  it('really reads the tree: a file known to name a host is found (an empty walk cannot pass)', () => {
    expect(found['src/services/sessionCanary.ts']).toBeGreaterThan(0);
    expect(found['packages/plugin-contract/src/index.ts']).toBeGreaterThan(0);
  });
});
