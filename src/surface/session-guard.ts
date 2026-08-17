/**
 * SessionGuard — browser-context-level containment. Unlike the PolicyEngine (which pre-validates
 * automation actions), the SessionGuard enforces at the transport level and therefore STAYS ACTIVE
 * even while a human has control of the shared session — human clicks don't pass through act().
 *
 * It blocks: navigation requests to non-allowlisted origins, downloads, and unexpected popups.
 * It does not attempt to be a full browser sandbox (documented limit).
 */
import type { BrowserContext, Page } from 'playwright';
import type { PolicyEngine } from './policy.js';

export interface GuardViolation {
  kind: 'navigation' | 'download' | 'popup';
  detail: string;
  seq: number;
}

export class SessionGuard {
  readonly violations: GuardViolation[] = [];
  constructor(private readonly policy: PolicyEngine) {}

  async attach(context: BrowserContext): Promise<void> {
    // Enforce origin AND route allowlist (by actual method) on every document navigation AND every
    // mutating request (POST/PUT/PATCH/DELETE) — the latter closes the gap where a JS-driven button
    // mutates via fetch/XHR without a form navigation. Holds during human takeover too.
    const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
    await context.route('**/*', async (route) => {
      const req = route.request();
      if (req.isNavigationRequest() || MUTATING.has(req.method())) {
        const url = req.url();
        let path = '/';
        try {
          path = new URL(url).pathname;
        } catch {
          /* keep default */
        }
        const originOk = this.policy.originAllowed(url);
        const routeOk = originOk && this.policy.routeAllowed(req.method(), path);
        if (!originOk || !routeOk) {
          this.violations.push({ kind: 'navigation', detail: `${req.method()} ${url}`, seq: this.violations.length });
          return route.abort('blockedbyclient');
        }
      }
      return route.continue();
    });

    // Cancel downloads.
    context.on('page', (page: Page) => this.wirePage(page));
    for (const page of context.pages()) this.wirePage(page);
  }

  private wirePage(page: Page): void {
    page.on('download', (d) => {
      this.violations.push({ kind: 'download', detail: d.url(), seq: this.violations.length });
      void d.cancel().catch(() => {});
    });
    page.on('popup', (p) => {
      this.violations.push({ kind: 'popup', detail: p.url(), seq: this.violations.length });
      void p.close().catch(() => {});
    });
  }
}
