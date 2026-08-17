import { zCapability, type Capability, type ErrorRuleT, type Step } from '../src/artifact/schema.js';

const target = {
  context: { frames: [] },
  candidates: [{ strategy: 'text' as const, text: 'x' }],
  invariants: { cardinality: 'exactlyOne' as const, mustBeVisible: true, mustBeEnabled: true },
};

/** Build a minimal valid capability with one navigate + one click step (for engine tests). */
export function makeCapability(opts: {
  clickRetry?: { maxAttempts: number; retryOn: string[]; safeToRetry: boolean };
  onError?: ErrorRuleT[];
  requireMemberId?: boolean;
}): Capability {
  const clickStep: Step = {
    id: 'step-01',
    intent: 'click the thing',
    action: 'click',
    target,
    risk: { class: 'reversible_write', approval: 'automatic' },
    checkpoint: { kind: 'textMatches', text: 'OK' },
    retryPolicy: opts.clickRetry ?? { maxAttempts: 2, retryOn: ['TRANSIENT_LOAD'], safeToRetry: true },
    ...(opts.onError ? { onError: opts.onError } : {}),
  };
  return zCapability.parse({
    schemaVersion: '1.0',
    capabilityId: 'test-cap',
    capabilityVersion: '1.0.0',
    name: 'Test capability',
    description: 'test',
    recordedAgainst: { applicationFamily: 'test', surface: 'web', variant: 'base' },
    compatibleVariants: ['base'],
    preconditions: [],
    inputs: opts.requireMemberId ? [{ name: 'memberId', type: 'string', required: true, classification: 'pii' }] : [],
    outputs: [],
    steps: [
      { id: 'step-00', intent: 'open', action: 'navigate', url: '/', risk: { class: 'read', approval: 'automatic' }, retryPolicy: { maxAttempts: 1, retryOn: [], safeToRetry: true } },
      clickStep,
    ],
    successCondition: { kind: 'textMatches', text: 'OK' },
    provenance: { recordedFromRunId: 'test', model: { provider: 'test', id: 'test' }, approvalState: 'draft' },
  });
}
