import { describe, it, expect } from 'vitest';
import { evalPredicate } from '../src/artifact/predicate.js';
import { FakeSurface } from './fake-surface.js';

describe('compound predicate evaluation', () => {
  it('handles all / any / not and textMatches / urlMatches', async () => {
    const s = new FakeSurface();
    s.url = 'http://localhost:4000/member/10001';
    s.texts.add('Member Details');
    s.texts.add('Review Reference');

    expect(await evalPredicate(s, { kind: 'textMatches', text: 'Member Details' })).toBe(true);
    expect(await evalPredicate(s, { kind: 'textMatches', text: 'No record found' })).toBe(false);
    expect(await evalPredicate(s, { kind: 'urlMatches', pattern: '/member/\\d+' })).toBe(true);
    expect(await evalPredicate(s, { not: { kind: 'textMatches', text: 'No record found' } })).toBe(true);
    expect(
      await evalPredicate(s, { all: [{ kind: 'textMatches', text: 'Member Details' }, { kind: 'textMatches', text: 'Review Reference' }] })
    ).toBe(true);
    expect(
      await evalPredicate(s, { all: [{ kind: 'textMatches', text: 'Member Details' }, { kind: 'textMatches', text: 'Nope' }] })
    ).toBe(false);
    expect(
      await evalPredicate(s, { any: [{ kind: 'textMatches', text: 'Nope' }, { kind: 'textMatches', text: 'Member Details' }] })
    ).toBe(true);
  });
});
