/**
 * PolicyEnforcedSurface — wraps a raw SurfaceDriver with the PolicyEngine and EvidenceRecorder so
 * policy is cross-cutting rather than a property of the driver. This is the ONLY surface handed to
 * the discovery agent and the replay engine; neither ever receives a raw Playwright Page.
 *
 * Enforcement here is fail-closed:
 *  - navigate: origin + route + action-type checked before the request.
 *  - click on a form submit: blocked if the target route is irreversible or unknown risk.
 */
import type { SurfaceDriver } from './driver.js';
import type { PolicyEngine } from './policy.js';
import type { EvidenceRecorder } from '../evidence/recorder.js';
import type {
  ActionRequest,
  ActionResult,
  ActionType,
  Observation,
  Resolution,
  SurfaceNode,
  TargetDescriptor,
  TargetInfo,
} from './types.js';

export class PolicyDenied extends Error {
  constructor(public readonly reason: string) {
    super(`POLICY_DENIED: ${reason}`);
  }
}

export class PolicyEnforcedSurface implements SurfaceDriver {
  private nodes = new Map<string, SurfaceNode>();

  constructor(
    private readonly raw: SurfaceDriver,
    private readonly policy: PolicyEngine,
    private readonly evidence?: EvidenceRecorder
  ) {}

  start(): Promise<void> {
    return this.raw.start();
  }
  stop(): Promise<void> {
    return this.raw.stop();
  }
  currentUrl(): string {
    return this.raw.currentUrl();
  }

  async navigate(url: string): Promise<ActionResult> {
    const decision = this.policy.decideNavigate(url);
    if (!decision.allowed) {
      this.evidence?.log('policy_denied', { action: 'navigate', url, reason: decision.reason });
      return { ok: false, error: `POLICY_DENIED: ${decision.reason}` };
    }
    const r = await this.raw.navigate(url);
    this.evidence?.log('navigate', { url, ok: r.ok, risk: decision.risk });
    return r;
  }

  async observe(): Promise<Observation> {
    const obs = await this.raw.observe();
    this.nodes = new Map(obs.nodes.map((n) => [n.ref, n]));
    this.evidence?.log('observe', { generation: obs.generation, url: obs.url, nodeCount: obs.nodes.length });
    return obs;
  }

  async act(req: ActionRequest): Promise<ActionResult> {
    if (req.type !== 'navigate') {
      const decision = this.policy.decideAction(req.type);
      if (!decision.allowed) {
        this.evidence?.log('policy_denied', { action: req.type, reason: decision.reason });
        return { ok: false, error: `POLICY_DENIED: ${decision.reason}` };
      }
    }
    // Fail-closed on risky form submits during discovery.
    if (req.type === 'click' && req.ref) {
      const node = this.nodes.get(req.ref);
      const formAction = node?.attrs.formAction;
      if (formAction) {
        let path = formAction;
        try {
          path = new URL(formAction, this.currentUrl()).pathname;
        } catch {
          /* keep */
        }
        const risk = this.policy.riskFor(node?.attrs.formMethod ?? 'POST', path);
        if (risk === 'irreversible' || risk === 'unknown') {
          this.evidence?.log('policy_denied', { action: 'click', route: `${node?.attrs.formMethod} ${path}`, risk, note: 'requires human approval' });
          return { ok: false, error: `POLICY_DENIED: ${risk} action requires human approval (${path})` };
        }
      }
    }
    const r = await this.raw.act(req);
    this.evidence?.log('act', { action: req.type, ref: req.ref, value: req.value, ok: r.ok, error: r.error });
    return r;
  }

  /**
   * Replay path. Policy is enforced here too — NOT just during discovery — and independently of the
   * artifact's declared risk: a click on a form submit is re-checked against the allowlist's route
   * risk, so a tampered artifact that mislabels an irreversible action as `automatic` is still
   * blocked (fail-closed on irreversible/unknown).
   */
  async resolveAndAct(
    descriptor: TargetDescriptor,
    action: ActionType,
    value?: string
  ): Promise<{ result: ActionResult; resolution: Resolution }> {
    const decision = this.policy.decideAction(action);
    if (!decision.allowed) {
      return { result: { ok: false, error: `POLICY_DENIED: ${decision.reason}` }, resolution: { status: 'not_found', matchCount: 0, fallbackUsed: false } };
    }
    if (action === 'click') {
      const info = await this.raw.resolveInfo(descriptor);
      if (info.resolution.status === 'resolved' && info.formAction) {
        let path = info.formAction;
        try {
          path = new URL(info.formAction, this.currentUrl()).pathname;
        } catch {
          /* keep */
        }
        const risk = this.policy.riskFor(info.formMethod ?? 'POST', path);
        if (risk === 'irreversible' || risk === 'unknown') {
          this.evidence?.log('policy_denied', { action: 'click', route: `${info.formMethod} ${path}`, risk, phase: 'replay' });
          return { result: { ok: false, error: `POLICY_DENIED: ${risk} action requires human approval (${path})` }, resolution: info.resolution };
        }
      }
    }
    return this.raw.resolveAndAct(descriptor, action, value);
  }
  resolveOnly(descriptor: TargetDescriptor): Promise<Resolution> {
    return this.raw.resolveOnly(descriptor);
  }
  resolveInfo(descriptor: TargetDescriptor): Promise<TargetInfo> {
    return this.raw.resolveInfo(descriptor);
  }
  textPresent(text: string): Promise<boolean> {
    return this.raw.textPresent(text);
  }
  screenshot(path: string): Promise<void> {
    return this.raw.screenshot(path);
  }
}
