import { describe, it, expect } from 'vitest';
import { compile } from '../src/discovery/compiler.js';
import type { ExecutionEvent } from '../src/discovery/events.js';
import { CAP, INPUT_SPECS, OUTPUT_SPECS, OUTPUT_EXTRACT } from '../src/discovery/capability-spec.js';

const events: ExecutionEvent[] = [
  { intent: 'open', action: 'navigate', url: 'http://localhost:4000/', routeRisk: 'read' },
  {
    intent: 'enter member id',
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
  });

  it('parameterizes a typed value that matches an input (10001 -> {param: memberId})', () => {
    const typeStep = cap.steps.find((s) => s.action === 'type')!;
    expect('value' in typeStep && typeStep.value).toEqual({ param: 'memberId' });
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
