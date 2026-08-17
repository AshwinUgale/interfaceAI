/**
 * The discovery "brain" decides the next action from the current observation. Two implementations:
 *  - LlmBrain (discovery/llm-brain.ts): a real model. The genuine discovery path.
 *  - ScriptedBrain (below): a no-key harness that drives the SAME observe/act/policy/evidence path
 *    with a fixed intent list, so the end-to-end pipeline and evidence can be produced without a
 *    model key. It resolves each intent against the live observation (it does not hard-code refs).
 */
import type { ActionType, Observation, ObservationRef } from '../surface/types.js';

export interface DiscoveryContext {
  goal: string;
  inputs: Record<string, string>;
  observation: Observation;
  url: string;
  stepIndex: number;
}

export interface Decision {
  kind: 'act' | 'finish';
  action?: ActionType;
  ref?: ObservationRef;
  url?: string;
  value?: string;
  intent: string;
  expectedEffect?: string;
  bindOutput?: string;
}

export interface Brain {
  readonly name: string;
  next(ctx: DiscoveryContext): Promise<Decision>;
}

// ---- Scripted brain -----------------------------------------------------------------------

type Spec =
  | { do: 'type'; anchor: string; valueFrom: string; intent: string; expectedEffect: string }
  | { do: 'select'; anchor: string; valueFrom: string; intent: string; expectedEffect: string }
  | { do: 'click'; role: 'button' | 'link'; name: string; intent: string; expectedEffect: string }
  | { do: 'read'; row: string; frame?: string; bindOutput: string; intent: string }
  | { do: 'finish'; intent: string };

/** The canonical flow, expressed as resolvable intents (base-tenant labels). */
const CANONICAL: Spec[] = [
  { do: 'type', anchor: 'Member ID', valueFrom: 'memberId', intent: 'Enter the member ID', expectedEffect: 'member id is filled in' },
  { do: 'click', role: 'button', name: 'Search', intent: 'Submit the member search', expectedEffect: 'member detail or not-found appears' },
  { do: 'read', row: 'Member Name', bindOutput: 'memberName', intent: 'Read the member name' },
  { do: 'read', row: 'Savings', frame: 'accountSummary', bindOutput: 'savingsBalance', intent: 'Read the current savings balance' },
  { do: 'click', role: 'link', name: 'Open New Account', intent: 'Start opening a sub-account', expectedEffect: 'the sub-account form appears' },
  { do: 'select', anchor: 'Account Type', valueFrom: 'accountType', intent: 'Choose the account type', expectedEffect: 'account type selected' },
  { do: 'type', anchor: 'Opening Deposit', valueFrom: 'openingDeposit', intent: 'Enter the opening deposit', expectedEffect: 'deposit filled in' },
  { do: 'click', role: 'button', name: 'Continue to Review', intent: 'Continue to the review screen', expectedEffect: 'review screen with a reference appears' },
  { do: 'finish', intent: 'Reached the review screen — goal complete' },
];

export class ScriptedBrain implements Brain {
  readonly name = 'scripted';
  private idx = 0;
  constructor(private readonly specs: Spec[] = CANONICAL) {}

  async next(ctx: DiscoveryContext): Promise<Decision> {
    const spec = this.specs[this.idx++];
    if (!spec || spec.do === 'finish') return { kind: 'finish', intent: spec?.intent ?? 'done' };
    const nodes = ctx.observation.nodes;
    if (spec.do === 'type' || spec.do === 'select') {
      const node = nodes.find(
        (n) => n.anchorText === spec.anchor && (n.role === 'textbox' || n.role === 'combobox')
      );
      if (!node) throw new Error(`scripted: no field anchored "${spec.anchor}"`);
      return {
        kind: 'act',
        action: spec.do === 'type' ? 'type' : 'select',
        ref: node.ref,
        value: ctx.inputs[spec.valueFrom] ?? '',
        intent: spec.intent,
        expectedEffect: spec.expectedEffect,
      };
    }
    if (spec.do === 'click') {
      const node = nodes.find((n) => n.role === spec.role && n.name === spec.name);
      if (!node) throw new Error(`scripted: no ${spec.role} named "${spec.name}"`);
      return { kind: 'act', action: 'click', ref: node.ref, intent: spec.intent, expectedEffect: spec.expectedEffect };
    }
    // read: last cell in the matching row (the value cell), optionally within a frame.
    const matches = nodes.filter(
      (n) => n.role === 'cell' && n.rowText?.includes(spec.row) && (!spec.frame || n.framePath.includes(spec.frame))
    );
    const node = matches[matches.length - 1];
    if (!node) throw new Error(`scripted: no cell in row "${spec.row}"`);
    return { kind: 'act', action: 'read', ref: node.ref, bindOutput: spec.bindOutput, intent: spec.intent };
  }
}
