/**
 * EscalationManager — detects "stuck", raises an intervention request with enough context to act
 * on, hands control of the SAME live session to a human, and resumes on a real signal.
 *
 * The operator console is out of scope; resume is a real in-process signal (resume()), which a
 * tiny HTTP endpoint or CLI can call. For automated evidence/tests an `autoResolver` simulates the
 * human by fixing state and calling resume() — the transfer semantics (token, intervention record,
 * pause/resume, human-action-as-evidence) are exercised either way.
 */
import type { EvidenceRecorder } from '../evidence/recorder.js';
import { ControlToken } from './control.js';

export interface InterventionRequest {
  capabilityId: string;
  goal: string;
  stepId: string;
  reason: string;
  outcomeCode?: string;
  /** Uncertain-side-effect context so the human knows whether it is safe to act. */
  actionState: 'not_attempted' | 'completed' | 'sent_but_unconfirmed';
  sideEffectUncertain: boolean;
  screenshotRef?: string;
  currentUrl: string;
}

export interface EscalationOptions {
  /** Simulated human for automated runs/tests. Should fix state and then call resume(). */
  autoResolver?: (req: InterventionRequest, resume: () => void) => Promise<void>;
  /** Called when an intervention is raised (e.g. to prompt a real operator). Fires before waiting. */
  onEscalate?: (req: InterventionRequest) => void;
}

export class EscalationManager {
  readonly token = new ControlToken();
  private pending?: () => void;

  constructor(
    private readonly evidence: EvidenceRecorder,
    private readonly opts: EscalationOptions = {}
  ) {}

  /** Raise an intervention and block until a resume signal. Returns 'resumed'. */
  async escalate(req: InterventionRequest): Promise<'resumed'> {
    this.token.to('HANDOFF_PENDING');
    this.evidence.log('intervention_raised', { ...req, control: this.token.state });
    this.evidence.writeJson(`intervention-${req.stepId}.json`, req);
    this.token.to('HUMAN');
    this.opts.onEscalate?.(req);

    const waitForResume = new Promise<void>((resolve) => {
      this.pending = resolve;
    });
    if (this.opts.autoResolver) {
      await this.opts.autoResolver(req, () => this.resume());
    }
    await waitForResume;

    this.token.to('RESUMING');
    this.evidence.log('intervention_resumed', { stepId: req.stepId, control: this.token.state });
    this.token.to('AUTOMATION');
    return 'resumed';
  }

  /** Real resume signal (called by an HTTP endpoint/CLI, or by the autoResolver). */
  resume(): void {
    this.pending?.();
    this.pending = undefined;
  }

  /** Record a human action taken during a handoff (evidence only — never mutates the artifact). */
  recordHumanAction(stepId: string, description: string): void {
    this.evidence.log('human_action', { stepId, description, control: this.token.state });
  }
}
