import { describe, it, expect } from 'vitest';
import { replay } from '../src/replay/engine.js';
import { EvidenceRecorder } from '../src/evidence/recorder.js';
import { FakeSurface, tmpEvidenceDir } from './fake-surface.js';
import { makeCapability } from './test-capability.js';

function rec() {
  return new EvidenceRecorder(tmpEvidenceDir());
}

describe('ReplayEngine — contract & taxonomy', () => {
  it('rejects a missing required input before touching the UI (invalid_invocation)', async () => {
    const cap = makeCapability({ requireMemberId: true });
    const surface = new FakeSurface();
    const r = await replay(cap, {}, surface, rec(), { targetBase: 'http://localhost:4000' });
    expect(r.status).toBe('invalid_invocation');
    expect(surface.navigations.length).toBe(0); // never navigated
  });

  it('returns a business_outcome (not a failure) when a business error rule matches', async () => {
    const cap = makeCapability({
      onError: [{ match: { text: 'No record found' }, classify: 'business', outcomeCode: 'MEMBER_NOT_FOUND', action: 'return' }],
    });
    const surface = new FakeSurface();
    surface.texts.add('No record found');
    const r = await replay(cap, {}, surface, rec(), { targetBase: 'http://localhost:4000' });
    expect(r.status).toBe('business_outcome');
    if (r.status === 'business_outcome') expect(r.code).toBe('MEMBER_NOT_FOUND');
  });

  it('fails cleanly on ambiguous targets (never picks matches[0])', async () => {
    const cap = makeCapability({});
    const surface = new FakeSurface();
    surface.script = [{ resolution: { status: 'ambiguous', matchCount: 3, fallbackUsed: false }, result: { ok: false } }];
    const r = await replay(cap, {}, surface, rec(), { targetBase: 'http://localhost:4000' });
    expect(r.status).toBe('failure');
    if (r.status === 'failure') expect(r.error.code).toBe('TARGET_AMBIGUOUS');
  });

  it('retries a transient not-found when safeToRetry, then succeeds', async () => {
    const cap = makeCapability({ clickRetry: { maxAttempts: 3, retryOn: ['TRANSIENT_LOAD'], safeToRetry: true } });
    const surface = new FakeSurface();
    surface.texts.add('OK'); // checkpoint + success condition
    surface.script = [
      { resolution: { status: 'not_found', matchCount: 0, fallbackUsed: false }, result: { ok: false } },
      { resolution: { status: 'resolved', matchCount: 1, fallbackUsed: false }, result: { ok: true } },
    ];
    const r = await replay(cap, {}, surface, rec(), { targetBase: 'http://localhost:4000' });
    expect(r.status).toBe('success');
    if (r.status === 'success') {
      const s = r.steps.find((x) => x.stepId === 'step-01');
      expect(s?.attempts).toBe(2);
    }
  });

  it('does NOT retry a side-effecting action when safeToRetry is false', async () => {
    const cap = makeCapability({ clickRetry: { maxAttempts: 3, retryOn: [], safeToRetry: false } });
    const surface = new FakeSurface();
    surface.script = [
      { resolution: { status: 'resolved', matchCount: 1, fallbackUsed: false }, result: { ok: false, error: 'boom' } },
      { resolution: { status: 'resolved', matchCount: 1, fallbackUsed: false }, result: { ok: true } },
    ];
    const r = await replay(cap, {}, surface, rec(), { targetBase: 'http://localhost:4000' });
    expect(r.status).toBe('failure');
    if (r.status === 'failure') {
      expect(r.error.code).toBe('ACTION_FAILED');
      const s = r.steps.find((x) => x.stepId === 'step-01');
      expect(s?.attempts).toBe(1); // no second attempt
    }
    expect(surface.script.length).toBe(1); // the second scripted result was never consumed
  });
});
