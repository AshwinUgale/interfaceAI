/**
 * The legacy servicing tool as an HTTP server.
 *
 * Black-box contract: the automation interacts ONLY with the normal UI routes below. The
 * /_harness/* routes (reset, fault toggles, introspection) are test infrastructure and must never
 * be exposed to the agent/replay engine as a tool — they exist so a human/test harness can put the
 * app into a known state before a run.
 */
import express, { type Express } from 'express';
import { tenantConfig } from './tenants.js';
import * as data from './data.js';
import * as R from './render.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createApp(tenantId: string | undefined): Express {
  const t = tenantConfig(tenantId);
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  // ---- Normal UI surface (what the automation drives) --------------------------------------

  app.get('/', (req, res) => {
    // Optional workspace path so a post-timeout re-entry lands on the member inside the frameset.
    const raw = String(req.query.ws ?? '/search');
    const ws = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/search';
    res.type('html').send(R.frameShell(t, ws));
  });
  app.get('/branding', (_req, res) => res.type('html').send(R.brandingPage(t)));
  app.get('/search', (_req, res) => res.type('html').send(R.searchPage(t)));

  // Search submit: GET /member?memberId=ID -> canonical /member/:id (or an exceptional state).
  app.get('/member', async (req, res) => {
    const id = String(req.query.memberId ?? '').trim();
    if (!id) return res.type('html').send(R.searchPage(t, 'Enter a member ID.'));
    await delay(data.getFaults().slowLoadMs); // transient-slowness injection point
    const m = data.getMember(id);
    if (!m) return res.type('html').send(R.notFoundPage(t, id));
    if (m.restricted) return res.type('html').send(R.permissionDeniedPage(t, id));
    return res.redirect(`/member/${id}`);
  });

  // Nested iframe content (the balance). Defined before /member/:id for clarity.
  app.get('/member/:id/summary', (req, res) => {
    const m = data.getMember(req.params.id);
    if (!m) return res.status(404).type('html').send('<html><body>No accounts.</body></html>');
    return res.type('html').send(R.accountSummaryFrame(m));
  });

  app.get('/member/:id', async (req, res) => {
    const id = req.params.id.trim();
    await delay(data.getFaults().slowLoadMs);
    const m = data.getMember(id);
    if (!m) return res.type('html').send(R.notFoundPage(t, id));
    if (m.restricted) return res.type('html').send(R.permissionDeniedPage(t, id));
    return res.type('html').send(R.memberDetailPage(t, m));
  });

  // Open sub-account form. Member 99999 expires the session here (mid-flow) -> handoff path.
  app.get('/account/new', (req, res) => {
    const id = String(req.query.member ?? '').trim();
    const m = data.getMember(id);
    if (!m) return res.type('html').send(R.notFoundPage(t, id));
    if (m.restricted) return res.type('html').send(R.permissionDeniedPage(t, id));
    if (m.poisonSession) return res.type('html').send(R.sessionExpiredPage(t));
    return res.type('html').send(R.openAccountFormPage(t, m));
  });

  // Reach the review screen (reversible; commits nothing).
  app.post('/account/review', (req, res) => {
    const id = String(req.body.member ?? '').trim();
    const typeValue = String(req.body.accountType ?? '');
    const rawDeposit = String(req.body.openingDeposit ?? '').trim();
    const m = data.getMember(id);
    if (!m) return res.type('html').send(R.notFoundPage(t, id));

    const type = data.accountType(typeValue);
    const deposit = Number(rawDeposit);
    // Validation error (bad input): not a positive number.
    if (!rawDeposit || Number.isNaN(deposit) || deposit <= 0) {
      return res.type('html').send(R.openAccountFormPage(t, m, 'Opening deposit must be a positive dollar amount.'));
    }
    // Business rejection (eligibility): below the type's minimum. A legitimate outcome, not a crash.
    if (type && deposit < type.minDeposit) {
      return res
        .type('html')
        .send(
          R.openAccountFormPage(
            t,
            m,
            `Member is not eligible: ${type.label} requires a minimum opening deposit of $${type.minDeposit}.`
          )
        );
    }
    const label = type?.label ?? typeValue;
    const reference = data.reviewReference(id, typeValue);
    return res.type('html').send(R.reviewPage(t, m, label, deposit, reference));
  });

  // Irreversible commit. Present for the safety boundary; automation is policy-blocked from here.
  app.post('/account/create', (req, res) => {
    const id = String(req.body.member ?? '').trim();
    const label = String(req.body.accountType ?? 'Account');
    const deposit = Number(req.body.openingDeposit ?? 0);
    const m = data.getMember(id);
    if (!m) return res.type('html').send(R.notFoundPage(t, id));
    data.addAccount(id, { kind: label, balance: Number.isFinite(deposit) ? deposit : 0 });
    return res.type('html').send(R.accountCreatedPage(t, m, label));
  });

  // ---- Harness-only controls (NOT an agent tool) -------------------------------------------

  app.post('/_harness/reset', (_req, res) => {
    data.reset();
    res.json({ ok: true });
  });
  app.post('/_harness/faults', (req, res) => {
    if (typeof req.body?.slowLoadMs === 'number') data.setFaults({ slowLoadMs: req.body.slowLoadMs });
    res.json({ ok: true, faults: data.getFaults() });
  });
  app.post('/_harness/clear-poison', (req, res) => {
    if (req.body?.memberId) data.clearPoison(String(req.body.memberId));
    res.json({ ok: true });
  });
  app.get('/_harness/state', (_req, res) => {
    res.json({ tenant: t.id, faults: data.getFaults() });
  });

  return app;
}
