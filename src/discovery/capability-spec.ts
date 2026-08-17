/**
 * Domain specs for the "open-sub-account" capability: the typed input/output contract the compiler
 * stamps onto the artifact. Kept here so both the discover CLI and evidence generator agree.
 */
import type { CompileOptions } from './compiler.js';
import type { ErrorRuleT, Predicate } from '../artifact/schema.js';

export const CAP = {
  capabilityId: 'open-sub-account',
  capabilityVersion: '1.0.0',
  name: 'Open a member sub-account and reach the review screen',
  description:
    'Look up a member, read their current savings balance, open a new sub-account of a given type with an opening deposit, and reach the review screen. Does not create the account (irreversible; human-required).',
  applicationFamily: 'legacy-cu-servicing',
  versionFingerprint: 'member-search+detail+sub-account-review@v1',
  compatibleVariants: ['base', 'tenant-b'],
} as const;

export const INPUT_SPECS: CompileOptions['inputSpecs'] = [
  { name: 'memberId', type: 'string', required: true, classification: 'pii', description: 'Member identifier to look up' },
  { name: 'accountType', type: 'string', required: true, classification: 'plain', description: 'Sub-account type (savings | money-market | certificate)' },
  { name: 'openingDeposit', type: 'number', required: true, classification: 'plain', description: 'Opening deposit amount in dollars' },
];

export const OUTPUT_SPECS: CompileOptions['outputSpecs'] = [
  { name: 'memberName', type: 'string', sensitivity: 'pii', description: 'Member full name' },
  { name: 'savingsBalance', type: 'money', sensitivity: 'financial', description: 'Current savings balance' },
];

export const OUTPUT_EXTRACT: CompileOptions['outputExtract'] = {
  memberName: { kind: 'text' },
  savingsBalance: { kind: 'text', parse: 'currency' },
};

export const DEFAULT_INPUTS = { memberId: '10001', accountType: 'savings', openingDeposit: '500' };

/**
 * App-specific error rules and checkpoints, keyed by the control acted on. This is DOMAIN policy,
 * kept out of the generic compiler/engine so they stay app-agnostic. The engine only knows generic
 * execution errors; these map observed app states to business/recoverable outcomes.
 */
const R = {
  notFound: { match: { text: 'No record found' }, classify: 'business', outcomeCode: 'MEMBER_NOT_FOUND', action: 'return' } as ErrorRuleT,
  permission: { match: { text: 'do not have permission' }, classify: 'business', outcomeCode: 'PERMISSION_DENIED', action: 'return' } as ErrorRuleT,
  session: { match: { text: 'session has expired' }, classify: 'recoverable', outcomeCode: 'SESSION_EXPIRED', action: 'escalate' } as ErrorRuleT,
  validation: { match: { text: 'must be a positive dollar amount' }, classify: 'business', outcomeCode: 'VALIDATION_ERROR', action: 'return' } as ErrorRuleT,
  notEligible: { match: { text: 'not eligible' }, classify: 'business', outcomeCode: 'NOT_ELIGIBLE', action: 'return' } as ErrorRuleT,
};

export const ERROR_POLICY = {
  onErrorFor(name: string, role: string): ErrorRuleT[] {
    if (name === 'Search') return [R.notFound, R.permission];
    if (role === 'link') return [R.session];
    if (/Continue/.test(name)) return [R.validation, R.notEligible];
    return [];
  },
  checkpointFor(name: string, role: string): Predicate | undefined {
    if (name === 'Search') return { kind: 'textMatches', text: 'Member Details' };
    if (role === 'link') return { kind: 'textMatches', text: 'Open Sub-Account' };
    if (/Continue/.test(name)) return { all: [{ kind: 'textMatches', text: 'Review New Sub-Account' }, { kind: 'textMatches', text: 'Review Reference' }] };
    return undefined;
  },
};
