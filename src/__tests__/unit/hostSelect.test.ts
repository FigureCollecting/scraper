/**
 * hostSelect — the shared grammar of SCRAPE_HOST_CLOCK and SCRAPE_POOL_SELECT (plan-v3 QB-U30b (e),
 * design.pool_select_v1_1.scope): off | all | all,-host[,-host...] | host csv; malformed -> off + one
 * boot WARN. The host clock keeps QB-U30a's lenient host LIST ('ignore'); the pool knob is strict.
 */
import { hostSelected, isBareHostname, normalizeSelectHost, parseHostSelect, type HostSelectGrammar } from '../../services/hostSelect';

const MFC = 'myfigurecollection.net';
const CLOCK: HostSelectGrammar = { envName: 'SCRAPE_HOST_CLOCK', tag: '[HOST-CLOCK]', listEntries: 'ignore' };
const POOL: HostSelectGrammar = { envName: 'SCRAPE_POOL_SELECT', tag: '[POOL]', listEntries: 'strict' };

describe('normalizeSelectHost / isBareHostname', () => {
  it('folds case, trailing dots and a leading www.', () => {
    expect(normalizeSelectHost('  WWW.MyFigureCollection.Net.. ')).toBe(MFC);
    expect(normalizeSelectHost('static.myfigurecollection.net')).toBe('static.myfigurecollection.net');
  });

  it('accepts bare hostnames only', () => {
    expect(isBareHostname(MFC)).toBe(true);
    expect(isBareHostname('a-b.c1.d')).toBe(true);
    for (const bad of ['', '-x.com', 'x-.com', 'https://x.com', 'x.com/p', 'x.com:80', 'x..com', '+x.com']) {
      expect(isBareHostname(bad)).toBe(false);
    }
  });
});

describe.each([['clock', CLOCK], ['pool', POOL]] as const)('parseHostSelect (%s grammar)', (_name, grammar) => {
  it.each([undefined, '', '  ', 'off', 'OFF', ' Off ', ' , ,'])('reads %p as off, with no warning', raw => {
    const select = parseHostSelect(raw, grammar);
    expect(select).toEqual({ mode: 'off', hosts: [], excluded: [], warnings: [], malformed: false });
    expect(hostSelected(select, MFC)).toBe(false);
    expect(hostSelected(select, 'off')).toBe(false);
  });

  it.each(['all', 'ALL', ' all '])('reads %p as every host', raw => {
    const select = parseHostSelect(raw, grammar);
    expect(select.mode).toBe('all');
    expect(hostSelected(select, MFC)).toBe(true);
    expect(hostSelected(select, 'never-seen-at-boot.example')).toBe(true);
  });

  it("reads 'all,-host' as every host but those, a host first seen after boot included", () => {
    const select = parseHostSelect(' ALL , -WWW.MyFigureCollection.net. ,-hpoi.net,-hpoi.net', grammar);
    expect(select).toEqual({ mode: 'all-except', hosts: [], excluded: [MFC, 'hpoi.net'], warnings: [], malformed: false });
    expect(hostSelected(select, MFC)).toBe(false);
    expect(hostSelected(select, 'www.myfigurecollection.net')).toBe(false);
    expect(hostSelected(select, 'hpoi.net')).toBe(false);
    // Membership is answered per call: a host no list named at boot is in.
    expect(hostSelected(select, 'brand-new-store.example')).toBe(true);
    // A subdomain is a different host.
    expect(hostSelected(select, 'static.myfigurecollection.net')).toBe(true);
  });

  it('reads a host csv as exactly those hosts, normalised and deduplicated', () => {
    const select = parseHostSelect(' MyFigureCollection.net. , ,www.example.com,example.com', grammar);
    expect(select).toEqual({ mode: 'hosts', hosts: [MFC, 'example.com'], excluded: [], warnings: [], malformed: false });
    expect(hostSelected(select, 'WWW.example.com.')).toBe(true);
    expect(hostSelected(select, 'static.myfigurecollection.net')).toBe(false);
  });

  it.each([
    ['all,-', 'an empty "-" token'],
    ['all, - ,-x.com', 'an empty "-" token'],
    ['all,-https://x.com', '"-https://x.com" does not exclude a bare hostname'],
    ['all,-x.com:8080', '"-x.com:8080" does not exclude a bare hostname'],
    ['all,-x.com,y.com', '"all" mixes -host exclusions with listed hosts'],
    ['all,y.com,-x.com', '"all" mixes -host exclusions with listed hosts'],
  ])('a malformed exclusion %p selects nothing and warns once, naming the value', (raw, why) => {
    const select = parseHostSelect(raw, grammar);
    expect(select).toEqual({
      mode: 'off',
      hosts: [],
      excluded: [],
      warnings: [`${grammar.tag} WARN ${grammar.envName}="${raw.trim()}" is malformed (${why}); treated as off`],
      malformed: true,
    });
    expect(hostSelected(select, 'z.com')).toBe(false);
    expect(hostSelected(select, 'x.com')).toBe(false);
  });

  it('hostSelected on a malformed or off value is false for every host', () => {
    expect(hostSelected({ mode: 'off', hosts: [MFC], excluded: [], warnings: [], malformed: false }, MFC)).toBe(false);
  });
});

describe("'all' with blank tokens around it is not 'all' alone (closeout round 1: fail safe, as QB-U30a and QB-U19 read it)", () => {
  it.each(['all,', ',all', 'all, ', 'all,,', ', all ,'])('the clock reads %p as a list holding only the keyword: off, one WARN', raw => {
    const select = parseHostSelect(raw, CLOCK);
    expect(select).toEqual({
      mode: 'off',
      hosts: [],
      excluded: [],
      warnings: ['[HOST-CLOCK] WARN SCRAPE_HOST_CLOCK entry "all" is a keyword, not a host, inside a host list; ignored'],
      malformed: false,
    });
    expect(hostSelected(select, MFC)).toBe(false);
  });

  it.each(['all,', ',all', 'all,,'])('the pool knob reads %p as malformed: off', raw => {
    expect(parseHostSelect(raw, POOL)).toEqual({
      mode: 'off',
      hosts: [],
      excluded: [],
      warnings: [`[POOL] WARN SCRAPE_POOL_SELECT="${raw}" is malformed (entry "all" is a keyword, not a host, inside a host list); treated as off`],
      malformed: true,
    });
  });

  it("blank tokens inside an exclusion list stay skipped: 'all,-x.com,' excludes x.com", () => {
    expect(parseHostSelect('all,-x.com,', CLOCK)).toMatchObject({ mode: 'all-except', excluded: ['x.com'], malformed: false });
  });
});

describe('the strict (SCRAPE_POOL_SELECT) list', () => {
  it.each([
    ['-x.com', '"-x.com" is an exclusion without a leading "all"'],
    ['y.com,-x.com', '"-x.com" is an exclusion without a leading "all"'],
    ['+x.com', 'entry "+x.com" is not a bare hostname'],
    ['all,y.com', '"all" mixed with a listed host'],
    ['y.com,all', 'entry "all" is a keyword, not a host, inside a host list'],
    ['y.com,off', 'entry "off" is a keyword, not a host, inside a host list'],
    ['y.com,https://x.com', 'entry "https://x.com" is not a bare hostname'],
  ])('%p is malformed: off with one WARN', (raw, why) => {
    expect(parseHostSelect(raw, POOL)).toEqual({
      mode: 'off',
      hosts: [],
      excluded: [],
      warnings: [`[POOL] WARN SCRAPE_POOL_SELECT="${raw}" is malformed (${why}); treated as off`],
      malformed: true,
    });
  });
});

describe('the lenient (SCRAPE_HOST_CLOCK, QB-U30a) list', () => {
  it('drops a bad entry with a WARN and keeps the rest, exactly as QB-U30a did', () => {
    const raw = 'https://Mock.example.test, off , ALL ,example.com/x,-x.com,MOCK.Example.Test.,myfigurecollection.net';
    expect(parseHostSelect(raw, CLOCK)).toEqual({
      mode: 'hosts',
      hosts: ['mock.example.test', MFC],
      excluded: [],
      warnings: [
        '[HOST-CLOCK] WARN SCRAPE_HOST_CLOCK entry "https://Mock.example.test" is not a bare hostname; ignored',
        '[HOST-CLOCK] WARN SCRAPE_HOST_CLOCK entry "off" is a keyword, not a host, inside a host list; ignored',
        '[HOST-CLOCK] WARN SCRAPE_HOST_CLOCK entry "ALL" is a keyword, not a host, inside a host list; ignored',
        '[HOST-CLOCK] WARN SCRAPE_HOST_CLOCK entry "example.com/x" is not a bare hostname; ignored',
        '[HOST-CLOCK] WARN SCRAPE_HOST_CLOCK entry "-x.com" is not a bare hostname; ignored',
      ],
      malformed: false,
    });
  });

  it("'all' followed by bare hosts only stays QB-U30a's list (the keyword ignored)", () => {
    const select = parseHostSelect('all,y.com', CLOCK);
    expect(select.mode).toBe('hosts');
    expect(select.hosts).toEqual(['y.com']);
    expect(select.warnings).toEqual(['[HOST-CLOCK] WARN SCRAPE_HOST_CLOCK entry "all" is a keyword, not a host, inside a host list; ignored']);
  });

  it('a list of nothing but ignored entries is off', () => {
    const select = parseHostSelect('https://mock.example.test', CLOCK);
    expect(select.mode).toBe('off');
    expect(select.warnings).toHaveLength(1);
    expect(select.malformed).toBe(false);
  });
});
