/**
 * The capability artifact contract, as Zod schemas (runtime-validated) with inferred TS types.
 * This is the focal point of the design: a typed, versioned, reviewable capability an agent can
 * call. See docs/DESIGN.md section 2.
 */
import { z } from 'zod';

export const SCHEMA_VERSION = '1.0';

export const zRole = z.enum(['button', 'link', 'textbox', 'combobox', 'heading', 'cell', 'text', 'other']);

export const zLocatorCandidate = z.discriminatedUnion('strategy', [
  z.object({ strategy: z.literal('roleName'), role: zRole, name: z.string() }),
  z.object({ strategy: z.literal('labelledField'), label: z.string() }),
  z.object({
    strategy: z.literal('anchorCell'),
    anchorText: z.string(),
    control: z.enum(['input', 'select', 'textarea']),
  }),
  z.object({ strategy: z.literal('tableCell'), rowContainsText: z.string(), column: z.number().int().positive() }),
  z.object({ strategy: z.literal('text'), text: z.string() }),
]);

export const zTargetDescriptor = z.object({
  context: z.object({ frames: z.array(z.object({ name: z.string() })) }),
  candidates: z.array(zLocatorCandidate).min(1),
  invariants: z.object({
    cardinality: z.literal('exactlyOne'),
    mustBeVisible: z.boolean(),
    mustBeEnabled: z.boolean(),
    // Enforced at resolve time: cardinality (exactlyOne), visibility, enabled, and frame context.
    // `expectedRole`/`expectedName` are ADVISORY review metadata recorded from discovery — the
    // recorded role and the control's accessible name or anchor LABEL (for a value read this is the
    // label, e.g. "Member Name", not the value). They are not re-verified (the candidate strategy
    // already encodes role/name for roleName candidates).
    expectedRole: zRole.optional(),
    expectedName: z.string().optional(),
  }),
  basis: z.array(z.string()).optional(),
});

// Recursive compound predicate.
export type Predicate =
  | { all: Predicate[] }
  | { any: Predicate[] }
  | { not: Predicate }
  | { kind: 'urlMatches'; pattern: string }
  | { kind: 'textMatches'; text: string }
  | { kind: 'elementPresent'; target: z.infer<typeof zTargetDescriptor> }
  | { kind: 'valueEquals'; target: z.infer<typeof zTargetDescriptor>; value: string };

export const zPredicate: z.ZodType<Predicate> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(zPredicate) }),
    z.object({ any: z.array(zPredicate) }),
    z.object({ not: zPredicate }),
    z.object({ kind: z.literal('urlMatches'), pattern: z.string() }),
    z.object({ kind: z.literal('textMatches'), text: z.string() }),
    z.object({ kind: z.literal('elementPresent'), target: zTargetDescriptor }),
    z.object({ kind: z.literal('valueEquals'), target: zTargetDescriptor, value: z.string() }),
  ])
);

export const zRisk = z.object({
  class: z.enum(['read', 'reversible_write', 'irreversible']),
  approval: z.enum(['automatic', 'human_required']),
});

export const zRetryPolicy = z.object({
  maxAttempts: z.number().int().min(1),
  retryOn: z.array(z.string()),
  safeToRetry: z.boolean(),
});

export const zErrorRule = z.object({
  match: z.object({ text: z.string().optional(), url: z.string().optional() }),
  classify: z.enum(['business', 'recoverable', 'hardFailure']),
  outcomeCode: z.string().optional(),
  action: z.enum(['return', 'retry', 'dismissThenContinue', 'escalate', 'abort']),
});

export const zValueSource = z.union([z.object({ literal: z.string() }), z.object({ param: z.string() })]);

const stepCommon = {
  id: z.string(),
  intent: z.string(),
  expectedEffect: z.string().optional(),
};

export const zStep = z.discriminatedUnion('action', [
  z.object({
    ...stepCommon,
    action: z.literal('navigate'),
    url: z.string(),
    risk: zRisk,
    checkpoint: zPredicate.optional(),
    retryPolicy: zRetryPolicy,
  }),
  z.object({
    ...stepCommon,
    action: z.literal('click'),
    target: zTargetDescriptor,
    risk: zRisk,
    precondition: zPredicate.optional(),
    checkpoint: zPredicate.optional(),
    retryPolicy: zRetryPolicy,
    onError: z.array(zErrorRule).optional(),
  }),
  z.object({
    ...stepCommon,
    action: z.literal('type'),
    target: zTargetDescriptor,
    value: zValueSource,
    risk: zRisk,
    precondition: zPredicate.optional(),
    checkpoint: zPredicate.optional(),
    retryPolicy: zRetryPolicy,
    onError: z.array(zErrorRule).optional(),
  }),
  z.object({
    ...stepCommon,
    action: z.literal('select'),
    target: zTargetDescriptor,
    value: zValueSource,
    risk: zRisk,
    precondition: zPredicate.optional(),
    checkpoint: zPredicate.optional(),
    retryPolicy: zRetryPolicy,
    onError: z.array(zErrorRule).optional(),
  }),
  z.object({
    ...stepCommon,
    action: z.literal('read'),
    target: zTargetDescriptor,
    bindOutput: z.string(),
    risk: zRisk,
    precondition: zPredicate.optional(),
    retryPolicy: zRetryPolicy,
    onError: z.array(zErrorRule).optional(),
  }),
  z.object({ ...stepCommon, action: z.literal('waitFor'), waitFor: zPredicate, timeoutMs: z.number().int().positive() }),
  z.object({ ...stepCommon, action: z.literal('assert'), predicate: zPredicate }),
]);

export const zInput = z.object({
  name: z.string(),
  type: z.enum(['string', 'number']),
  required: z.boolean(),
  classification: z.enum(['plain', 'pii']),
  description: z.string().optional(),
});

export const zOutput = z.object({
  name: z.string(),
  type: z.enum(['string', 'number', 'money']),
  sensitivity: z.enum(['plain', 'pii', 'financial']),
  description: z.string().optional(),
  extract: z.object({
    stepId: z.string(),
    // Extraction is role-driven at replay: a textbox/combobox yields its 'value' (inputValue),
    // anything else yields 'text' (innerText). Only these two are implemented.
    kind: z.enum(['text', 'value']),
    parse: z.enum(['currency', 'number', 'date']).optional(),
  }),
});

export const zCapability = z.object({
  schemaVersion: z.string(),
  capabilityId: z.string(),
  capabilityVersion: z.string(),
  name: z.string(),
  description: z.string(),
  recordedAgainst: z.object({
    applicationFamily: z.string(),
    surface: z.enum(['web', 'legacyWeb', 'desktop']),
    variant: z.string(),
    versionFingerprint: z.string().optional(),
  }),
  compatibleVariants: z.array(z.string()),
  preconditions: z.array(zPredicate),
  inputs: z.array(zInput),
  outputs: z.array(zOutput),
  steps: z.array(zStep).min(1),
  successCondition: zPredicate,
  provenance: z.object({
    recordedFromRunId: z.string(),
    model: z.object({ provider: z.string(), id: z.string() }),
    approvalState: z.enum(['draft', 'approved']),
  }),
}).superRefine((cap, ctx) => {
  // Cross-field integrity: params/outputs/extract must reference declared, existing things, and
  // ids/names must be unique.
  const dupes = (arr: string[]) => [...new Set(arr.filter((v, i) => arr.indexOf(v) !== i))];
  for (const d of dupes(cap.steps.map((s) => s.id))) ctx.addIssue({ code: 'custom', message: `duplicate step id '${d}'` });
  for (const d of dupes(cap.inputs.map((i) => i.name))) ctx.addIssue({ code: 'custom', message: `duplicate input name '${d}'` });
  for (const d of dupes(cap.outputs.map((o) => o.name))) ctx.addIssue({ code: 'custom', message: `duplicate output name '${d}'` });

  const inputNames = new Set(cap.inputs.map((i) => i.name));
  const outputNames = new Set(cap.outputs.map((o) => o.name));
  const readBindings = new Map(cap.steps.filter((s) => s.action === 'read').map((s) => [s.id, s.bindOutput]));
  for (const s of cap.steps) {
    if ((s.action === 'type' || s.action === 'select') && 'param' in s.value && !inputNames.has(s.value.param)) {
      ctx.addIssue({ code: 'custom', message: `step ${s.id} references undeclared input '${s.value.param}'` });
    }
    if (s.action === 'read' && !outputNames.has(s.bindOutput)) {
      ctx.addIssue({ code: 'custom', message: `read step ${s.id} binds undeclared output '${s.bindOutput}'` });
    }
  }
  for (const o of cap.outputs) {
    // The extract step must be a read step that actually binds THIS output (not just any read step).
    if (readBindings.get(o.extract.stepId) !== o.name) {
      ctx.addIssue({ code: 'custom', message: `output '${o.name}' extract.stepId '${o.extract.stepId}' must be a read step binding '${o.name}'` });
    }
  }
});

export type Capability = z.infer<typeof zCapability>;
export type Step = z.infer<typeof zStep>;
export type Input = z.infer<typeof zInput>;
export type Output = z.infer<typeof zOutput>;
export type ErrorRuleT = z.infer<typeof zErrorRule>;
export type ValueSource = z.infer<typeof zValueSource>;
export type ArtifactTargetDescriptor = z.infer<typeof zTargetDescriptor>;
