import type { SurfaceDriver } from '../src/surface/driver.js';
import type { ActionRequest, ActionResult, ActionType, Observation, Resolution, TargetDescriptor } from '../src/surface/types.js';

/** Programmable in-memory SurfaceDriver for browserless engine/predicate tests. */
export class FakeSurface implements SurfaceDriver {
  url = 'http://localhost:4000/';
  texts = new Set<string>();
  navigations: string[] = [];
  /** Consumed in order by resolveAndAct; falls back to a resolved+ok result when empty. */
  script: Array<{ resolution: Resolution; result: ActionResult }> = [];
  resolveOnlyResult: Resolution = { status: 'resolved', matchCount: 1, fallbackUsed: false };

  start() { return Promise.resolve(); }
  stop() { return Promise.resolve(); }
  currentUrl() { return this.url; }
  navigate(u: string) { this.navigations.push(u); this.url = u; return Promise.resolve({ ok: true } as ActionResult); }
  observe() { return Promise.resolve({ generation: 1, url: this.url, nodes: [], outline: '' } as Observation); }
  act(_r: ActionRequest) { return Promise.resolve({ ok: true } as ActionResult); }
  resolveAndAct(_d: TargetDescriptor, _a: ActionType, _v?: string) {
    const next = this.script.shift();
    if (!next) return Promise.resolve({ result: { ok: true } as ActionResult, resolution: this.resolveOnlyResult });
    return Promise.resolve(next);
  }
  resolveOnly(_d: TargetDescriptor) { return Promise.resolve(this.resolveOnlyResult); }
  textPresent(t: string) { return Promise.resolve([...this.texts].some((x) => x.includes(t))); }
  screenshot() { return Promise.resolve(); }
}

let counter = 0;
export function tmpEvidenceDir(): string {
  return `evidence/_test/${process.pid}-${counter++}`;
}
