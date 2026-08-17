/**
 * REAL human handoff demo. Launches a HEADED browser, replays the capability for the member whose
 * session expires mid-flow, and — on escalation — pauses and hands the SAME live session to you.
 * You operate the browser (click "Sign in" to re-authenticate and return to the member), then press
 * ENTER to hand control back; automation resumes on the same session and completes.
 *
 *   npm run handoff
 *
 * The automated evidence path (npm run evidence) uses a simulated operator; this is the genuine
 * human-operable version of the same control-transfer mechanism.
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawnTargetApp, waitForHttp, harnessPost } from '../shared/proc.js';
import { EvidenceRecorder } from '../evidence/recorder.js';
import { buildSurface } from '../surface/build.js';
import { replay } from '../replay/engine.js';
import { EscalationManager } from '../escalation/manager.js';
import { zCapability } from '../artifact/schema.js';

const BASE = 'http://localhost:4000';

async function main() {
  const cap = zCapability.parse(JSON.parse(readFileSync('artifacts/open-sub-account.json', 'utf8')));
  const app = spawnTargetApp('base', 4000);
  const evidence = new EvidenceRecorder('evidence/replay-handoff-manual');
  const { surface, stop } = await buildSurface('allowlist.json', evidence, { headless: false });
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  let startedUrl = '';
  const escalation = new EscalationManager(evidence, {
    onEscalate: (req) => {
      startedUrl = req.currentUrl;
      console.log(`\n=== HUMAN HANDOFF — automation paused at ${req.stepId} (${req.reason}) ===`);
      console.log('In the browser window: click "Sign in" to re-authenticate and return to the member.');
      console.log('Then press ENTER here to hand control back to automation.\n');
    },
  });
  rl.on('line', () => {
    escalation.recordHumanAction('manual', `operator resumed (from ${startedUrl} -> ${surface.currentUrl()})`);
    escalation.resume();
  });

  try {
    await waitForHttp(`${BASE}/search`);
    await harnessPost(BASE, '/_harness/reset', {});
    console.log('[handoff] replaying for member 99999 (session expires mid-flow)…');
    const result = await replay(cap, { memberId: '99999', accountType: 'savings', openingDeposit: '500' }, surface, evidence, {
      targetBase: BASE,
      escalation,
    });
    evidence.finalize('run.json', { mode: 'manual', result, control: escalation.token.transitions });
    console.log(`\n[handoff] result: ${result.status}`);
  } finally {
    rl.close();
    await stop();
    app.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
