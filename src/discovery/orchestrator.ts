/**
 * Discovery orchestrator: runs the observe -> decide -> act loop against the live surface via the
 * policy-enforced driver, records typed ExecutionEvents + evidence, and enforces stopping
 * conditions (finish, max steps, and a mechanical dead-end signal).
 */
import type { PolicyEnforcedSurface } from '../surface/policy-surface.js';
import type { PolicyEngine } from '../surface/policy.js';
import type { EvidenceRecorder } from '../evidence/recorder.js';
import type { Brain, Decision } from './brain.js';
import type { ExecutionEvent, RouteRisk } from './events.js';

export interface DiscoveryConfig {
  goal: string;
  inputs: Record<string, string>;
  entryUrl: string;
  maxSteps?: number;
  /** Text that must be present when the model calls finish, else the run is rejected as incomplete. */
  successText?: string;
  /** Output names whose read VALUES are sensitive — registered for redaction the moment they're read. */
  sensitiveOutputs?: string[];
}

export interface DiscoveryOutcome {
  status: 'success' | 'incomplete' | 'max_steps' | 'dead_end' | 'blocked' | 'failed';
  reason?: string;
  events: ExecutionEvent[];
}

export async function runDiscovery(
  surface: PolicyEnforcedSurface,
  policy: PolicyEngine,
  brain: Brain,
  evidence: EvidenceRecorder,
  config: DiscoveryConfig
): Promise<DiscoveryOutcome> {
  const maxSteps = config.maxSteps ?? 25;
  const events: ExecutionEvent[] = [];
  for (const v of Object.values(config.inputs)) evidence.registerSensitive(v);

  evidence.log('discovery_start', { goal: config.goal, brain: brain.name, entryUrl: config.entryUrl });

  const nav = await surface.navigate(config.entryUrl);
  if (!nav.ok) return { status: 'failed', reason: nav.error, events };
  events.push({ intent: 'Open the target application', action: 'navigate', url: config.entryUrl, routeRisk: 'read' });

  const fingerprints: string[] = [];
  for (let step = 0; step < maxSteps; step++) {
    const observation = await surface.observe();

    // Dead-end: identical observation three times running.
    fingerprints.push(observation.outline);
    const last3 = fingerprints.slice(-3);
    if (last3.length === 3 && last3.every((f) => f === last3[0])) {
      evidence.log('dead_end', { step });
      return { status: 'dead_end', reason: 'observation unchanged 3x', events };
    }

    let decision: Decision;
    try {
      decision = await brain.next({ goal: config.goal, inputs: config.inputs, observation, url: observation.url, stepIndex: step });
    } catch (e) {
      evidence.log('brain_error', { step, error: (e as Error).message });
      return { status: 'failed', reason: (e as Error).message, events };
    }

    if (decision.kind === 'finish') {
      // Verify the goal state before accepting completion — a model 'finish' is not proof.
      if (config.successText && !(await surface.textPresent(config.successText))) {
        evidence.log('finish_rejected', { step, successText: config.successText });
        return { status: 'incomplete', reason: `finish before success condition (${config.successText})`, events };
      }
      // Do NOT persist the model's free-form finish prose (it may echo page data); the verified
      // success predicate is the record. No final screenshot — the success screen shows member data.
      evidence.log('discovery_finish', { step, successConditionVerified: !!config.successText });
      return { status: 'success', events };
    }

    const node = decision.ref ? observation.nodes.find((n) => n.ref === decision.ref) : undefined;
    const routeRisk = computeRouteRisk(policy, decision, node?.attrs.formAction, node?.attrs.formMethod, surface.currentUrl());

    const result = await surface.act({ type: decision.action!, ref: decision.ref, url: decision.url, value: decision.value });

    // Register sensitive read VALUES for redaction IMMEDIATELY — before any later model text (e.g. a
    // finish explanation) that might echo them is persisted.
    if (result.ok && decision.action === 'read' && decision.bindOutput && result.readValue && config.sensitiveOutputs?.includes(decision.bindOutput)) {
      evidence.registerSensitive(result.readValue);
    }
    // Structured "what & why": the model's declared intent + expected effect (not chain-of-thought).
    evidence.log('decision', { step, action: decision.action, intent: decision.intent, expectedEffect: decision.expectedEffect, ok: result.ok });

    if (!result.ok) {
      const blocked = result.error?.startsWith('POLICY_DENIED');
      return { status: blocked ? 'blocked' : 'failed', reason: result.error, events };
    }

    events.push({
      intent: decision.intent,
      expectedEffect: decision.expectedEffect,
      action: decision.action!,
      // Prefer the canonical applied value (e.g. a select's option value) so parameterization works.
      rawValue: result.canonicalValue ?? decision.value,
      bindOutput: decision.bindOutput,
      readValue: result.readValue,
      resolved: result.resolved,
      routeRisk,
      url: surface.currentUrl(),
    });
  }
  return { status: 'max_steps', events };
}

function computeRouteRisk(
  policy: PolicyEngine,
  decision: Decision,
  formAction: string | undefined,
  formMethod: string | undefined,
  baseUrl: string
): RouteRisk {
  if (decision.action === 'type' || decision.action === 'select') return 'reversible_write';
  if (decision.action === 'read' || decision.action === 'navigate') return 'read';
  // click:
  if (formAction) {
    let path = formAction;
    try {
      path = new URL(formAction, baseUrl).pathname;
    } catch {
      /* keep */
    }
    return (policy.riskFor(formMethod ?? 'POST', path) ?? 'unknown') as RouteRisk;
  }
  return 'read'; // link/navigation click
}
