import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { zCapability } from '../src/artifact/schema.js';
import { EvidenceRecorder, mask } from '../src/evidence/recorder.js';
import { tmpEvidenceDir } from './fake-surface.js';
import { join } from 'node:path';

describe('artifact schema', () => {
  it('parses the generated artifact and enforces discriminated step shapes', () => {
    const raw = JSON.parse(readFileSync('artifacts/open-sub-account.json', 'utf8'));
    const cap = zCapability.parse(raw);
    expect(cap.capabilityId).toBe('open-sub-account');
    // a click step must carry a target
    const click = cap.steps.find((s) => s.action === 'click')!;
    expect('target' in click).toBe(true);
    // rejects a malformed artifact (missing steps)
    expect(() => zCapability.parse({ ...raw, steps: [] })).toThrow();
  });

  it('does not contain member PII (values are parameterized/output-bound, not embedded)', () => {
    const blob = readFileSync('artifacts/open-sub-account.json', 'utf8');
    for (const pii of ['Jane', 'Rivera', 'Dana', '4,250', '4250']) expect(blob.includes(pii)).toBe(false);
  });
});

describe('evidence redaction', () => {
  it('masks registered sensitive values in the event log', () => {
    const dir = tmpEvidenceDir();
    const ev = new EvidenceRecorder(dir);
    ev.registerSensitive('10001');
    ev.log('act', { note: 'looked up member 10001 today' });
    const line = readFileSync(join(dir, 'events.jsonl'), 'utf8');
    expect(line.includes('10001')).toBe(false);
    expect(line.includes(mask('10001'))).toBe(true);
  });
});
