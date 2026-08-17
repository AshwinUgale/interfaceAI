/**
 * Replay CLI: deterministically execute a saved artifact. NO model key required.
 *
 *   npm run replay -- --artifact artifacts/open-sub-account.json --memberId 10001 --openingDeposit 500
 *   npm run replay -- --artifact ... --overlay overlays/tenant-b.json      # cross-tenant
 */
import { readFileSync } from 'node:fs';
import { parseArgs, str } from '../shared/args.js';
import { zCapability } from '../artifact/schema.js';
import { applyOverlay, type TenantOverlay } from '../artifact/overlay.js';
import { EvidenceRecorder } from '../evidence/recorder.js';
import { buildSurface } from '../surface/build.js';
import { replay } from '../replay/engine.js';
import { DEFAULT_INPUTS } from '../discovery/capability-spec.js';

async function main() {
  const { flags, inputs: cliInputs } = parseArgs(process.argv.slice(2));
  const artifactPath = str(flags, 'artifact', 'artifacts/open-sub-account.json');
  const evidenceDir = str(flags, 'evidence', 'evidence/replay');
  const approved = flags.approved === true;

  let capability = zCapability.parse(JSON.parse(readFileSync(artifactPath, 'utf8')));
  let targetBase = str(flags, 'target', 'http://localhost:4000').replace(/\/$/, '');

  const overlayPath = typeof flags.overlay === 'string' ? flags.overlay : undefined;
  if (overlayPath) {
    const overlay = JSON.parse(readFileSync(overlayPath, 'utf8')) as TenantOverlay;
    capability = applyOverlay(capability, overlay).capability;
    if (!flags.target) targetBase = overlay.baseUrl.replace(/\/$/, '');
    console.log(`[replay] overlay=${overlay.overlayId} tenant=${overlay.tenant} base=${targetBase}`);
  }

  const inputs = {
    memberId: cliInputs.memberId ?? str(flags, 'memberId', DEFAULT_INPUTS.memberId),
    accountType: cliInputs.accountType ?? str(flags, 'accountType', DEFAULT_INPUTS.accountType),
    openingDeposit: cliInputs.openingDeposit ?? str(flags, 'openingDeposit', DEFAULT_INPUTS.openingDeposit),
  };

  const evidence = new EvidenceRecorder(evidenceDir);
  const { surface, stop } = await buildSurface('allowlist.json', evidence, { headless: true });
  try {
    const result = await replay(capability, inputs, surface, evidence, { targetBase, approved });
    evidence.finalize('run.json', { artifact: artifactPath, targetBase, inputsMasked: { ...inputs, memberId: '(pii)' }, result });
    console.log(`[replay] status=${result.status}`);
    if (result.status === 'success') {
      // Do not print raw sensitive outputs to stdout (it lands in logs). Mask by sensitivity.
      const shown = Object.fromEntries(
        Object.entries(result.outputs).map(([k, v]) => {
          const spec = capability.outputs.find((o) => o.name === k);
          return [k, spec && spec.sensitivity !== 'plain' ? '(redacted)' : v];
        })
      );
      console.log('[replay] outputs:', shown);
    }
    if (result.status === 'business_outcome') console.log('[replay] business outcome:', result.code);
    if (result.status === 'failure') console.log('[replay] failure:', result.error);
    if (result.status === 'invalid_invocation') console.log('[replay] invalid invocation:', result.field, result.message);
    process.exitCode = result.status === 'success' || result.status === 'business_outcome' ? 0 : 1;
  } finally {
    await stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
