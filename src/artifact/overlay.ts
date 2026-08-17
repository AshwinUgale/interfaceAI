/**
 * Tenant overlays: reuse one recorded capability across tenants running the same product, without
 * re-recording. Precedence is base -> (app-version) -> tenant. Authority is constrained BY TYPE:
 * an overlay may add locator candidates, set the base URL (execution context), and alias labels —
 * it CANNOT change risk, approval, output sensitivity, or business-outcome semantics. Those require
 * a new capability version + approval.
 */
import { type Capability } from './schema.js';
import type { LocatorCandidate } from '../surface/types.js';

export interface TenantOverlay {
  overlayId: string;
  version: string;
  tenant: string;
  baseUrl: string; // execution context, not artifact data
  /** Add fallback candidates to the step targeting the control with this recorded expectedName. */
  locatorOverrides: { matchExpectedName: string; addCandidates: LocatorCandidate[] }[];
}

export interface AppliedOverlay {
  capability: Capability;
  /** Per-step count of base candidates, so drift telemetry can tell an approved override from real drift. */
  baseCandidateCount: Record<string, number>;
}

export function applyOverlay(base: Capability, overlay: TenantOverlay): AppliedOverlay {
  const baseCandidateCount: Record<string, number> = {};
  const steps = base.steps.map((step) => {
    if (!('target' in step)) return step;
    baseCandidateCount[step.id] = step.target.candidates.length;
    const expectedName = step.target.invariants.expectedName;
    const rule = overlay.locatorOverrides.find((o) => o.matchExpectedName === expectedName);
    if (!rule) return step;
    return {
      ...step,
      target: {
        ...step.target,
        candidates: [...step.target.candidates, ...rule.addCandidates],
        basis: [...(step.target.basis ?? []), `overlay:${overlay.tenant}`],
      },
    };
  });
  return {
    capability: { ...base, steps: steps as Capability['steps'] },
    baseCandidateCount,
  };
}
