/**
 * ReplayEngine — deterministic execution of a capability artifact. NO LLM in the decision loop.
 *
 * Order of operations per run: schema/version check -> input validation -> execute steps
 * (precondition -> resolve target with cardinality -> act with retry/idempotency guard ->
 * error rules -> checkpoint) -> success condition. Errors are classified business / recoverable /
 * hard-failure. Recoverable+escalate hands off to a human on the same session, then retries.
 */
import { type Capability, type ErrorRuleT, type Step, type ValueSource } from '../artifact/schema.js';
import { evalPredicate, waitForPredicate } from '../artifact/predicate.js';
import type { SurfaceDriver } from '../surface/driver.js';
import type { TargetDescriptor } from '../surface/types.js';
import type { EvidenceRecorder } from '../evidence/recorder.js';
import type { EscalationManager } from '../escalation/manager.js';
import type { ReplayResult, StepTrace } from './result.js';

export interface ReplayOptions {
  targetBase: string;
  approved?: boolean;
  escalation?: EscalationManager;
}

function resolveValue(v: ValueSource, inputs: Record<string, string>): string {
  return 'param' in v ? inputs[v.param] ?? '' : v.literal;
}

function urlMatches(url: string, pattern: string): boolean {
  try {
    return new RegExp(pattern).test(url);
  } catch {
    return url.includes(pattern);
  }
}

async function matchRule(driver: SurfaceDriver, rule: ErrorRuleT): Promise<boolean> {
  if (rule.match.text && (await driver.textPresent(rule.match.text))) return true;
  if (rule.match.url && urlMatches(driver.currentUrl(), rule.match.url)) return true;
  return false;
}

function parseOutput(cap: Capability, name: string, raw: string): string | number {
  const spec = cap.outputs.find((o) => o.name === name);
  const parse = spec?.extract.parse;
  if (parse === 'currency') return Number(raw.replace(/[$,\s]/g, ''));
  if (parse === 'number') return Number(raw);
  return raw;
}

export async function replay(
  capability: Capability,
  inputs: Record<string, string>,
  surface: SurfaceDriver,
  evidence: EvidenceRecorder,
  opts: ReplayOptions
): Promise<ReplayResult> {
  for (const spec of capability.inputs) if (spec.classification === 'pii') evidence.registerSensitive(inputs[spec.name]);
  evidence.log('replay_start', {
    capabilityId: capability.capabilityId,
    capabilityVersion: capability.capabilityVersion,
    target: opts.targetBase,
    llmCalls: 0,
  });

  // Schema/version compatibility.
  const major = capability.schemaVersion.split('.')[0];
  if (major !== '1') return { status: 'invalid_invocation', field: 'schemaVersion', message: `unsupported schema ${capability.schemaVersion}` };

  // Invocation validation (before any UI).
  for (const spec of capability.inputs) {
    const v = inputs[spec.name];
    if (spec.required && (v === undefined || v === '')) return { status: 'invalid_invocation', field: spec.name, message: 'required input missing' };
    if (v !== undefined && spec.type === 'number' && !Number.isFinite(Number(v)))
      return { status: 'invalid_invocation', field: spec.name, message: 'expected a number' };
  }

  const steps: StepTrace[] = [];
  const outputs: Record<string, string | number> = {};
  let preconChecked = false;

  const fail = (code: string, stepId?: string, expected?: string, observed?: string, evidenceRefs?: string[]): ReplayResult => {
    evidence.log('replay_failure', { code, stepId, expected, observed });
    return { status: 'failure', error: { code, stepId, expected, observed, evidenceRefs }, steps };
  };

  for (const step of capability.steps) {
    // Ownership: automation may only act while it holds the control token (real check, not a claim).
    if (opts.escalation) opts.escalation.token.assertAgentOwns();

    // Risk gate.
    if ('risk' in step && step.risk.approval === 'human_required' && !opts.approved) {
      if (!opts.escalation) return fail('NEEDS_APPROVAL', step.id);
      await opts.escalation.escalate({
        capabilityId: capability.capabilityId,
        goal: capability.name,
        stepId: step.id,
        reason: 'irreversible step requires human approval',
        actionState: 'not_attempted',
        sideEffectUncertain: false,
        currentUrl: surface.currentUrl(),
      });
      // Human approved by resuming; proceed.
    }

    if (step.action === 'navigate') {
      const url = new URL(step.url, opts.targetBase).toString();
      const r = await surface.navigate(url);
      steps.push({ stepId: step.id, action: 'navigate', ok: r.ok, note: url });
      if (!r.ok) return fail('NAVIGATION_FAILED', step.id, url, r.error);
      if (!preconChecked) {
        preconChecked = true;
        for (const p of capability.preconditions) {
          if (!(await evalPredicate(surface, p))) return fail('PRECONDITION_UNMET', step.id, JSON.stringify(p));
        }
      }
      continue;
    }
    if (step.action === 'waitFor') {
      const ok = await waitForPredicate(surface, step.waitFor, step.timeoutMs);
      steps.push({ stepId: step.id, action: 'waitFor', ok });
      if (!ok) return fail('WAIT_TIMEOUT', step.id, JSON.stringify(step.waitFor));
      continue;
    }
    if (step.action === 'assert') {
      const ok = await evalPredicate(surface, step.predicate);
      steps.push({ stepId: step.id, action: 'assert', ok });
      if (!ok) return fail('ASSERT_FAILED', step.id, JSON.stringify(step.predicate));
      continue;
    }

    // Precondition for action steps.
    if ('precondition' in step && step.precondition && !(await evalPredicate(surface, step.precondition))) {
      return fail('PRECONDITION_UNMET', step.id, JSON.stringify(step.precondition));
    }

    const target = step.target as unknown as TargetDescriptor;
    const value = 'value' in step ? resolveValue(step.value, inputs) : undefined;
    const retry = step.retryPolicy;

    let attempts = 0;
    let escalations = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempts++;
      const { result, resolution } = await surface.resolveAndAct(target, step.action, value);

      if (resolution.status === 'context_missing') {
        steps.push({ stepId: step.id, action: step.action, ok: false, resolution, attempts });
        return fail('TARGET_CONTEXT_NOT_FOUND', step.id, JSON.stringify(target.context), 'expected frame not present');
      }
      if (resolution.status === 'ambiguous') {
        steps.push({ stepId: step.id, action: step.action, ok: false, resolution, attempts });
        return fail('TARGET_AMBIGUOUS', step.id, 'exactlyOne match', `${resolution.matchCount} matches`);
      }
      if (resolution.status === 'not_found') {
        if (retry.safeToRetry && attempts < retry.maxAttempts && retry.retryOn.includes('TRANSIENT_LOAD')) continue;
        steps.push({ stepId: step.id, action: step.action, ok: false, resolution, attempts });
        return fail('TARGET_NOT_FOUND', step.id, JSON.stringify(target.candidates[0]));
      }
      if (!result.ok) {
        // Idempotency guard: only retry when safe.
        if (retry.safeToRetry && attempts < retry.maxAttempts) continue;
        steps.push({ stepId: step.id, action: step.action, ok: false, resolution, attempts });
        return fail('ACTION_FAILED', step.id, undefined, result.error);
      }

      if (step.action === 'read') {
        const parsed = parseOutput(capability, step.bindOutput, result.readValue ?? '');
        outputs[step.bindOutput] = parsed;
        // Redact sensitive output values from persisted evidence (respect the artifact's metadata).
        const spec = capability.outputs.find((o) => o.name === step.bindOutput);
        if (spec && spec.sensitivity !== 'plain') {
          evidence.registerSensitive(String(result.readValue ?? ''));
          evidence.registerSensitive(String(parsed));
        }
      }

      // Error rules (business / recoverable / hard-failure) evaluated on the resulting state.
      let escalatedRetry = false;
      if ('onError' in step && step.onError) {
        for (const rule of step.onError) {
          if (!(await matchRule(surface, rule))) continue;
          evidence.log('error_rule', { stepId: step.id, classify: rule.classify, code: rule.outcomeCode });
          if (rule.classify === 'business') {
            steps.push({ stepId: step.id, action: step.action, ok: true, resolution, attempts, note: rule.outcomeCode });
            return { status: 'business_outcome', code: rule.outcomeCode ?? 'BUSINESS_OUTCOME', steps };
          }
          if (rule.classify === 'hardFailure') {
            return fail(rule.outcomeCode ?? 'HARD_FAILURE', step.id);
          }
          if (rule.classify === 'recoverable' && rule.action === 'escalate') {
            if (!opts.escalation || escalations >= 1) return fail('NEEDS_HUMAN', step.id, undefined, rule.outcomeCode);
            escalations++;
            const shot = await evidence.shot(surface, 'escalation');
            await opts.escalation.escalate({
              capabilityId: capability.capabilityId,
              goal: capability.name,
              stepId: step.id,
              reason: rule.outcomeCode ?? 'recoverable condition',
              outcomeCode: rule.outcomeCode,
              actionState: 'completed',
              sideEffectUncertain: false,
              screenshotRef: shot,
              currentUrl: surface.currentUrl(),
            });
            escalatedRetry = true;
            break;
          }
        }
      }
      if (escalatedRetry) {
        attempts = 0;
        continue; // human fixed state on the same session; re-attempt this step
      }

      // Checkpoint.
      if ('checkpoint' in step && step.checkpoint) {
        const ok = await waitForPredicate(surface, step.checkpoint, 4000);
        if (!ok) {
          // Retry a failed checkpoint only for actions declared safe to re-dispatch AND only when
          // CHECKPOINT_TIMEOUT is a declared retryOn condition (never blindly re-submit a write).
          if (retry.safeToRetry && attempts < retry.maxAttempts && retry.retryOn.includes('CHECKPOINT_TIMEOUT')) continue;
          const shot = await evidence.shot(surface, 'checkpoint-fail');
          steps.push({ stepId: step.id, action: step.action, ok: false, resolution, attempts });
          return fail('CHECKPOINT_TIMEOUT', step.id, JSON.stringify(step.checkpoint), surface.currentUrl(), [shot]);
        }
      }

      steps.push({ stepId: step.id, action: step.action, ok: true, resolution, attempts });
      break;
    }
  }

  if (!(await evalPredicate(surface, capability.successCondition))) {
    const shot = await evidence.shot(surface, 'success-fail');
    return fail('SUCCESS_CONDITION_UNMET', undefined, JSON.stringify(capability.successCondition), surface.currentUrl(), [shot]);
  }
  evidence.log('replay_success', { outputs });
  return { status: 'success', outputs, steps };
}
