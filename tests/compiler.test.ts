import { describe, it, expect } from 'vitest';
import { compile } from '../src/discovery/compiler.js';
import type { ExecutionEvent } from '../src/discovery/events.js';
import { CAP, INPUT_SPECS, OUTPUT_SPECS, OUTPUT_EXTRACT, ERROR_POLICY } from '../src/discovery/capability-spec.js';

const events: ExecutionEvent[] = [
  { intent: 'open', action: 'navigate', url: 'http://localhost:4000/', routeRisk: 'read' },
  {
    // Intent embeds the member id — the compiler must scrub it.
    intent: 'Enter the member ID 10001 to search',
    action: 'type',
    rawValue: '10001',
    routeRisk: 'reversible_write',
    resolved: { role: 'textbox', name: '', framePath: ['workspace'], anchorText: 'Member ID', candidates: [{ strategy: 'anchorCell', anchorText: 'Member ID', control: 'input' }] },
  },
  {
    intent: 'read member name',
    action: 'read',
    bindOutput: 'memberName',
    readValue: 'Jane A. Rivera',
    routeRisk: 'read',
    resolved: { role: 'cell', name: 'Jane A. Rivera', framePath: ['workspace'], anchorText: 'Member Name', rowText: 'Member NameJane A. Rivera', candidates: [{ strategy: 'tableCell', rowContainsText: 'Member Name', column: 2 }] },
  },
  {
    intent: 'read savings balance',
    action: 'read',
    bindOutput: 'savingsBalance',
    readValue: '$4,250.00',
    routeRisk: 'read',
    resolved: { role: 'cell', name: '$4,250.00', framePath: ['workspace', 'accountSummary'], anchorText: 'Savings', rowText: 'Savings$4,250.00', candidates: [{ strategy: 'tableCell', rowContainsText: 'Savings', column: 2 }] },
  },
  {
    // Model selected the LABEL "Savings"; the driver reports canonical value "savings".
    intent: 'choose account type',
    action: 'select',
    rawValue: 'savings',
    routeRisk: 'reversible_write',
    resolved: { role: 'combobox', name: '', framePath: ['workspace'], anchorText: 'Account Type', candidates: [{ strategy: 'anchorCell', anchorText: 'Account Type', control: 'select' }] },
  },
  {
    intent: 'continue to review',
    action: 'click',
    routeRisk: 'reversible_write',
    resolved: { role: 'button', name: 'Continue to Review', framePath: ['workspace'], candidates: [{ strategy: 'roleName', role: 'button', name: 'Continue to Review' }] },
  },
];

describe('artifact compiler (deterministic, no LLM)', () => {
  const cap = compile(events, {
    capabilityId: CAP.capabilityId,
    capabilityVersion: CAP.capabilityVersion,
    name: CAP.name,
    description: CAP.description,
    runId: 'disc-test',
    model: { provider: 'scripted', id: 'scripted' },
    applicationFamily: CAP.applicationFamily,
    variant: 'base',
    compatibleVariants: [...CAP.compatibleVariants],
    inputs: { memberId: '10001', accountType: 'savings', openingDeposit: '500' },
    inputSpecs: INPUT_SPECS,
    outputSpecs: OUTPUT_SPECS,
    outputExtract: OUTPUT_EXTRACT,
    errorPolicy: ERROR_POLICY,
  });

  it('parameterizes a typed value that matches an input (10001 -> {param: memberId})', () => {
    const typeStep = cap.steps.find((s) => s.action === 'type')!;
    expect('value' in typeStep && typeStep.value).toEqual({ param: 'memberId' });
  });

  it('scrubs member PII from intent text (no 10001 anywhere in the artifact)', () => {
    const typeStep = cap.steps.find((s) => s.action === 'type')!;
    expect(typeStep.intent).toBe('Enter the member ID {memberId} to search');
    expect(JSON.stringify(cap)).not.toContain('10001');
  });

  it('parameterizes accountType from the canonical select value (not the label)', () => {
    const selectStep = cap.steps.find((s) => s.action === 'select')!;
    expect('value' in selectStep && selectStep.value).toEqual({ param: 'accountType' });
  });

  it('marks a POST submit click as not safe to re-dispatch', () => {
    const clickStep = cap.steps.find((s) => s.action === 'click')!;
    expect('retryPolicy' in clickStep && clickStep.retryPolicy.safeToRetry).toBe(false);
  });

  it('anchors the read locator on the label, and never embeds the member value', () => {
    const readStep = cap.steps.find((s) => s.action === 'read')!;
    expect('target' in readStep && readStep.target.invariants.expectedName).toBe('Member Name');
    expect(JSON.stringify(cap).includes('Jane')).toBe(false);
  });

  it('binds the output to the read step', () => {
    const out = cap.outputs.find((o) => o.name === 'memberName')!;
    const readStep = cap.steps.find((s) => s.action === 'read')!;
    expect(out.extract.stepId).toBe(readStep.id);
    expect(out.sensitivity).toBe('pii');
  });
});
