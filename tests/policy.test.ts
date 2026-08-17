import { describe, it, expect } from 'vitest';
import { PolicyEngine } from '../src/surface/policy.js';

const policy = PolicyEngine.fromFile('allowlist.json');

describe('PolicyEngine (fail-closed allowlist)', () => {
  it('allows listed origins, denies others', () => {
    expect(policy.originAllowed('http://localhost:4000/member/1')).toBe(true);
    expect(policy.originAllowed('http://evil.example.com/x')).toBe(false);
  });

  it('matches parameterized routes', () => {
    expect(policy.routeAllowed('GET', '/member/10001')).toBe(true);
    expect(policy.routeAllowed('GET', '/member/10001/summary')).toBe(true);
    expect(policy.routeAllowed('POST', '/account/review')).toBe(true);
    expect(policy.routeAllowed('GET', '/secret/admin')).toBe(false);
  });

  it('classifies route risk, unknown for unlisted', () => {
    expect(policy.riskFor('POST', '/account/create')).toBe('irreversible');
    expect(policy.riskFor('POST', '/account/review')).toBe('reversible_write');
    expect(policy.riskFor('GET', '/member/10001')).toBe('read');
    expect(policy.riskFor('GET', '/nope')).toBe('unknown');
  });

  it('denies disallowed action types and off-allowlist navigation', () => {
    expect(policy.actionAllowed('download')).toBe(false);
    expect(policy.decideNavigate('http://evil.example.com/').allowed).toBe(false);
    expect(policy.decideNavigate('http://localhost:4000/account/new').allowed).toBe(true);
    // /account/create is POST-only, so a GET navigation to it is (correctly) denied.
    expect(policy.decideNavigate('http://localhost:4000/account/create').allowed).toBe(false);
  });
});
