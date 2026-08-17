/**
 * Surface abstraction: the seam between "how we perceive/act on a surface" and "the recorded
 * flow". The web driver implements this; a desktop driver could implement the same interface.
 *
 * Two representations are kept deliberately distinct (see docs/DESIGN.md, the ref<->locator seam):
 *   - ObservationRef: EPHEMERAL, valid only within the observation generation that produced it.
 *   - TargetDescriptor: DURABLE, stored in the artifact and re-resolved deterministically at replay.
 */

export type Role =
  | 'button'
  | 'link'
  | 'textbox'
  | 'combobox'
  | 'heading'
  | 'cell'
  | 'text'
  | 'other';

/** e.g. "obs_3:e12" — generation-tagged so a stale ref used against a newer observation is rejected. */
export type ObservationRef = `obs_${number}:e${number}`;

export interface SurfaceNode {
  ref: ObservationRef;
  role: Role;
  name: string;
  value?: string;
  framePath: string[]; // frame names from top of document (e.g. ["workspace","accountSummary"])
  tag: string;
  attrs: { name?: string; type?: string; href?: string; formAction?: string; formMethod?: string };
  /** Nearest preceding label/cell text — the anchor for label-less legacy inputs. */
  anchorText?: string;
  /** Text of the table row this node sits in, if any (anchors table-cell reads). */
  rowText?: string;
}

export interface Observation {
  generation: number;
  url: string;
  nodes: SurfaceNode[];
  /** Compact text outline handed to the LLM during discovery. */
  outline: string;
  screenshotPath?: string;
}

// ---- Durable locators (stored in the artifact) --------------------------------------------

export type LocatorCandidate =
  | { strategy: 'roleName'; role: Role; name: string }
  | { strategy: 'labelledField'; label: string }
  | { strategy: 'anchorCell'; anchorText: string; control: 'input' | 'select' | 'textarea' }
  | { strategy: 'tableCell'; rowContainsText: string; column: number }
  | { strategy: 'text'; text: string };

export interface FrameDescriptor {
  name: string;
}

export interface TargetDescriptor {
  context: { frames: FrameDescriptor[] };
  candidates: LocatorCandidate[];
  invariants: {
    cardinality: 'exactlyOne';
    mustBeVisible: boolean;
    mustBeEnabled: boolean;
    expectedRole?: Role;
    expectedName?: string;
  };
  basis?: string[];
}

// ---- Actions -------------------------------------------------------------------------------

export type ActionType = 'navigate' | 'click' | 'type' | 'select' | 'read';

export interface ActionRequest {
  type: ActionType;
  ref?: ObservationRef; // for click/type/select/read
  url?: string; // for navigate
  value?: string; // for type/select
}

/**
 * What the driver resolved an action to, captured at action time. The artifact compiler turns
 * this into a durable TargetDescriptor — so the recording reflects the element actually acted on,
 * not the ephemeral ref.
 */
export interface ResolvedTarget {
  role: Role;
  name: string;
  framePath: string[];
  anchorText?: string;
  rowText?: string;
  candidates: LocatorCandidate[];
}

export interface ActionResult {
  ok: boolean;
  /** For read actions. */
  readValue?: string;
  resolved?: ResolvedTarget;
  error?: string;
}

/** Outcome of resolving a durable descriptor during replay. */
export interface Resolution {
  status: 'resolved' | 'not_found' | 'ambiguous';
  matchCount: number;
  candidateIndex?: number; // which candidate resolved it
  fallbackUsed: boolean; // true if a non-primary candidate resolved it
}

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
  risk?: 'read' | 'reversible_write' | 'irreversible' | 'unknown';
}
