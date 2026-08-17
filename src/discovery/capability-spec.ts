/**
 * Domain specs for the "open-sub-account" capability: the typed input/output contract the compiler
 * stamps onto the artifact. Kept here so both the discover CLI and evidence generator agree.
 */
import type { CompileOptions } from './compiler.js';

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
