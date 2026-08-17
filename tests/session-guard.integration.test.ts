import { describe, it, expect } from 'vitest';
import { buildSurface } from '../src/surface/build.js';

/**
 * Direct browser/network test of the load-bearing SessionGuard: it aborts requests to an
 * off-allowlist origin and to a non-allowlisted route, at the transport level.
 */
describe('SessionGuard integration (real browser)', () => {
  it('aborts off-allowlist origin and non-allowlisted route navigations', async () => {
    const built = await buildSurface('allowlist.json', undefined, { headless: true });
    try {
      // Allowlisted origin, but a route that is NOT allowlisted -> aborted.
      const badRoute = await built.raw.navigate('http://localhost:4000/secret');
      expect(badRoute.ok).toBe(false);
      // Off-allowlist origin -> aborted.
      const badOrigin = await built.raw.navigate('http://evil.example.com/');
      expect(badOrigin.ok).toBe(false);
      expect(built.guard.violations.length).toBeGreaterThanOrEqual(2);
    } finally {
      await built.stop();
    }
  }, 30000);
});
