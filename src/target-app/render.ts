/**
 * Deliberately legacy HTML: framesets, nested iframe, table-based layout, NO test IDs, and
 * inconsistent label association. This is the "hostile surface" that forces the locator cascade
 * (role+name -> structural anchor -> table cell -> text) to actually earn its keep.
 *
 * Frame context on this surface:
 *   top document        -> <frameset>
 *     frame "workspace" -> the whole servicing workflow renders here
 *       iframe "accountSummary" (on the detail page) -> the savings balance lives here
 * So reading the balance requires the frames path [workspace, accountSummary].
 */
import type { TenantConfig } from './tenants.js';
import { ACCOUNT_TYPES, type Member } from './data.js';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function money(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/** Legacy document wrapper for pages rendered inside the workspace frame. */
function page(title: string, body: string): string {
  return `<html><head><title>${esc(title)}</title></head>
<body style="font-family:Verdana,Geneva,sans-serif;font-size:13px;color:#111;margin:12px">
${body}
</body></html>`;
}

/** Top-level frameset document. `wsPath` sets the workspace frame's initial page (default search),
 * so a human returning after a session timeout re-enters the SAME frameset session rather than a
 * bare page. */
export function frameShell(t: TenantConfig, wsPath = '/search'): string {
  return `<html><head><title>${esc(t.brandName)}</title></head>
<frameset rows="70,*" border="1">
  <frame name="branding" title="Branding" src="/branding" scrolling="no" noresize>
  <frame name="workspace" title="Member Workspace" src="${esc(wsPath)}">
</frameset>
<noframes><body>This application requires frames.</body></noframes>
</html>`;
}

export function brandingPage(t: TenantConfig): string {
  return `<html><head><title>Branding</title></head>
<body style="margin:0;font-family:Verdana,sans-serif">
<table width="100%" cellpadding="8" style="background:${t.accent};color:#fff">
  <tr>
    <td style="font-size:18px;font-weight:bold">${esc(t.brandName)}</td>
    <td align="right" style="font-size:11px">Operator: SVC-DEMO &nbsp;|&nbsp; Session: active</td>
  </tr>
</table>
</body></html>`;
}

/**
 * Member search. The Member ID input has a NAME but no id/label-for association — a locator must
 * anchor it structurally (the "Member ID" cell -> adjacent input). The submit button "Search"
 * resolves cleanly by role+name.
 */
export function searchPage(t: TenantConfig, error?: string): string {
  const banner = error ? `<p style="color:#a00;font-weight:bold">${esc(error)}</p>` : '';
  return page(
    'Member Search',
    `<h2>Member Search</h2>${banner}
<form action="/member" method="get">
  <table cellpadding="6" style="border:1px solid #999;background:#f4f4f4">
    <tr>
      <td>Member ID</td>
      <td><input type="text" name="memberId" size="16"></td>
    </tr>
    <tr>
      <td colspan="2"><input type="submit" value="Search"></td>
    </tr>
  </table>
</form>`
  );
}

export function notFoundPage(t: TenantConfig, id: string): string {
  return page(
    'No Record Found',
    `<h2>Member Search</h2>
<p style="color:#a00;font-weight:bold">No record found for member ID "${esc(id)}".</p>
<p><a href="/search">Back to search</a></p>`
  );
}

export function permissionDeniedPage(t: TenantConfig, id: string): string {
  return page(
    'Permission Denied',
    `<h2>Member Record</h2>
<p style="color:#a00;font-weight:bold">You do not have permission to view member "${esc(id)}".</p>
<p><a href="/search">Back to search</a></p>`
  );
}

export function sessionExpiredPage(t: TenantConfig): string {
  return page(
    'Session Expired',
    `<h2>Session Expired</h2>
<p style="color:#a00;font-weight:bold">Your session has expired. Please sign in again to continue.</p>
<form action="/search" method="get"><input type="submit" value="Sign in"></form>`
  );
}

/**
 * Member detail. Name sits in a layout table; the savings balance is loaded in a NESTED iframe
 * (frames path [workspace, accountSummary]). The control that starts the sub-account flow uses a
 * tenant-specific label.
 */
export function memberDetailPage(t: TenantConfig, m: Member): string {
  return page(
    'Member Details',
    `<h2>Member Details</h2>
<table cellpadding="6" style="border:1px solid #999">
  <tr><td>Member ID</td><td>${esc(m.id)}</td></tr>
  <tr><td>Member Name</td><td>${esc(m.name)}</td></tr>
</table>
<h3>Accounts</h3>
<iframe name="accountSummary" title="Account Summary" src="/member/${esc(m.id)}/summary"
        width="360" height="120" frameborder="1"></iframe>
<p style="margin-top:14px">
  <a href="/account/new?member=${esc(m.id)}">${esc(t.openAccountLabel)}</a>
</p>`
  );
}

/** Content of the nested iframe: the balance table. Row "Savings" -> second cell = balance. */
export function accountSummaryFrame(m: Member): string {
  const rows = m.accounts
    .map((a) => `<tr><td>${esc(a.kind)}</td><td align="right">${money(a.balance)}</td></tr>`)
    .join('');
  return `<html><head><title>Account Summary</title></head>
<body style="font-family:Verdana,sans-serif;font-size:12px;margin:4px">
<table cellpadding="5" width="100%" style="border:1px solid #ccc">
  <tr style="background:#eee"><td>Account</td><td align="right">Balance</td></tr>
  ${rows || '<tr><td colspan="2">No accounts on file.</td></tr>'}
</table>
</body></html>`;
}

/**
 * Open sub-account form. The account-type <select> and deposit <input> have names but no
 * label-for; anchoring is via the preceding "Account Type" / "Opening Deposit" cells. The submit
 * button "Continue to Review" is a reversible step (reaches review; commits nothing).
 */
export function openAccountFormPage(t: TenantConfig, m: Member, error?: string): string {
  const banner = error ? `<p style="color:#a00;font-weight:bold">${esc(error)}</p>` : '';
  const options = ACCOUNT_TYPES.map((a) => `<option value="${a.value}">${esc(a.label)}</option>`).join('');
  return page(
    'Open Sub-Account',
    `<h2>Open Sub-Account for ${esc(m.name)}</h2>${banner}
<form action="/account/review" method="post">
  <input type="hidden" name="member" value="${esc(m.id)}">
  <table cellpadding="6" style="border:1px solid #999;background:#f4f4f4">
    <tr>
      <td>Account Type</td>
      <td><select name="accountType">${options}</select></td>
    </tr>
    <tr>
      <td>Opening Deposit</td>
      <td><input type="text" name="openingDeposit" size="12"></td>
    </tr>
    <tr>
      <td colspan="2"><input type="submit" value="Continue to Review"></td>
    </tr>
  </table>
</form>`
  );
}

/**
 * Review screen — the checkpoint the goal targets. Shows a deterministic review reference and a
 * "Create Account" button. Creating the account is IRREVERSIBLE and out of scope for automation
 * (human-required); it is present so the safety boundary is visible in the UI.
 */
export function reviewPage(
  t: TenantConfig,
  m: Member,
  typeLabel: string,
  deposit: number,
  reference: string
): string {
  return page(
    'Review New Sub-Account',
    `<h2>Review New Sub-Account</h2>
<table cellpadding="6" style="border:1px solid #999">
  <tr><td>Member</td><td>${esc(m.name)} (${esc(m.id)})</td></tr>
  <tr><td>Account Type</td><td>${esc(typeLabel)}</td></tr>
  <tr><td>Opening Deposit</td><td>${money(deposit)}</td></tr>
  <tr><td>Review Reference</td><td><b>${esc(reference)}</b></td></tr>
</table>
<p style="margin-top:12px;color:#666">Review the details above before creating the account.</p>
<form action="/account/create" method="post">
  <input type="hidden" name="member" value="${esc(m.id)}">
  <input type="hidden" name="accountType" value="${esc(typeLabel)}">
  <input type="hidden" name="openingDeposit" value="${String(deposit)}">
  <input type="submit" value="Create Account">
</form>`
  );
}

export function accountCreatedPage(t: TenantConfig, m: Member, typeLabel: string): string {
  return page(
    'Account Created',
    `<h2>Account Created</h2>
<p>A new <b>${esc(typeLabel)}</b> account has been created for ${esc(m.name)} (${esc(m.id)}).</p>
<p><a href="/member/${esc(m.id)}">Back to member</a></p>`
  );
}
