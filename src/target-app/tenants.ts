/**
 * Two tenants running the SAME underlying vendor product, configured/branded differently.
 * The workflow is identical; only branding and a couple of control labels change. This is the
 * stand-in for "many institutions run the same app" — one recorded capability should replay
 * against both via a small overlay, without re-recording.
 */

export interface TenantConfig {
  id: string;
  brandName: string;
  accent: string;
  /** Label of the control that starts the sub-account flow (differs across tenants). */
  openAccountLabel: string;
}

const TENANTS: Record<string, TenantConfig> = {
  base: {
    id: 'base',
    brandName: 'Riverbend Credit Union — Member Servicing',
    accent: '#1f4e79',
    openAccountLabel: 'Open New Account',
  },
  'tenant-b': {
    id: 'tenant-b',
    brandName: 'Summit Federal — Member Servicing',
    accent: '#5a3d7a',
    // Same action, different vendor-configured wording. Primary locator "Open New Account"
    // will miss here; the tenant overlay's fallback candidate ("Add Share") resolves it.
    openAccountLabel: 'Add Share',
  },
};

export function tenantConfig(id: string | undefined): TenantConfig {
  return TENANTS[id ?? 'base'] ?? TENANTS.base!;
}
