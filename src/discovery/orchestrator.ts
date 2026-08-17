/**
 * Discovery orchestrator: runs the observe -> decide -> act loop against the live surface via the
 * policy-enforced driver, records typed ExecutionEvents + evidence, and enforces stopping
 * conditions (finish, max steps, and a mechanical dead-end signal).
 */
import type { PolicyEnforcedSurface } from '../surface/policy-surface.js';
import type { PolicyEngine } from '../surface/policy.js';
import type { EvidenceRecorder } from '../evidence/recorder.js';
import type { EscalationManager } from '../escalation/manager.js';
import type { Brain, Decision } from './brain.js';
import type { ExecutionEvent, RouteRisk } from './events.js';

export interface DiscoveryConfig {
  goal: string;
  inputs: Record<string, string>;
  entryUrl: string;
  maxSteps?: number;
  /** Wall-clock stop condition (ms). */
  timeoutMs?: number;
  /** Text that must be present when the model calls finish, else the run is rejected as incomplete. */
  successText?: string;
  /** Output names whose read VALUES are sensitive — registered for redaction the moment they're read. */
  sensitiveOutputs?: string[];
  /** Names of PII inputs whose values to register for redaction (default: all inputs). */
  piiInputs?: string[];
  /** Optional operator: when discovery gets stuck (dead-end/timeout/blocked) it hands off, then resumes. */
  escalation?: EscalationManager;
}

export interface DiscoveryOutcome {
  status: 'success' | 'incomplete' | 'max_steps' | 'timeout' | 'dead_end' | 'blocked' | 'failed';
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
  // Register only PII input values for redaction (honor the classification; keep plain values readable).
  const piiVals = config.piiInputs ? config.piiInputs.map((n) => config.inputs[n]).filter(Boolean) : Object.values(config.inputs);
  for (const v of piiVals) evidence.registerSensitive(v);

  evidence.log('discovery_start', { goal: config.goal, brain: brain.name, entryUrl: config.entryUrl });

  const nav = await surface.navigate(config.entryUrl);
  if (!nav.ok) return { status: 'failed', reason: nav.error, events };
  events.push({ intent: 'Open the target application', action: 'navigate', url: config.entryUrl, routeRisk: 'read' });

  // When an operator is attached, a stuck discovery hands off (bounded), then resumes — the same
  // control-transfer mechanism as replay. Without one, it returns the stuck status as before.
  let discEscalations = 0;
  let started = Date.now();
  const escalateStuck = async (step: number, kind: string, reason: string): Promise<boolean> => {
    if (!config.escalation || discEscalations >= 2) return false;
    discEscalations++;
    const shot = await evidence.shot(surface, `discovery-stuck-${kind}`);
    await config.escalation.escalate({
      capabilityId: 'discovery',
      goal: config.goal,
      stepId: `discovery-step-${step}`,
      reason: `${kind}: ${reason}`,
      actionState: 'not_attempted',
      sideEffectUncertain: false,
      screenshotRef: shot,
      currentUrl: surface.currentUrl(),
    });
    return true;
  };

  const fingerprints: string[] = [];
  for (let step = 0; step < maxSteps; step++) {
    if (config.timeoutMs && Date.now() - started > config.timeoutMs) {
      evidence.log('timeout', { step, timeoutMs: config.timeoutMs });
      if (await escalateStuck(step, 'timeout', `exceeded ${config.timeoutMs}ms`)) {
        started = Date.now();
        continue;
      }
      return { status: 'timeout', reason: `exceeded ${config.timeoutMs}ms`, events };
    }

    const observation = await surface.observe();

    // Dead-end: identical observation three times running.
    fingerprints.push(observation.outline);
    const last3 = fingerprints.slice(-3);
    if (last3.length === 3 && last3.every((f) => f === last3[0])) {
      evidence.log('dead_end', { step });
      if (await escalateStuck(step, 'dead_end', 'observation unchanged 3x')) {
        fingerprints.length = 0;
        continue;
      }
      return { status: 'dead_end', reason: 'observation unchanged 3x', events };
    }

    let decision: Decision;
    try {
      const remaining = config.timeoutMs ? config.timeoutMs - (Date.now() - started) : Infinity;
      decision = await withDeadline(brain.next({ goal: config.goal, inputs: config.inputs, observation, url: observation.url, stepIndex: step }), remaining);
    } catch (e) {
      if ((e as Error).message === '__DEADLINE__') {
        // Hard wall-clock deadline: even a hung model call is interrupted here.
        evidence.log('timeout', { step, timeoutMs: config.timeoutMs, during: 'brain.next' });
        if (await escalateStuck(step, 'timeout', 'model call exceeded deadline')) {
          started = Date.now();
          continue;
        }
        return { status: 'timeout', reason: 'model call exceeded deadline', events };
      }
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
    const routeRisk = computeRouteRisk(policy, decision, node?.attrs.formAction, node?.attrs.formMethod, node?.attrs.href, surface.currentUrl());

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
      if (blocked && (await escalateStuck(step, 'blocked', result.error!))) continue;
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

/** Race a promise against a wall-clock deadline (rejects with __DEADLINE__). */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!isFinite(ms)) return p;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('__DEADLINE__')), Math.max(0, ms))),
  ]);
}

function computeRouteRisk(
  policy: PolicyEngine,
  decision: Decision,
  formAction: string | undefined,
  formMethod: string | undefined,
  href: string | undefined,
  baseUrl: string
): RouteRisk {
  if (decision.action === 'type' || decision.action === 'select') return 'reversible_write';
  if (decision.action === 'read' || decision.action === 'navigate') return 'read';
  // click:
  const pathOf = (u: string) => {
    try {
      return new URL(u, baseUrl).pathname;
    } catch {
      return u;
    }
  };
  if (formAction) return (policy.riskFor(formMethod ?? 'POST', pathOf(formAction)) ?? 'unknown') as RouteRisk;
  // A GET link is a read/navigation unless the allowlist explicitly marks its route irreversible.
  if (href) return policy.riskFor('GET', pathOf(href)) === 'irreversible' ? 'irreversible' : 'read';
  return 'read';
}
