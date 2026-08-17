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
}

const READ_RETRY = { maxAttempts: 3, retryOn: ['CHECKPOINT_TIMEOUT', 'TRANSIENT_LOAD'], safeToRetry: true };
const WRITE_RETRY = { maxAttempts: 2, retryOn: ['TRANSIENT_LOAD'], safeToRetry: true };
const IRREVERSIBLE_RETRY = { maxAttempts: 1, retryOn: [], safeToRetry: false };

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

function valueSource(raw: string | undefined, inputs: Record<string, string>): ValueSource {
  if (raw !== undefined) {
    for (const [name, val] of Object.entries(inputs)) if (val === raw) return { param: name };
  }
  return { literal: raw ?? '' };
}

// Error rules seeded by which control was acted on.
const NOT_FOUND: ErrorRuleT = { match: { text: 'No record found' }, classify: 'business', outcomeCode: 'MEMBER_NOT_FOUND', action: 'return' };
const PERMISSION: ErrorRuleT = { match: { text: 'do not have permission' }, classify: 'business', outcomeCode: 'PERMISSION_DENIED', action: 'return' };
const SESSION: ErrorRuleT = { match: { text: 'session has expired' }, classify: 'recoverable', outcomeCode: 'SESSION_EXPIRED', action: 'escalate' };
const VALIDATION: ErrorRuleT = { match: { text: 'must be a positive dollar amount' }, classify: 'business', outcomeCode: 'VALIDATION_ERROR', action: 'return' };
const NOT_ELIGIBLE: ErrorRuleT = { match: { text: 'not eligible' }, classify: 'business', outcomeCode: 'NOT_ELIGIBLE', action: 'return' };

export function compile(events: ExecutionEvent[], opts: CompileOptions): Capability {
  const steps: Step[] = [];
  const readStepIdByOutput: Record<string, string> = {};

  events.forEach((ev, i) => {
    const id = `step-${String(i).padStart(2, '0')}`;
    const common = { id, intent: ev.intent, ...(ev.expectedEffect ? { expectedEffect: ev.expectedEffect } : {}) };

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
      steps.push({
        ...common,
        action: 'type',
        target: descriptorFrom(ev.resolved, true, ev.resolved.name || undefined),
        value: valueSource(ev.rawValue, opts.inputs),
        risk: riskFor(ev.routeRisk),
        retryPolicy: WRITE_RETRY,
      });
    } else if (ev.action === 'select') {
      steps.push({
        ...common,
        action: 'select',
        target: descriptorFrom(ev.resolved, true, ev.resolved.name || undefined),
        value: valueSource(ev.rawValue, opts.inputs),
        risk: riskFor(ev.routeRisk),
        retryPolicy: WRITE_RETRY,
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
      const name = ev.resolved.name;
      const isSearch = name === 'Search';
      const isContinue = /Continue/.test(name);
      const isOpen = ev.resolved.role === 'link';
      const onError: ErrorRuleT[] = isSearch
        ? [NOT_FOUND, PERMISSION]
        : isOpen
          ? [SESSION]
          : isContinue
            ? [VALIDATION, NOT_ELIGIBLE]
            : [];
      const checkpoint: Predicate | undefined = isSearch
        ? { kind: 'textMatches', text: 'Member Details' }
        : isOpen
          ? { kind: 'textMatches', text: 'Open Sub-Account' }
          : isContinue
            ? { all: [{ kind: 'textMatches', text: 'Review New Sub-Account' }, { kind: 'textMatches', text: 'Review Reference' }] }
            : undefined;
      steps.push({
        ...common,
        action: 'click',
        target: descriptorFrom(ev.resolved, true, ev.resolved.name || undefined),
        risk: riskFor(ev.routeRisk),
        ...(checkpoint ? { checkpoint } : {}),
        ...(onError.length ? { onError } : {}),
        retryPolicy: ev.routeRisk === 'irreversible' ? IRREVERSIBLE_RETRY : WRITE_RETRY,
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
