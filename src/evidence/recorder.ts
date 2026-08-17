/**
 * EvidenceRecorder — structured "what and why" event log plus richer signals (screenshots) on
 * demand. Applies redaction: any value registered as sensitive is masked in every persisted
 * string, so PII/secret values never land in events, run.json, or artifacts.
 *
 * Timestamps are deliberately avoided; a monotonic `seq` keeps evidence diff-stable/reproducible.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SurfaceDriver } from '../surface/driver.js';

export function mask(value: string): string {
  if (value.length <= 1) return '*';
  return `${value[0]}${'*'.repeat(Math.min(value.length - 1, 4))}`;
}

export class EvidenceRecorder {
  private seq = 0;
  private readonly sensitive: string[] = [];
  private readonly eventsPath: string;

  constructor(private readonly dir: string) {
    mkdirSync(join(dir, 'screenshots'), { recursive: true });
    this.eventsPath = join(dir, 'events.jsonl');
    writeFileSync(this.eventsPath, '');
  }

  registerSensitive(value: string | undefined): void {
    if (value && value.length >= 2 && !this.sensitive.includes(value)) this.sensitive.push(value);
  }

  private redact<T>(obj: T): T {
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') {
        let s = v;
        for (const secret of this.sensitive) s = s.split(secret).join(mask(secret));
        return s;
      }
      if (typeof v === 'number') {
        // Mask a numeric value whose exact string form was registered sensitive (e.g. a balance).
        const s = String(v);
        return this.sensitive.includes(s) ? mask(s) : v;
      }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') {
        return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, walk(val)]));
      }
      return v;
    };
    return walk(obj) as T;
  }

  log(type: string, data: Record<string, unknown> = {}): void {
    const event = this.redact({ seq: this.seq++, type, ...data });
    appendFileSync(this.eventsPath, JSON.stringify(event) + '\n');
  }

  async shot(driver: SurfaceDriver, name: string): Promise<string> {
    const rel = join('screenshots', `${String(this.seq).padStart(2, '0')}-${name}.png`);
    await driver.screenshot(join(this.dir, rel));
    return rel.replace(/\\/g, '/');
  }

  finalize(fileName: string, run: unknown): void {
    writeFileSync(join(this.dir, fileName), JSON.stringify(this.redact(run), null, 2));
  }

  writeJson(fileName: string, obj: unknown): void {
    writeFileSync(join(this.dir, fileName), JSON.stringify(this.redact(obj), null, 2));
  }
}
