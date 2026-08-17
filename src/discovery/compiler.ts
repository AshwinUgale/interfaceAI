/**
 * ArtifactCompiler — deterministically builds a Capability from verified ExecutionEvents. No LLM.
 * Parameterization is by exact value match (executed value === an input value => {param}); error
 * rules and output sensitivity come from caller-supplied domain specs, keeping the compiler generic.
 */
import type { ExecutionEvent, RouteRisk } from './events.js';
import {
  SCHEMA_VERSION,
  zCapability,
  type Capability,
  type ErrorRuleT,
  type Input,
  type Output,
  type Step,
  type ValueSource,
} from '../artifact/schema.js';
import type { ResolvedTarget } from '../surface/types.js';
import type { Predicate } from '../artifact/schema.js';

export interface CompileOptions {
  capabilityId: string;
  capabilityVersion: string;
  name: string;
  description: string;
  runId: string;
  model: { provider: string; id: string };
  applicationFamily: string;
  variant: string;
  versionFingerprint?: string;
  compatibleVariants: string[];
  inputs: Record<string, string>;
  inputSpecs: Input[];
  outputSpecs: Array<{ name: string; type: Output['type']; sensitivity: Output['sensitivity']; description?: string }>;
  outputExtract: Record<string, { kind: Output['extract']['kind']; parse?: Output['extract']['parse'] }>;
  /** Domain policy: app-specific error rules + checkpoints, kept out of the generic compiler. */
  errorPolicy: {
    onErrorFor: (name: string, role: string) => ErrorRuleT[];
    checkpointFor: (name: string, role: string) => Predicate | undefined;
  };
}

const READ_RETRY = { maxAttempts: 3, retryOn: ['CHECKPOINT_TIMEOUT', 'TRANSIENT_LOAD'], safeToRetry: true };
const FILL_RETRY = { maxAttempts: 2, retryOn: ['TRANSIENT_LOAD'], safeToRetry: true };
const CLICK_GET_RETRY = { maxAttempts: 2, retryOn: ['TRANSIENT_LOAD', 'CHECKPOINT_TIMEOUT'], safeToRetry: true };
// Submits and irreversible actions are NEVER re-dispatched (idempotency guard).
const NO_REDISPATCH_RETRY = { maxAttempts: 1, retryOn: [], safeToRetry: false };

type StepRisk = { class: 'read' | 'reversible_write' | 'irreversible'; approval: 'automatic' | 'human_required' };
function riskFor(routeRisk: RouteRisk): StepRisk {
  switch (routeRisk) {
    case 'irreversible':
      return { class: 'irreversible', approval: 'human_required' };
    case 'reversible_write':
      return { class: 'reversible_write', approval: 'automatic' };
    default:
      return { class: 'read', approval: 'automatic' };
  }
}

function descriptorFrom(resolved: ResolvedTarget, mustBeEnabled: boolean, expectedName: string | undefined) {
  return {
    context: { frames: resolved.framePath.map((name) => ({ name })) },
    candidates: resolved.candidates,
    invariants: {
      cardinality: 'exactlyOne' as const,
      mustBeVisible: true,
      mustBeEnabled,
      expectedRole: resolved.role,
      ...(expectedName ? { expectedName } : {}),
    },
    basis: resolved.candidates.map((c) => c.strategy),
  };
}

/** Deterministic, parameterized intent for a param-bearing step (never shows the concrete value). */
function paramIntent(action: 'type' | 'select', param: string, anchorText?: string): string {
  const where = anchorText ? ` into "${anchorText}"` : '';
  return action === 'type' ? `Enter {${param}}${where}` : `Select {${param}}${anchorText ? ` for "${anchorText}"` : ''}`;
}

function valueSource(raw: string | undefined, inputs: Record<string, string>): ValueSource {
  if (raw !== undefined) {
    for (const [name, val] of Object.entries(inputs)) {
      if (val === raw || val.toLowerCase() === raw.toLowerCase()) return { param: name };
    }
  }
  return { literal: raw ?? '' };
}

export function compile(events: ExecutionEvent[], opts: CompileOptions): Capability {
  const steps: Step[] = [];
  const readStepIdByOutput: Record<string, string> = {};

  // Scrub PII input VALUES from free-text intents so the artifact carries no member data.
  const piiValues = opts.inputSpecs
    .filter((s) => s.classification === 'pii')
    .map((s) => ({ name: s.name, val: opts.inputs[s.name] }))
    .filter((x): x is { name: string; val: string } => !!x.val);
  const scrub = (text?: string): string | undefined => {
    if (!text) return text;
    let t = text;
    for (const { name, val } of piiValues) t = t.split(val).join(`{${name}}`);
    return t;
  };

  events.forEach((ev, i) => {
    const id = `step-${String(i).padStart(2, '0')}`;
    // NOTE: the model's free-form expectedEffect is intentionally NOT persisted into the durable
    // artifact — it is discovery diagnostic and can echo page data (member name/balance). It lives
    // (redacted) in the discovery evidence instead. Intents are PII-scrubbed.
    const common = { id, intent: scrub(ev.intent)! };

    if (ev.action === 'navigate') {
      let path = '/';
      try {
        path = new URL(ev.url ?? '/').pathname;
      } catch {
        path = ev.url ?? '/';
      }
      steps.push({ ...common, action: 'navigate', url: path, risk: riskFor('read'), retryPolicy: READ_RETRY });
      return;
    }
    if (!ev.resolved) return;

    if (ev.action === 'type') {
      const value = valueSource(ev.rawValue, opts.inputs);
      steps.push({
        ...common,
        // Parameterize the reviewable intent too, so it doesn't show the discovery-time value.
        intent: 'param' in value ? paramIntent('type', value.param, ev.resolved.anchorText) : common.intent,
        action: 'type',
        target: descriptorFrom(ev.resolved, true, ev.resolved.name || undefined),
        value,
        risk: riskFor(ev.routeRisk),
        retryPolicy: FILL_RETRY,
      });
    } else if (ev.action === 'select') {
      const value = valueSource(ev.rawValue, opts.inputs);
      steps.push({
        ...common,
        intent: 'param' in value ? paramIntent('select', value.param, ev.resolved.anchorText) : common.intent,
        action: 'select',
        target: descriptorFrom(ev.resolved, true, ev.resolved.name || undefined),
        value,
        risk: riskFor(ev.routeRisk),
        retryPolicy: FILL_RETRY,
      });
    } else if (ev.action === 'read') {
      const out = ev.bindOutput!;
      readStepIdByOutput[out] = id;
      steps.push({
        ...common,
        action: 'read',
        target: descriptorFrom(ev.resolved, false, ev.resolved.anchorText || undefined),
        bindOutput: out,
        risk: riskFor('read'),
        retryPolicy: READ_RETRY,
      });
    } else if (ev.action === 'click') {
      const onError = opts.errorPolicy.onErrorFor(ev.resolved.name, ev.resolved.role);
      const checkpoint = opts.errorPolicy.checkpointFor(ev.resolved.name, ev.resolved.role);
      // A GET click (e.g. Search) is safe to re-dispatch; a POST submit / irreversible is not.
      const retryPolicy = ev.routeRisk === 'read' ? CLICK_GET_RETRY : NO_REDISPATCH_RETRY;
      steps.push({
        ...common,
        action: 'click',
        target: descriptorFrom(ev.resolved, true, ev.resolved.name || undefined),
        risk: riskFor(ev.routeRisk),
        ...(checkpoint ? { checkpoint } : {}),
        ...(onError.length ? { onError } : {}),
        retryPolicy,
      });
    }
  });

  const outputs: Output[] = opts.outputSpecs.map((o) => ({
    name: o.name,
    type: o.type,
    sensitivity: o.sensitivity,
    ...(o.description ? { description: o.description } : {}),
    extract: {
      stepId: readStepIdByOutput[o.name] ?? 'step-00',
      kind: opts.outputExtract[o.name]?.kind ?? 'text',
      ...(opts.outputExtract[o.name]?.parse ? { parse: opts.outputExtract[o.name]!.parse } : {}),
    },
  }));

  const capability: Capability = {
    schemaVersion: SCHEMA_VERSION,
    capabilityId: opts.capabilityId,
    capabilityVersion: opts.capabilityVersion,
    name: opts.name,
    description: opts.description,
    recordedAgainst: {
      applicationFamily: opts.applicationFamily,
      surface: 'legacyWeb',
      variant: opts.variant,
      ...(opts.versionFingerprint ? { versionFingerprint: opts.versionFingerprint } : {}),
    },
    compatibleVariants: opts.compatibleVariants,
    preconditions: [{ kind: 'textMatches', text: 'Member Search' }],
    inputs: opts.inputSpecs,
    outputs,
    steps,
    successCondition: {
      all: [{ kind: 'textMatches', text: 'Review New Sub-Account' }, { not: { kind: 'textMatches', text: 'No record found' } }],
    },
    provenance: {
      recordedFromRunId: opts.runId,
      model: opts.model,
      approvalState: 'draft',
    },
  };

  // Validate our own output — the compiler must emit a schema-valid artifact.
  return zCapability.parse(capability);
}
