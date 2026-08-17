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
    // Includes the actual pii INPUT value (10001) — the leak the previous test missed.
    for (const pii of ['10001', 'Jane', 'Rivera', 'Dana', '4,250', '4250']) expect(blob.includes(pii)).toBe(false);
  });

  it('superRefine rejects an output bound to the wrong read step', () => {
    const raw = JSON.parse(readFileSync('artifacts/open-sub-account.json', 'utf8'));
    const reads = raw.steps.filter((s: { action: string }) => s.action === 'read');
    const bad = structuredClone(raw);
    // Point the first output's extract at a read step that binds a DIFFERENT output.
    const other = reads.find((s: { bindOutput: string }) => s.bindOutput !== bad.outputs[0].name);
    bad.outputs[0].extract.stepId = other.id;
    expect(() => zCapability.parse(bad)).toThrow();
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
