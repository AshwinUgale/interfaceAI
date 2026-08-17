import { describe, it, expect } from 'vitest';
import { PolicyEngine } from '../src/surface/policy.js';
import { PolicyEnforcedSurface } from '../src/surface/policy-surface.js';
import { runDiscovery } from '../src/discovery/orchestrator.js';
import { replay } from '../src/replay/engine.js';
import { FakeSurface, tmpEvidenceDir } from './fake-surface.js';
import { makeCapability } from './test-capability.js';
import { EvidenceRecorder } from '../src/evidence/recorder.js';
import type { Brain } from '../src/discovery/brain.js';
import type { TargetDescriptor } from '../src/surface/types.js';

const policy = PolicyEngine.fromFile('allowlist.json');
const descriptor: TargetDescriptor = {
  context: { frames: [] },
  candidates: [{ strategy: 'text', text: 'x' }],
  invariants: { cardinality: 'exactlyOne', mustBeVisible: true, mustBeEnabled: true },
};

describe('replay is policy-enforced too (not just discovery)', () => {
  it('blocks an irreversible click even if the artifact mislabels its risk', async () => {
    const raw = new FakeSurface();
    raw.url = 'http://localhost:4000/account/review';
    raw.formAction = '/account/create'; // irreversible route per allowlist
    const surface = new PolicyEnforcedSurface(raw, policy);
    const { result } = await surface.resolveAndAct(descriptor, 'click');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('POLICY_DENIED');
  });

  it('allows a reversible_write submit through', async () => {
    const raw = new FakeSurface();
    raw.url = 'http://localhost:4000/account/new';
    raw.formAction = '/account/review'; // reversible_write route
    const surface = new PolicyEnforcedSurface(raw, policy);
    const { result } = await surface.resolveAndAct(descriptor, 'click');
    expect(result.ok).toBe(true);
  });

  it('the replay result contract classifies a policy block as POLICY_DENIED (not ACTION_FAILED)', async () => {
    const cap = makeCapability({ clickRetry: { maxAttempts: 1, retryOn: [], safeToRetry: false } });
    const raw = new FakeSurface();
    raw.url = 'http://localhost:4000/account/review';
    raw.formAction = '/account/create'; // irreversible
    const surface = new PolicyEnforcedSurface(raw, policy);
    const r = await replay(cap, {}, surface, new EvidenceRecorder(tmpEvidenceDir()), { targetBase: 'http://localhost:4000' });
    expect(r.status).toBe('failure');
    if (r.status === 'failure') expect(r.error.code).toBe('POLICY_DENIED');
  });
});

describe('discovery verifies the goal before accepting finish', () => {
  it('rejects a premature finish as incomplete', async () => {
    const raw = new FakeSurface(); // texts empty -> success condition never satisfied
    const surface = new PolicyEnforcedSurface(raw, policy);
    const finishBrain: Brain = { name: 'stub', next: async () => ({ kind: 'finish', intent: 'done early' }) };
    const outcome = await runDiscovery(surface, policy, finishBrain, new EvidenceRecorder(tmpEvidenceDir()), {
      goal: 'g',
      inputs: {},
      entryUrl: 'http://localhost:4000/',
      successText: 'Review New Sub-Account',
    });
    expect(outcome.status).toBe('incomplete');
  });
});
