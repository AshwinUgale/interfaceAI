import type { Resolution } from '../surface/types.js';

export interface StepTrace {
  stepId: string;
  action: string;
  ok: boolean;
  resolution?: Resolution;
  attempts?: number;
  note?: string;
}

/** Terminal result contract — a discriminated union the caller pattern-matches on. */
export type ReplayResult =
  | { status: 'success'; outputs: Record<string, string | number>; steps: StepTrace[] }
  | { status: 'business_outcome'; code: string; details?: string; steps: StepTrace[] }
  | {
      status: 'failure';
      error: { code: string; stepId?: string; expected?: string; observed?: string; evidenceRefs?: string[] };
      steps: StepTrace[];
    }
  | { status: 'invalid_invocation'; field: string; message: string };

/** Run state is kept separate from the terminal result so a handoff is non-terminal. */
export type RunState = 'RUNNING' | 'WAITING_FOR_HUMAN' | 'RESUMING' | 'SUCCESS' | 'FAILURE';
