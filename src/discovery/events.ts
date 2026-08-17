/**
 * ExecutionEvent — a typed record of an action that was actually executed AND verified. The
 * artifact compiler builds the capability from these events (not from the raw model transcript),
 * so the saved capability reflects what happened, not what a model said.
 */
import type { ActionType, ResolvedTarget } from '../surface/types.js';

export type RouteRisk = 'read' | 'reversible_write' | 'irreversible' | 'unknown';

export interface ExecutionEvent {
  intent: string;
  expectedEffect?: string;
  action: ActionType;
  url?: string; // navigate target, or post-action url
  rawValue?: string; // typed/selected value (pre-parameterization)
  bindOutput?: string; // for read actions
  readValue?: string; // read result
  resolved?: ResolvedTarget;
  routeRisk: RouteRisk;
}
