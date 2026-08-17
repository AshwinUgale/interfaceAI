/** Deterministic evaluation of compound predicates against a live surface (no LLM). */
import type { SurfaceDriver } from '../surface/driver.js';
import type { TargetDescriptor } from '../surface/types.js';
import type { Predicate } from './schema.js';

function urlMatches(url: string, pattern: string): boolean {
  try {
    return new RegExp(pattern).test(url);
  } catch {
    return url.includes(pattern);
  }
}

export async function evalPredicate(driver: SurfaceDriver, p: Predicate): Promise<boolean> {
  if ('all' in p) {
    for (const q of p.all) if (!(await evalPredicate(driver, q))) return false;
    return true;
  }
  if ('any' in p) {
    for (const q of p.any) if (await evalPredicate(driver, q)) return true;
    return false;
  }
  if ('not' in p) return !(await evalPredicate(driver, p.not));
  switch (p.kind) {
    case 'urlMatches':
      return urlMatches(driver.currentUrl(), p.pattern);
    case 'textMatches':
      return driver.textPresent(p.text);
    case 'elementPresent':
      return (await driver.resolveOnly(p.target as TargetDescriptor)).status === 'resolved';
    case 'valueEquals': {
      const r = await driver.resolveAndAct(p.target as TargetDescriptor, 'read');
      return (r.result.readValue ?? '').includes(p.value);
    }
  }
}

/** Poll a predicate until true or timeout. Condition-based wait — never a fixed sleep. */
export async function waitForPredicate(
  driver: SurfaceDriver,
  p: Predicate,
  timeoutMs: number,
  pollMs = 100
): Promise<boolean> {
  const deadline = performanceNow() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await evalPredicate(driver, p)) return true;
    if (performanceNow() >= deadline) return false;
    await sleep(pollMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function performanceNow(): number {
  // process.hrtime avoids Date; fine for runtime waits.
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1e6;
}
