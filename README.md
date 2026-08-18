# Computer-Use Automation System

LLM **discovery** of a UI task → a typed, versioned **capability artifact** → **deterministic
replay** with no model in the loop → **human handoff** on the same live session, with safety
guardrails throughout. Built against a deliberately legacy-style (frameset, nested tables, no test
IDs) credit-union servicing tool as a stand-in for real bank back-office software.

> Design write-up: [`REPORT.md`](REPORT.md) — the seven required sections (architecture, artifact
> schema, determinism & error handling, heterogeneity & multi-tenant, escalation & handoff, safety,
> cuts).

## Prerequisites

- Node.js 20+
- `npm install`
- `npx playwright install chromium`
- Copy `.env.example` → `.env`. A model key (`ANTHROPIC_API_KEY`) is needed **only** for a real
  LLM discovery run; deterministic replay needs no key. **Never commit `.env`** (gitignored).

## One-command end-to-end demo

Spawns both tenant apps, runs the whole thread (discovery → artifact → replays), and writes
`/evidence`:

```bash
npm run evidence
```

Discovery uses the **genuine LLM** when `ANTHROPIC_API_KEY` is set (the committed `evidence/discovery`
is a real `claude-sonnet-4-5` run — see `evidence/index.json` → `discoveryModel`), otherwise a
scripted brain that drives the identical observe/act/policy path with no key. Produces:
`evidence/discovery` (live-UI loop + compiled artifact), `evidence/replay-success`,
`evidence/replay-business-outcome` (MEMBER_NOT_FOUND), `evidence/replay-tenant-b` (cross-tenant via
overlay), `evidence/replay-handoff` (session-expiry → same-session human handoff → resume), and
`evidence/index.json`.

## Demo path (manual)

Start the target app(s):

```bash
npm run target:base       # http://localhost:4000  (base tenant)
npm run target:tenant-b   # http://localhost:4001  (Tenant B: same product, rebranded)
```

**Discovery** — genuine LLM run (needs `ANTHROPIC_API_KEY`), or scripted (no key):

```bash
npm run discover -- --brain llm --target http://localhost:4000 --memberId 10001 --accountType savings --openingDeposit 500
npm run discover -- --brain scripted --target http://localhost:4000        # no key
```

Ad-hoc `discover`/`replay` runs write to a gitignored scratch dir (`evidence/_adhoc/`) so they never
clobber the committed submission evidence — inspect the artifact at
`evidence/_adhoc/open-sub-account.json`. To regenerate the **committed** artifact + full evidence
set, use `npm run evidence` (below).

**Replay** — deterministic, **no model key required** (against the committed artifact):

```bash
npm run replay -- --artifact artifacts/open-sub-account.json --memberId 10001 --openingDeposit 500
npm run replay -- --artifact artifacts/open-sub-account.json --memberId 00000     # -> MEMBER_NOT_FOUND
npm run replay -- --artifact artifacts/open-sub-account.json --overlay overlays/tenant-b.json --memberId 10001
```

Proof the LLM is absent from replay: `ANTHROPIC_API_KEY= npm run replay -- …` still works, and the
replay log records `llmCalls: 0`.

**Human handoff** (real, headed browser — a person operates the same live session):

```bash
npm run handoff
```

Replays member `99999` (whose session expires mid-flow), pauses on escalation, and hands you the
live browser. Click **Sign in** to re-authenticate (`/reauth`, a real UI action), then press ENTER
to hand control back — automation resumes on the same session and completes. The `npm run evidence`
handoff run uses a simulated operator performing the same steps.

## Tests

```bash
npm run test        # vitest: schema, policy, redaction, predicate, overlay, control, retry-safety, boundaries
npm run typecheck
```

## The target app

The automation drives it **only through the rendered UI** — no private API, no hidden selectors, no
DB/reset access. Fault injection is data-driven (special member IDs) plus harness-only `/_harness/*`
endpoints (**not** agent tools). Canonical flow: **look up a member → read savings balance → open a
sub-account → reach the review screen.** The final `Create Account` button is irreversible and
out of scope for automation (human-required) — the visible safety boundary.

| Input | State | Class |
|---|---|---|
| member `10001` / `10002` / `10003` | happy path | success |
| member `00000` | record not found | business outcome |
| member `00001` | permission denied | business/access outcome |
| member `99999` | session expires when opening a sub-account | recoverable → handoff |
| deposit `abc` / `0` | validation error | validation |
| Money Market, deposit `< $1000` | not eligible | business outcome |

## Layout

```
src/
  target-app/   legacy servicing tool (frameset, iframe balance, no test IDs) + Tenant B
  surface/      SurfaceDriver seam: web driver, PolicyEngine, SessionGuard, PolicyEnforcedSurface
  artifact/     Zod capability schema, compound-predicate evaluator, tenant overlay
  discovery/    observe→decide→act loop, LLM + scripted brains, artifact compiler
  replay/       deterministic engine (no LLM) + result contract
  escalation/   control-token state machine + escalation manager
  evidence/     structured event log + redaction
  cli/          discover, replay, generate-evidence
allowlist.json  fail-closed origins/routes/action-types/risk
overlays/       tenant-b.json
```

## Safety notes

- `allowlist.json` is fail-closed. `PolicyEngine` pre-validates automation actions; `SessionGuard`
  enforces origin+route containment at the browser-context level (holds during human takeover too).
- Secrets never enter the repo (`.env` gitignored). Member data is synthetic — no real PII.
- Capability artifacts are parameterized and carry no member PII (verified by tests).
