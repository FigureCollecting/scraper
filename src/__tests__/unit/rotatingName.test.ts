/** The one safe-name rule for rotating list ids and groups: the catalog route and the crawler share it. */
import { isSafeRotatingName } from '../../utils/rotatingName';

describe('isSafeRotatingName', () => {
  it('takes letters, digits, dot, underscore and dash; refuses everything else and __proto__', () => {
    for (const ok of ['company-7620', 'c1.d9', 'A_b-9', 'constructor', 'toString']) expect(isSafeRotatingName(ok)).toBe(true);
    for (const bad of ['', '__proto__', 'a b', 'x/y', '../x', 'a&b', 'é', 5, null, undefined, {}]) expect(isSafeRotatingName(bad)).toBe(false);
  });
});
