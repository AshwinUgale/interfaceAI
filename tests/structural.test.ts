import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Structural guardrail: the decision-making layers must depend only on the SurfaceDriver seam,
 * never on Playwright or a concrete Page. This keeps policy/evidence non-bypassable and the
 * surface swappable (web -> desktop).
 */
describe('architecture boundaries', () => {
  for (const file of ['src/replay/engine.ts', 'src/discovery/orchestrator.ts', 'src/discovery/compiler.ts']) {
    it(`${file} does not import playwright or the web driver`, () => {
      const src = readFileSync(file, 'utf8');
      expect(src.includes("from 'playwright'")).toBe(false);
      expect(src.includes('web-driver')).toBe(false);
    });
  }
});
