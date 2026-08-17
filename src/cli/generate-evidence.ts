/**
 * Self-contained end-to-end evidence generator. Spawns both tenant apps, runs the full thread, and
 * writes /evidence: discovery -> artifact -> replay(success | business-outcome | tenant-b | handoff).
 * Uses the scripted brain so it runs with no model key; the genuine LLM discovery path is
 * `npm run discover -- --brain llm` and produces evidence/discovery the same way.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { spawnTargetApp, waitForHttp, harnessPost } from '../shared/proc.js';
import { EvidenceRecorder } from '../evidence/recorder.js';
import { buildSurface } from '../surface/build.js';
import { runDiscovery } from '../discovery/orchestrator.js';
import { compile } from '../discovery/compiler.js';
import { ScriptedBrain, type Brain } from '../discovery/brain.js';
import { LlmBrain } from '../discovery/llm-brain.js';
import { replay } from '../replay/engine.js';
import { EscalationManager } from '../escalation/manager.js';
import { zCapability, type Capability } from '../artifact/schema.js';
import { applyOverlay, type TenantOverlay } from '../artifact/overlay.js';
import { CAP, INPUT_SPECS, OUTPUT_SPECS, OUTPUT_EXTRACT, DEFAULT_INPUTS, ERROR_POLICY } from '../discovery/capability-spec.js';

const BASE = 'http://localhost:4000';
const TENANT_B = 'http://localhost:4001';
const ALLOW = 'allowlist.json';

async function discovery(): Promise<{ capability: Capability; sha: string }> {
  const evidence = new EvidenceRecorder('evidence/discovery');
  const { surface, policy, stop } = await buildSurface(ALLOW, evidence, { headless: true });
  try {
    const inputs = { ...DEFAULT_INPUTS };
    // Genuine LLM discovery when a key is present; scripted otherwise. Provenance records which.
    const key = process.env.ANTHROPIC_API_KEY;
    let brain: Brain;
    let model: { provider: string; id: string };
    if (key) {
      const id = process.env.DISCOVERY_MODEL ?? 'claude-sonnet-4-5';
      brain = new LlmBrain(id, key);
      model = { provider: 'anthropic', id };
    } else {
      brain = new ScriptedBrain();
      model = { provider: 'scripted', id: 'scripted-canonical' };
    }
    console.log(`[evidence] discovery brain=${brain.name}`);
    const outcome = await runDiscovery(surface, policy, brain, evidence, {
      goal: "Look up member 10001. Read the member's name and bind it to output 'memberName'. Read the current savings balance and bind it to output 'savingsBalance'. Then open a new savings sub-account with a 500 dollar opening deposit and reach the review screen. Do not click Create Account.",
      inputs,
      entryUrl: `${BASE}/`,
      timeoutMs: 180000,
      successText: 'Review New Sub-Account',
      sensitiveOutputs: OUTPUT_SPECS.filter((o) => o.sensitivity !== 'plain').map((o) => o.name),
      piiInputs: INPUT_SPECS.filter((i) => i.classification === 'pii').map((i) => i.name),
    });
    if (outcome.status !== 'success') throw new Error(`discovery failed: ${outcome.status} ${outcome.reason ?? ''}`);
    const capability = compile(outcome.events, {
      capabilityId: CAP.capabilityId,
      capabilityVersion: CAP.capabilityVersion,
      name: CAP.name,
      description: CAP.description,
      runId: 'disc-001',
      model,
      applicationFamily: CAP.applicationFamily,
      variant: 'base',
      versionFingerprint: CAP.versionFingerprint,
      compatibleVariants: [...CAP.compatibleVariants],
      inputs,
      inputSpecs: INPUT_SPECS,
      outputSpecs: OUTPUT_SPECS,
      outputExtract: OUTPUT_EXTRACT,
      errorPolicy: ERROR_POLICY,
    });
    mkdirSync('artifacts', { recursive: true });
    const json = JSON.stringify(capability, null, 2);
    writeFileSync(join('artifacts', `${CAP.capabilityId}.json`), json);
    const sha = createHash('sha256').update(json).digest('hex');
    evidence.writeJson(`${CAP.capabilityId}.json`, capability);
    evidence.finalize('run.json', { runId: 'disc-001', status: 'success', brain: brain.name, model, artifactSha256: sha, steps: capability.steps.length });
    console.log(`[evidence] discovery ok (${model.provider}/${model.id}) — artifact sha256=${sha.slice(0, 12)}…`);
    return { capability, sha };
  } finally {
    await stop();
  }
}

async function replayScenario(
  label: string,
  dir: string,
  capability: Capability,
  inputs: Record<string, string>,
  targetBase: string,
  extra?: { escalationMemberId?: string }
): Promise<void> {
  const evidence = new EvidenceRecorder(dir);
  const { surface, guard, stop } = await buildSurface(ALLOW, evidence, { headless: true });
  try {
    let escalation: EscalationManager | undefined;
    if (extra?.escalationMemberId) {
      escalation = new EscalationManager(evidence, {
        autoResolver: async (req, resume) => {
          escalation!.recordHumanAction(req.stepId, 'Re-authenticated the expired session via /reauth and returned to the member record.');
          // Real re-auth through the UI (workspace loads /reauth, which restores the session and
          // redirects to the member), staying in the SAME frameset session — no private harness call.
          await surface.navigate(`${targetBase}/?ws=/reauth?member=${extra.escalationMemberId}`);
          resume();
        },
      });
      // Transport guard now follows control ownership: human-owned irreversible traffic is permitted.
      guard.setOwnership(() => escalation!.token.owner);
    }
    const result = await replay(capability, inputs, surface, evidence, { targetBase, escalation });
    evidence.finalize('run.json', { label, targetBase, result, control: escalation?.token.transitions });
    console.log(`[evidence] ${label}: ${result.status}${result.status === 'business_outcome' ? ` (${result.code})` : ''}`);
  } finally {
    await stop();
  }
}

async function main() {
  mkdirSync('evidence', { recursive: true });
  const base = spawnTargetApp('base', 4000);
  const tb = spawnTargetApp('tenant-b', 4001);
  try {
    await waitForHttp(`${BASE}/search`);
    await waitForHttp(`${TENANT_B}/search`);
    await harnessPost(BASE, '/_harness/reset', {});
    await harnessPost(TENANT_B, '/_harness/reset', {});

    // --skip-discovery reuses the existing artifact (e.g. one produced by a real LLM run) and only
    // regenerates the replay evidence, so a genuine evidence/discovery is not overwritten.
    let capability: Capability;
    let sha: string;
    if (process.argv.includes('--skip-discovery')) {
      const json = readFileSync(`artifacts/${CAP.capabilityId}.json`, 'utf8');
      capability = zCapability.parse(JSON.parse(json));
      sha = createHash('sha256').update(json).digest('hex');
      console.log(`[evidence] reusing artifact (${capability.provenance.model.provider}/${capability.provenance.model.id}) sha256=${sha.slice(0, 12)}…`);
    } else {
      ({ capability, sha } = await discovery());
    }

    // 1) Happy path.
    await replayScenario('replay-success', 'evidence/replay-success', capability, { ...DEFAULT_INPUTS }, BASE);
    // 2) Business outcome: member not found.
    await replayScenario('replay-business-outcome', 'evidence/replay-business-outcome', capability, { ...DEFAULT_INPUTS, memberId: '00000' }, BASE);
    // 3) Cross-tenant reuse via overlay.
    const overlay = JSON.parse(readFileSync('overlays/tenant-b.json', 'utf8')) as TenantOverlay;
    const tenantB = applyOverlay(capability, overlay).capability;
    await replayScenario('replay-tenant-b', 'evidence/replay-tenant-b', tenantB, { ...DEFAULT_INPUTS }, TENANT_B);
    // 4) Recoverable -> same-session human handoff -> resume.
    await replayScenario('replay-handoff', 'evidence/replay-handoff', capability, { ...DEFAULT_INPUTS, memberId: '99999' }, BASE, {
      escalationMemberId: '99999',
    });

    const m = capability.provenance.model;
    const discoveryProof =
      m.provider === 'anthropic'
        ? `genuine LLM-driven live-UI loop (${m.id}) + compiled artifact`
        : `scripted live-UI loop (no model key) + compiled artifact — run with ANTHROPIC_API_KEY for a genuine LLM run`;
    writeFileSync(
      'evidence/index.json',
      JSON.stringify(
        {
          artifact: `artifacts/${CAP.capabilityId}.json`,
          artifactSha256: sha,
          discoveryModel: m,
          runs: [
            { dir: 'evidence/discovery', proves: discoveryProof },
            { dir: 'evidence/replay-success', proves: 'no-LLM deterministic replay + typed outputs' },
            { dir: 'evidence/replay-business-outcome', proves: 'business-outcome taxonomy (MEMBER_NOT_FOUND, not a crash)' },
            { dir: 'evidence/replay-tenant-b', proves: 'multi-tenant reuse via approved overlay' },
            { dir: 'evidence/replay-handoff', proves: 'same-session escalation + resume' },
          ],
        },
        null,
        2
      )
    );
    console.log('[evidence] wrote evidence/index.json');
  } finally {
    base.kill();
    tb.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
