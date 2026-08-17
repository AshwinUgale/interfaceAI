import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The committed discovery/replay evidence must not contain raw member PII. This is the evidence
 * equivalent of the artifact PII test — the leak the previous review found was here, not in the
 * artifact (a model 'finish' explanation echoing "Jane A. Rivera" / "$4,250.00").
 */
const PII = ['10001', '99999', 'Jane', 'Rivera', 'Dana', 'Fox', '4,250', '4250', '$500'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.json') || e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

describe('committed evidence carries no raw PII', () => {
  const files = existsSync('evidence') ? walk('evidence') : [];

  it('has evidence files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const f of files) {
    it(`${f.replace(/\\/g, '/')} is PII-free`, () => {
      const text = readFileSync(f, 'utf8');
      for (const needle of PII) expect(text.includes(needle), `${needle} found in ${f}`).toBe(false);
    });
  }
});
