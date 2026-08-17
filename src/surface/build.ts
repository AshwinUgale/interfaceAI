/** Helper: build the policy-enforced surface with the session guard attached to the live context. */
import { PolicyEngine } from './policy.js';
import { SessionGuard } from './session-guard.js';
import { WebSurfaceDriver } from './web-driver.js';
import { PolicyEnforcedSurface } from './policy-surface.js';
import type { EvidenceRecorder } from '../evidence/recorder.js';

export interface BuiltSurface {
  raw: WebSurfaceDriver;
  surface: PolicyEnforcedSurface;
  guard: SessionGuard;
  policy: PolicyEngine;
  stop: () => Promise<void>;
}

export async function buildSurface(
  allowlistPath: string,
  evidence: EvidenceRecorder | undefined,
  opts: { headless?: boolean } = {}
): Promise<BuiltSurface> {
  const policy = PolicyEngine.fromFile(allowlistPath);
  const raw = new WebSurfaceDriver({ headless: opts.headless ?? true });
  await raw.start();
  const guard = new SessionGuard(policy);
  await guard.attach(raw.getContext());
  const surface = new PolicyEnforcedSurface(raw, policy, evidence);
  return { raw, surface, guard, policy, stop: () => raw.stop() };
}
