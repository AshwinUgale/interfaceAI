import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { zCapability } from '../src/artifact/schema.js';
import { applyOverlay, type TenantOverlay } from '../src/artifact/overlay.js';
import { ControlToken } from '../src/escalation/control.js';

describe('tenant overlay (multi-tenant reuse)', () => {
  const cap = zCapability.parse(JSON.parse(readFileSync('artifacts/open-sub-account.json', 'utf8')));
  const overlay = JSON.parse(readFileSync('overlays/tenant-b.json', 'utf8')) as TenantOverlay;

  it('appends fallback candidates to the matching step without altering risk', () => {
    const openStep = cap.steps.find((s) => 'target' in s && s.target.invariants.expectedName === 'Open New Account')!;
    const before = 'target' in openStep ? openStep.target.candidates.length : 0;
    const applied = applyOverlay(cap, overlay);
    const after = applied.capability.steps.find((s) => s.id === openStep.id)!;
    expect('target' in after && after.target.candidates.length).toBe(before + overlay.locatorOverrides[0]!.addCandidates.length);
    // base candidates preserved at the front (precedence base -> overlay)
    expect('target' in after && after.target.candidates[0]).toEqual(('target' in openStep && openStep.target.candidates[0]) as unknown);
    // risk untouched — overlays cannot weaken safety
    expect('risk' in after && after.risk).toEqual('risk' in openStep && openStep.risk);
    expect(applied.baseCandidateCount[openStep.id]).toBe(before);
  });
});

describe('control token state machine', () => {
  it('allows the handoff path and rejects illegal transitions', () => {
    const t = new ControlToken();
    expect(t.owner).toBe('agent');
    t.to('HANDOFF_PENDING');
    t.to('HUMAN');
    expect(t.owner).toBe('human');
    expect(() => t.to('AUTOMATION')).toThrow(); // HUMAN -> AUTOMATION is illegal
    t.to('RESUMING');
    t.to('AUTOMATION');
    expect(t.owner).toBe('agent');
    expect(t.transitions.length).toBe(4);
  });

  it('assertAgentOwns throws when the human holds control', () => {
    const t = new ControlToken();
    t.to('HANDOFF_PENDING');
    t.to('HUMAN');
    expect(() => t.assertAgentOwns()).toThrow();
  });
});
