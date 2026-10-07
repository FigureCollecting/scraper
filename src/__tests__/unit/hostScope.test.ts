/**
 * QB-U19: the host-scope grammar SCRAPE_POOL_SELECT is read with (QB-U30b reuses it for
 * SCRAPE_HOST_CLOCK): off | <empty> | all | all,-host[,-host...] | host[,host...]. Tokens are trimmed and
 * case-folded; hosts are normalised like the host clock (www. and trailing dots stripped). Anything else
 * is MALFORMED: treated as off, with one warning naming the value. Membership is evaluated per call, so
 * 'all,-host' covers hosts nobody has seen yet.
 */
import { normalizeScopeHost, parseHostScope } from '../../services/hostScope';

const ENV = 'SCRAPE_POOL_SELECT';
const MFC = 'myfigurecollection.net';

describe('parseHostScope: off', () => {
  it.each([undefined, '', '   ', 'off', 'OFF', ' Off '])('%p is off, with no warning', (raw) => {
    const scope = parseHostScope(raw, ENV);
    expect(scope.kind).toBe('off');
    expect(scope.malformed).toBe(false);
    expect(scope.warning).toBeNull();
    expect(scope.membership(MFC)).toBe('out');
    expect(scope.membership('anything.test')).toBe('out');
  });
});

describe('parseHostScope: all', () => {
  it.each(['all', ' ALL '])('%p covers every host, including one never seen before', (raw) => {
    const scope = parseHostScope(raw, ENV);
    expect(scope.kind).toBe('all');
    expect(scope.malformed).toBe(false);
    expect(scope.membership(MFC)).toBe('in');
    expect(scope.membership(`first-seen-${Date.now()}.test`)).toBe('in');
  });
});

describe("parseHostScope: 'all,-host'", () => {
  it('excludes the host and keeps every other host in, hosts first seen later included', () => {
    const scope = parseHostScope('all,-myfigurecollection.net', ENV);
    expect(scope.kind).toBe('all-except');
    expect(scope.hosts).toEqual([MFC]);
    expect(scope.malformed).toBe(false);
    expect(scope.warning).toBeNull();
    expect(scope.membership(MFC)).toBe('excluded');
    expect(scope.membership('hpoi.net')).toBe('in');
    expect(scope.membership('late-host.example')).toBe('in');
  });

  it.each(['www.myfigurecollection.net', 'MyFigureCollection.NET', 'myfigurecollection.net.', ' WWW.MYFIGURECOLLECTION.NET.. '])(
    'the excluded host spelled %p is excluded too',
    (spelling) => {
      expect(parseHostScope('all,-myfigurecollection.net', ENV).membership(spelling)).toBe('excluded');
    },
  );

  it.each([' ALL , -WWW.MyFigureCollection.NET. ', 'all,-myfigurecollection.net.', 'All,-www.myfigurecollection.net'])(
    'the knob spelling %p excludes the same host',
    (raw) => {
      const scope = parseHostScope(raw, ENV);
      expect(scope.kind).toBe('all-except');
      expect(scope.hosts).toEqual([MFC]);
      expect(scope.membership(MFC)).toBe('excluded');
      expect(scope.membership('fast.test')).toBe('in');
    },
  );

  it("'all,-a,-b' excludes both (and a repeat once)", () => {
    const scope = parseHostScope('all,-a.test,-b.test,-A.test', ENV);
    expect(scope.kind).toBe('all-except');
    expect(scope.hosts).toEqual(['a.test', 'b.test']);
    expect(scope.membership('a.test')).toBe('excluded');
    expect(scope.membership('b.test')).toBe('excluded');
    expect(scope.membership('c.test')).toBe('in');
  });
});

describe('parseHostScope: a host list', () => {
  it('covers only the listed hosts (normalised, deduplicated)', () => {
    const scope = parseHostScope('hpoi.net, WWW.Fast.Test.,hpoi.net', ENV);
    expect(scope.kind).toBe('hosts');
    expect(scope.hosts).toEqual(['hpoi.net', 'fast.test']);
    expect(scope.membership('www.hpoi.net')).toBe('in');
    expect(scope.membership('fast.test')).toBe('in');
    expect(scope.membership(MFC)).toBe('out');
  });
});

describe('parseHostScope: MALFORMED values are off, with one warning naming the value', () => {
  it.each([
    '-myfigurecollection.net',
    'all,myfigurecollection.net',
    '+myfigurecollection.net',
    'all,-',
    '-',
    'off,hpoi.net',
    'hpoi.net,off',
    'hpoi.net,all',
    'all,all',
    'all,-hpoi.net,all',
    'all,-hpoi.net,fast.test',
    'hpoi.net,-fast.test',
    'hpoi.net,,fast.test',
    'all,',
    ',',
    'all,-https://hpoi.net',
    'hpoi.net:443',
    'all,--hpoi.net',
    'hpoi net',
  ])('%p', (raw) => {
    const scope = parseHostScope(raw, ENV);
    expect(scope.kind).toBe('off');
    expect(scope.malformed).toBe(true);
    expect(scope.hosts).toEqual([]);
    expect(scope.membership(MFC)).toBe('out');
    expect(scope.membership('hpoi.net')).toBe('out');
    expect(scope.warning).not.toBeNull();
    expect(scope.warning).toContain(ENV);
    expect(scope.warning).toContain(`"${raw}"`);
    expect(scope.warning).toMatch(/treated as off/);
  });

  it.each([
    ['hpoi.net,,fast.test', 'an empty entry'],
    ['all,', 'an empty entry'],
    ['hpoi.net,all', "'all' is a keyword inside a host list"],
    ['-hpoi.net,all', "'-hpoi.net' excludes a host without a leading 'all'"],
    ['hpoi.net,-fast.test', "'-fast.test' excludes a host without a leading 'all'"],
    ['all,hpoi.net', "'hpoi.net' after 'all' is not a '-host' exclusion"],
    ['all,-', "'-' does not exclude a bare hostname"],
    ['+hpoi.net', "'+hpoi.net' is not a bare hostname"],
  ])('%p: the warning says why (%s)', (raw, why) => {
    expect(parseHostScope(raw, ENV).warning).toBe(`WARN ${ENV}="${raw}" is malformed (${why}); treated as off`);
  });

  it('a value with a line break is named without breaking the log line', () => {
    const scope = parseHostScope('all,-a.test\n[POOL] forged', ENV);
    expect(scope.malformed).toBe(true);
    expect(scope.warning).not.toMatch(/\n/);
  });
});

describe('normalizeScopeHost', () => {
  it.each([
    ['MyFigureCollection.NET', MFC],
    ['www.myfigurecollection.net', MFC],
    ['myfigurecollection.net.', MFC],
    ['  WWW.myfigurecollection.net..  ', MFC],
    ['static.myfigurecollection.net', 'static.myfigurecollection.net'],
  ])('%p -> %p', (raw, want) => {
    expect(normalizeScopeHost(raw)).toBe(want);
  });
});
