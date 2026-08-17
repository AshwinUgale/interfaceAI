/**
 * Discovery CLI: run an LLM-driven (or scripted) observe->decide->act loop against the live target,
 * then compile the verified run into a capability artifact.
 *
 *   npm run discover -- --target http://localhost:4000 --brain llm --memberId 10001
 *
 * Uses the LLM brain when --brain llm (or ANTHROPIC_API_KEY is set); otherwise the scripted brain,
 * which drives the same observe/act/policy/evidence path with no model key.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseArgs, str } from '../shared/args.js';
import { EvidenceRecorder } from '../evidence/recorder.js';
import { buildSurface } from '../surface/build.js';
import { runDiscovery } from '../discovery/orchestrator.js';
import { compile } from '../discovery/compiler.js';
import { ScriptedBrain } from '../discovery/brain.js';
import { LlmBrain } from '../discovery/llm-brain.js';
import type { Brain } from '../discovery/brain.js';
import { CAP, INPUT_SPECS, OUTPUT_SPECS, OUTPUT_EXTRACT, DEFAULT_INPUTS } from '../discovery/capability-spec.js';

async function main() {
  const { flags, inputs: cliInputs } = parseArgs(process.argv.slice(2));
  const target = str(flags, 'target', 'http://localhost:4000').replace(/\/$/, '');
  const outDir = str(flags, 'out', 'evidence/discovery');
  const runId = str(flags, 'run-id', 'disc-001');
  const artifactsDir = str(flags, 'artifacts', 'artifacts');
  const goal = str(
    flags,
    'goal',
    `Look up member ${cliInputs.memberId ?? DEFAULT_INPUTS.memberId}, read their savings balance, open a ${cliInputs.accountType ?? DEFAULT_INPUTS.accountType} sub-account with a ${cliInputs.openingDeposit ?? DEFAULT_INPUTS.openingDeposit} dollar deposit, and reach the review screen.`
  );
  const inputs = {
    memberId: cliInputs.memberId ?? str(flags, 'memberId', DEFAULT_INPUTS.memberId),
    accountType: cliInputs.accountType ?? str(flags, 'accountType', DEFAULT_INPUTS.accountType),
    openingDeposit: cliInputs.openingDeposit ?? str(flags, 'openingDeposit', DEFAULT_INPUTS.openingDeposit),
  };

  const key = process.env.ANTHROPIC_API_KEY;
  const useLlm = flags.brain === 'llm' || (flags.brain !== 'scripted' && !!key);
  let brain: Brain;
  let model = { provider: 'scripted', id: 'scripted-canonical' };
  if (useLlm) {
    if (!key) throw new Error('--brain llm requires ANTHROPIC_API_KEY');
    const modelId = process.env.DISCOVERY_MODEL ?? 'claude-sonnet-4-5';
    brain = new LlmBrain(modelId, key);
    model = { provider: 'anthropic', id: modelId };
  } else {
    brain = new ScriptedBrain();
  }

  const evidence = new EvidenceRecorder(outDir);
  const { surface, policy, stop } = await buildSurface('allowlist.json', evidence, { headless: true });
  try {
    const outcome = await runDiscovery(surface, policy, brain, evidence, { goal, inputs, entryUrl: `${target}/` });
    console.log(`[discover] brain=${brain.name} status=${outcome.status} steps=${outcome.events.length}`);
    if (outcome.status !== 'success') {
      evidence.finalize('run.json', { runId, status: outcome.status, reason: outcome.reason, brain: brain.name });
      process.exitCode = 1;
      return;
    }
    const capability = compile(outcome.events, {
      capabilityId: CAP.capabilityId,
      capabilityVersion: CAP.capabilityVersion,
      name: CAP.name,
      description: CAP.description,
      runId,
      model,
      applicationFamily: CAP.applicationFamily,
      variant: 'base',
      versionFingerprint: CAP.versionFingerprint,
      compatibleVariants: [...CAP.compatibleVariants],
      inputs,
      inputSpecs: INPUT_SPECS,
      outputSpecs: OUTPUT_SPECS,
      outputExtract: OUTPUT_EXTRACT,
    });

    mkdirSync(artifactsDir, { recursive: true });
    const artifactPath = join(artifactsDir, `${CAP.capabilityId}.json`);
    const json = JSON.stringify(capability, null, 2);
    writeFileSync(artifactPath, json);
    const sha = createHash('sha256').update(json).digest('hex');
    evidence.writeJson(`${CAP.capabilityId}.json`, capability);
    evidence.finalize('run.json', { runId, status: 'success', brain: brain.name, model, artifactPath, artifactSha256: sha, stepCount: capability.steps.length });
    console.log(`[discover] artifact -> ${artifactPath}  sha256=${sha.slice(0, 12)}…`);
  } finally {
    await stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
