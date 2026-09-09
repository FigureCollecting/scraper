/**
 * The hook's two pieces of MEMORY: what it has already seen, and what the home line has already
 * spent. Both exist to stop the same thing — a re-fetch nobody asked for — at two different scales:
 * one image the process already holds, and a day's worth of bytes on a line that is somebody's house.
 */
import { createImageUrlMemo, createResidentialByteBudget } from '../../services/images/imageCaptureState';

describe('createImageUrlMemo', () => {
  it('does not know a url it has never been told about', () => {
    expect(createImageUrlMemo(10).hasUrl('https://cdn.test/a.jpg')).toBe(false);
  });

  it('knows a url and the content it resolved to', () => {
    const memo = createImageUrlMemo(10);
    memo.remember('https://cdn.test/a.jpg', 'abc');
    expect(memo.hasUrl('https://cdn.test/a.jpg')).toBe(true);
    expect(memo.hasSha('abc')).toBe(true);
  });

  it('recognizes the same BYTES arriving under a different url', () => {
    // Two urls, one file: the object store is content-addressed, so the second one is already there.
    const memo = createImageUrlMemo(10);
    memo.remember('https://cdn.test/a.jpg?v=1', 'abc');
    expect(memo.hasUrl('https://cdn.test/a.jpg?v=2')).toBe(false);
    expect(memo.hasSha('abc')).toBe(true);
  });

  it('evicts the least recently used url once it is full', () => {
    const memo = createImageUrlMemo(2);
    memo.remember('a', '1');
    memo.remember('b', '2');
    memo.remember('c', '3');
    expect(memo.hasUrl('a')).toBe(false);
    expect(memo.hasUrl('b')).toBe(true);
    expect(memo.hasUrl('c')).toBe(true);
  });

  it('a hit renews a url, so a busy one is not evicted by a burst of new ones', () => {
    const memo = createImageUrlMemo(2);
    memo.remember('a', '1');
    memo.remember('b', '2');
    expect(memo.hasUrl('a')).toBe(true);
    memo.remember('c', '3');
    expect(memo.hasUrl('a')).toBe(true);
    expect(memo.hasUrl('b')).toBe(false);
  });

  it('remembers nothing at all when it is sized to zero', () => {
    const memo = createImageUrlMemo(0);
    memo.remember('a', '1');
    expect(memo.hasUrl('a')).toBe(false);
    expect(memo.hasSha('1')).toBe(false);
  });
});

describe('createResidentialByteBudget', () => {
  const HOUR = 3_600_000;

  it('has room while the window is under the limit', () => {
    const budget = createResidentialByteBudget(1000);
    expect(budget.hasRoom(0)).toBe(true);
    budget.record(999, 0);
    expect(budget.hasRoom(0)).toBe(true);
    expect(budget.bytesInWindow(0)).toBe(999);
  });

  it('closes once the limit is reached, not merely once it is exceeded', () => {
    const budget = createResidentialByteBudget(1000);
    budget.record(1000, 0);
    expect(budget.hasRoom(0)).toBe(false);
  });

  it('rolls: bytes spent more than a day ago no longer count against the line', () => {
    const budget = createResidentialByteBudget(1000);
    budget.record(1000, 0);
    expect(budget.hasRoom(23 * HOUR)).toBe(false);
    expect(budget.hasRoom(25 * HOUR)).toBe(true);
    expect(budget.bytesInWindow(25 * HOUR)).toBe(0);
  });

  it('rolls by the hour, so a spend does not expire all at once', () => {
    const budget = createResidentialByteBudget(10_000);
    budget.record(600, 0);
    budget.record(400, 5 * HOUR);
    expect(budget.bytesInWindow(5 * HOUR)).toBe(1000);
    expect(budget.bytesInWindow(25 * HOUR)).toBe(400);
    expect(budget.bytesInWindow(30 * HOUR)).toBe(0);
  });

  it('a limit of zero means the residential line is never spent', () => {
    const budget = createResidentialByteBudget(0);
    expect(budget.hasRoom(0)).toBe(false);
  });

  it('ignores a non-positive or unusable byte count', () => {
    const budget = createResidentialByteBudget(1000);
    budget.record(-5, 0);
    budget.record(Number.NaN, 0);
    expect(budget.bytesInWindow(0)).toBe(0);
  });
});
