/**
 * NORMALIZING what a ruleset described into what the engine will actually fetch.
 *
 * The ruleset answers "what images are on this item, and what is each one"; this step answers "which
 * of those does this landing fetch, in what order, and how many". The two are kept apart on purpose:
 * the role vocabulary is the contract's, the capture RULE is the engine's, and an engine that mixed
 * them would need a contract change to stop capturing thumbnails.
 */
import { normalizeImageRefs, CAPTURED_IMAGE_ROLES } from '../../services/images/imageRefs';
import type { ImageRef } from '@figurecollecting/scraper-plugin-contract';

const PAGE = 'https://store.test/products/lucy';

const ref = (url: string, role: ImageRef['role'] = 'gallery', position = 0): ImageRef => ({ url, role, position });

describe('normalizeImageRefs', () => {
  it('captures gallery and other, and ONLY those two roles', () => {
    expect([...CAPTURED_IMAGE_ROLES].sort()).toEqual(['gallery', 'other']);
  });

  it('resolves a relative url against the page it was found on', () => {
    const { refs } = normalizeImageRefs([ref('/img/a.jpg')], PAGE, 12);
    expect(refs.map(r => r.url)).toEqual(['https://store.test/img/a.jpg']);
  });

  it('leaves an already-absolute url exactly as it was', () => {
    const { refs } = normalizeImageRefs([ref('https://cdn.test/a.jpg')], PAGE, 12);
    expect(refs[0].url).toBe('https://cdn.test/a.jpg');
  });

  it('skips a thumbnail and a user upload, counting each under its own reason', () => {
    const { refs, skipped } = normalizeImageRefs(
      [ref('/a.jpg', 'gallery', 0), ref('/t.jpg', 'thumbnail', 1), ref('/u.jpg', 'user', 2), ref('/o.jpg', 'other', 3)],
      PAGE,
      12,
    );
    expect(refs.map(r => r.position)).toEqual([0, 3]);
    expect(skipped.thumbnailRole).toBe(1);
    expect(skipped.userRole).toBe(1);
  });

  it('refuses a ref whose role is not in the vocabulary at all', () => {
    const { refs, skipped } = normalizeImageRefs([{ url: '/a.jpg', role: 'hero', position: 0 } as unknown as ImageRef], PAGE, 12);
    expect(refs).toEqual([]);
    expect(skipped.policyDeny).toBe(1);
  });

  it('refuses a ref with no usable url before anything is fetched', () => {
    const { refs, skipped } = normalizeImageRefs([ref(''), ref('   '), { role: 'gallery', position: 1 } as unknown as ImageRef], PAGE, 12);
    expect(refs).toEqual([]);
    expect(skipped.policyDeny).toBe(3);
  });

  it('keeps a url that does not resolve, so the lane decision is the one that refuses it', () => {
    // Not a silent drop: `chooseImageLane` denies anything that is not a fetchable http(s) URL, and
    // routing every refusal through ONE gate is what keeps the deny list authoritative.
    const { refs } = normalizeImageRefs([ref('javascript:alert(1)')], PAGE, 12);
    expect(refs.map(r => r.url)).toEqual(['javascript:alert(1)']);
  });

  it('collapses a url the ruleset named twice into one fetch', () => {
    const { refs } = normalizeImageRefs([ref('/a.jpg', 'gallery', 0), ref('/a.jpg', 'gallery', 1), ref('/b.jpg', 'gallery', 2)], PAGE, 12);
    expect(refs.map(r => r.url)).toEqual(['https://store.test/a.jpg', 'https://store.test/b.jpg']);
    expect(refs.map(r => r.position)).toEqual([0, 2]);
  });

  it('caps the list at the per-item ceiling and counts what it dropped', () => {
    const many = Array.from({ length: 20 }, (_, i) => ref(`/a${i}.jpg`, 'gallery', i));
    const { refs, skipped } = normalizeImageRefs(many, PAGE, 12);
    expect(refs).toHaveLength(12);
    expect(refs[11].position).toBe(11);
    expect(skipped.cap).toBe(8);
  });

  it('counts the cap against what SURVIVED the role filter, not the raw list', () => {
    const refs = [
      ...Array.from({ length: 3 }, (_, i) => ref(`/g${i}.jpg`, 'gallery', i)),
      ...Array.from({ length: 9 }, (_, i) => ref(`/t${i}.jpg`, 'thumbnail', i + 3)),
    ];
    const out = normalizeImageRefs(refs, PAGE, 2);
    expect(out.refs).toHaveLength(2);
    expect(out.skipped.cap).toBe(1);
    expect(out.skipped.thumbnailRole).toBe(9);
  });

  it('captures nothing when the cap is zero', () => {
    const { refs, skipped } = normalizeImageRefs([ref('/a.jpg')], PAGE, 0);
    expect(refs).toEqual([]);
    expect(skipped.cap).toBe(1);
  });

  it('survives a ruleset that returned something that is not a list', () => {
    expect(normalizeImageRefs(undefined as unknown as ImageRef[], PAGE, 12).refs).toEqual([]);
    expect(normalizeImageRefs('nope' as unknown as ImageRef[], PAGE, 12).refs).toEqual([]);
  });
});
