/**
 * Synthetic member data for the demo target app.
 *
 * IMPORTANT: all records here are fabricated. No real PII.
 *
 * "Fault injection" is configured through DATA and a harness-only endpoint, never through a
 * tool the automation can call. Special member IDs deterministically produce the exceptional
 * states the design cares about, so evidence runs are reproducible:
 *
 *   00000  -> absent            => "record not found"      (business outcome)
 *   00001  -> restricted        => "permission denied"     (business/access outcome)
 *   99999  -> session poisoned  => session expiry mid-flow (recoverable-with-intervention)
 *   others -> normal happy path
 */

export interface Account {
  kind: string; // e.g. "Savings", "Money Market"
  balance: number; // dollars
}

export interface Member {
  id: string;
  name: string;
  restricted?: boolean; // triggers PERMISSION_DENIED
  poisonSession?: boolean; // triggers SESSION_EXPIRED when opening a sub-account
  accounts: Account[];
}

export interface FaultConfig {
  /** Artificial latency (ms) added to member lookup, to exercise transient-slowness handling. */
  slowLoadMs: number;
}

function seedMembers(): Map<string, Member> {
  const members: Member[] = [
    { id: '10001', name: 'Jane A. Rivera', accounts: [{ kind: 'Savings', balance: 4250.0 }] },
    { id: '10002', name: 'Robert C. Chen', accounts: [{ kind: 'Savings', balance: 15980.75 }] },
    { id: '10003', name: 'Maria L. Gomez', accounts: [{ kind: 'Savings', balance: 320.5 }] },
    // Special cases (deterministic exceptional states):
    { id: '00001', name: 'Restricted Record', restricted: true, accounts: [] },
    { id: '99999', name: 'Dana P. Fox', poisonSession: true, accounts: [{ kind: 'Savings', balance: 88.2 }] },
  ];
  return new Map(members.map((m) => [m.id, m]));
}

// Module-level mutable state, reset by the harness for reproducible runs.
let members = seedMembers();
let faults: FaultConfig = { slowLoadMs: 0 };

export function getMember(id: string): Member | undefined {
  return members.get(id.trim());
}

export function addAccount(id: string, account: Account): void {
  members.get(id.trim())?.accounts.push(account);
}

/** Harness-only: clear the session-poison flag (represents a human re-authenticating). */
export function clearPoison(id: string): void {
  const m = members.get(id.trim());
  if (m) m.poisonSession = false;
}

export function getFaults(): FaultConfig {
  return faults;
}

export function setFaults(patch: Partial<FaultConfig>): void {
  faults = { ...faults, ...patch };
}

/** Harness-only: restore known state so demos/evidence are reproducible. */
export function reset(): void {
  members = seedMembers();
  faults = { slowLoadMs: 0 };
}

/**
 * Account types the sub-account form offers. "Money Market" carries a minimum opening deposit so
 * the app can produce a server-side business rejection ("not eligible") distinct from a plain
 * type/validation error.
 */
export const ACCOUNT_TYPES = [
  { value: 'savings', label: 'Savings', minDeposit: 0 },
  { value: 'money-market', label: 'Money Market', minDeposit: 1000 },
  { value: 'certificate', label: 'Certificate', minDeposit: 500 },
] as const;

export type AccountTypeValue = (typeof ACCOUNT_TYPES)[number]['value'];

export function accountType(value: string) {
  return ACCOUNT_TYPES.find((t) => t.value === value);
}

/** Deterministic review reference derived from inputs (stable across replays). */
export function reviewReference(memberId: string, typeValue: string): string {
  return `REV-${memberId}-${typeValue.toUpperCase().slice(0, 3)}`;
}
