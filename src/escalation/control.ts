/**
 * ControlToken — the explicit lock that answers "who is in control of the shared session". Every
 * automation action verifies ownership before executing; a handoff moves the token to HUMAN and
 * back. Transitions are recorded for evidence.
 */
export type ControlState = 'AUTOMATION' | 'HANDOFF_PENDING' | 'HUMAN' | 'RESUMING' | 'TERMINAL';

const ALLOWED: Record<ControlState, ControlState[]> = {
  AUTOMATION: ['HANDOFF_PENDING', 'TERMINAL'],
  HANDOFF_PENDING: ['HUMAN', 'TERMINAL'],
  HUMAN: ['RESUMING', 'TERMINAL'],
  RESUMING: ['AUTOMATION', 'TERMINAL'],
  TERMINAL: [],
};

export class ControlToken {
  private _state: ControlState = 'AUTOMATION';
  readonly transitions: { from: ControlState; to: ControlState }[] = [];

  get state(): ControlState {
    return this._state;
  }

  get owner(): 'agent' | 'human' | 'none' {
    if (this._state === 'AUTOMATION') return 'agent';
    if (this._state === 'HUMAN') return 'human';
    return 'none';
  }

  to(next: ControlState): void {
    if (!ALLOWED[this._state].includes(next)) {
      throw new Error(`illegal control transition: ${this._state} -> ${next}`);
    }
    this.transitions.push({ from: this._state, to: next });
    this._state = next;
  }

  /** Guard used by automation immediately before acting. */
  assertAgentOwns(): void {
    if (this._state !== 'AUTOMATION') throw new Error(`agent does not own control (state=${this._state})`);
  }
}
