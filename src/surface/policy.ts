/**
 * PolicyEngine — fail-closed allowlist enforcement for automation actions. Loaded from
 * allowlist.json. Anything not explicitly permitted is denied. Risk is resolved per-route;
 * unknown routes are treated as `unknown` which callers escalate to human_required.
 */
import { readFileSync } from 'node:fs';
import type { PolicyDecision } from './types.js';

export interface Allowlist {
  version: string;
  origins: string[];
  routes: { method: string; pattern: string }[];
  actionTypes: Record<string, 'allow' | 'deny'>;
  risk: Record<string, 'read' | 'reversible_write' | 'irreversible'>;
}

function patternToRegex(pattern: string): RegExp {
  // "/member/:id" -> /^\/member\/[^/]+$/
  const escaped = pattern
    .split('/')
    .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${escaped}$`);
}

export class PolicyEngine {
  private readonly origins: Set<string>;
  private readonly routes: { method: string; re: RegExp; pattern: string }[];
  constructor(private readonly allow: Allowlist) {
    this.origins = new Set(allow.origins);
    this.routes = allow.routes.map((r) => ({ method: r.method.toUpperCase(), re: patternToRegex(r.pattern), pattern: r.pattern }));
  }

  static fromFile(path: string): PolicyEngine {
    return new PolicyEngine(JSON.parse(readFileSync(path, 'utf8')) as Allowlist);
  }

  originAllowed(url: string): boolean {
    try {
      return this.origins.has(new URL(url).origin);
    } catch {
      return false;
    }
  }

  private matchedRoute(method: string, path: string) {
    return this.routes.find((r) => r.method === method.toUpperCase() && r.re.test(path));
  }

  routeAllowed(method: string, path: string): boolean {
    return !!this.matchedRoute(method, path);
  }

  riskFor(method: string, path: string): PolicyDecision['risk'] {
    const route = this.matchedRoute(method, path);
    if (!route) return 'unknown';
    return this.allow.risk[`${method.toUpperCase()} ${route.pattern}`] ?? 'unknown';
  }

  actionAllowed(type: string): boolean {
    return this.allow.actionTypes[type] === 'allow';
  }

  /** Decide a navigation (origin + route + navigate action type). */
  decideNavigate(url: string): PolicyDecision {
    if (!this.actionAllowed('navigate')) return { allowed: false, reason: 'navigate action type denied' };
    if (!this.originAllowed(url)) return { allowed: false, reason: `origin not allowlisted: ${url}` };
    let path: string;
    let method = 'GET';
    try {
      path = new URL(url).pathname;
    } catch {
      return { allowed: false, reason: `unparseable url: ${url}` };
    }
    if (!this.routeAllowed(method, path)) return { allowed: false, reason: `route not allowlisted: GET ${path}` };
    return { allowed: true, risk: this.riskFor(method, path) };
  }

  /** Decide a UI action by type (click/type/select/read). */
  decideAction(type: string): PolicyDecision {
    if (!this.actionAllowed(type)) return { allowed: false, reason: `action type denied: ${type}` };
    return { allowed: true };
  }
}
