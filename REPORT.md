# Computer-Use Automation System — Design Write-up

*~3 pages, the seven required headings. See [`README.md`](README.md) for setup and the exact
discovery → replay demo commands.*

The model **discovers** how to do a task on a live UI once; the run is compiled — from executed,
verified events, not the raw transcript — into a typed, versioned **capability artifact**; a
**deterministic replay engine** (no LLM in the decision loop) re-runs it; and a real
**human-handoff** takes over the same live session when the system can't safely proceed. It is
implemented end-to-end: `npm run evidence` reproduces `/evidence` (a genuine `claude-sonnet-4-5`
discovery run plus four replays), and `npm run test` runs 22 focused tests.

**Target:** a separately-running, deliberately legacy-style credit-union servicing tool (frameset +
nested tables, no test IDs) with a data-driven fault-injection mode and a Tenant B variant. The
automation reaches it **only through the rendered UI** — no app API, no hidden selectors, no
DB/reset access (faults are set by the test harness, then discovered through the UI). I build the
target because only a controlled surface can produce record-not-found, session timeout, validation
rejection, and a confirmation screen *deterministically* for evidence, while honouring "no real bank
system, no real PII."

## 1. Architecture

Single process, synchronous, files on disk — Section 9 doesn't reward scaling infra; the
**interfaces** carry extensibility.

```
 goal+inputs+target → Orchestrator ─(discovery only)─ LLM Agent (one configurable model)
                          │ observe()/act()            typed decision {type,ref,value?,intent,expectedEffect}
                          ▼
                 PolicyEnforcedSurface  ── PolicyEngine (per-action) + SessionGuard (context-level)
                 (wraps WebSurfaceDriver: Playwright; observe = node tree, screenshot on demand)
                          │ UI only (no app API)
                          ▼
                      Target app  ◄── Test harness (fault injection; NOT an agent tool)
                          ▲
      ArtifactCompiler (from EXECUTED+VERIFIED events) → artifact JSON ─load→ ReplayEngine (NO LLM)
                          │                                                        │ control token + resume
                          └───────────────── EvidenceRecorder ◄──── EscalationManager (AUTOMATION⇄HUMAN)
```

**Key decisions & trade-offs.** *TypeScript + Playwright + Zod* — one language across
driver/schema/replay; Zod *is* the typed-contract enforcement. *One configurable discovery model,
exact ID pinned in the artifact + evidence, no runtime fallback* — `"latest"`/model-routing isn't
reproducible and doesn't help the core. *Replay uses no model by design* (proven: replay runs with
`ANTHROPIC_API_KEY` unset and logs `llmCalls: 0`). The central seam: an **observation ref is
ephemeral** (generation-tagged, rejected if stale); when the model acts on one, the recorder derives
a **durable target descriptor** from the resolved element + frame context, and the artifact stores
the descriptor, never the ref. The model acts only by semantic ref and **never emits or records raw
coordinates**; a driver *may* internally resolve a descriptor to coordinates for a surface with no
addressable control — this removes the "semantic vs coordinates" contradiction. `ReplayEngine` and
the discovery agent receive only the `SurfaceDriver` interface, never a raw Playwright `Page`
(enforced by a structural test). One canonical flow (lookup → read balance → open sub-account →
review) exercises read + reversible-write + an irreversible, human-required `Create Account`
boundary — depth over breadth.

## 2. Artifact schema

A typed capability contract, compiled from verified events, decoupled from the transcript
(Zod-validated at emit and load):

```
Capability { schemaVersion, capabilityId, capabilityVersion, name, description,
  recordedAgainst {applicationFamily, surface, variant, versionFingerprint?}, compatibleVariants[],
  preconditions: Predicate[], inputs: Input[], outputs: Output[], steps: Step[],
  successCondition: Predicate, provenance {recordedFromRunId, model{provider,id}, approvalState} }
Input  { name, type, required, classification: 'plain'|'pii' }        // never credentials
Output { name, type, sensitivity: 'plain'|'pii'|'financial',
         extract {stepId, kind:'text'|'value'|'attribute'|'selectedOption', parse?:'currency'|…} }
Step = Navigate|Click|Type|Select|Read|Wait|Assert                    // discriminated union
  each: { id, intent, expectedEffect?, risk{class:'read'|'reversible_write'|'irreversible',
          approval:'automatic'|'human_required'}, precondition?, checkpoint?, retryPolicy, onError? }
TargetDescriptor { context{frames[]}, candidates: LocatorCandidate[],          // ordered cascade
  invariants{cardinality:'exactlyOne', mustBeVisible, mustBeEnabled, expectedRole?, expectedName?} }
LocatorCandidate = roleName | labelledField | anchorCell | tableCell | text    // never raw px
Predicate = {all|any|not} | urlMatches | textMatches | elementPresent | valueEquals   // compound
retryPolicy { maxAttempts, retryOn, safeToRetry }                     // idempotency guard
ErrorRule { match{text?,url?}, classify:'business'|'recoverable'|'hardFailure', outcomeCode?, action }
```

Why: `schemaVersion` / `capabilityVersion` / `versionFingerprint` answer three different "versioned"
questions once tenants exist. The discriminated `Step` lets Zod enforce shape (a click step needs a
target; a read step binds an output). **Frame context** is mandatory for the frameset target —
replay otherwise can't say which frame a control is in, and the balance lives in a nested iframe.
`cardinality:exactlyOne` makes resolution deterministic (0→next candidate, >1→ambiguity failure,
never a silent `matches[0]`). Per-step `risk` (business effect, not HTML verb) is the only honest
model for a flow mixing safe reads and an irreversible button. `retryPolicy.safeToRetry`,
`Output.extract`+`sensitivity`, and the label-anchored read locator (so the artifact carries no
member value) are the details a schema usually misses — verified PII-free by test. A `superRefine`
pass enforces cross-field integrity: every `{param}` references a declared input, every read binds a
declared output, and every output's `extract.stepId` points at a real read step.

## 3. Determinism & error handling

**Deterministic in control policy, not outputs.** The artifact fixes the action sequence, targeting
precedence, waits, checkpoints, and transitions; the LLM makes no execution decisions. Live state
may legitimately change an output (a balance) or yield a business outcome (member now closed) under
the *same verified workflow*. Waits are condition-based `Predicate`s, never fixed sleeps; capability
preconditions are asserted at entry and each action step verifies its `checkpoint` after acting
(per-step preconditions are supported by the engine). Locator-fallback use is recorded per step
(`resolution.fallbackUsed`) as the drift signal, and replay **never rewrites the artifact** from a
successful fallback.

**Retry/idempotency (the load-bearing safety call):** only safe (idempotent) actions are retried,
and only when the failure's declared `retryOn` condition (`TRANSIENT_LOAD` / `CHECKPOINT_TIMEOUT`)
matches — the engine retries the *resolve/wait*, never re-dispatches a `safeToRetry:false` action
(POST submits and irreversible actions are compiled as such). A side-effecting action whose result
is unconfirmed **escalates with `sideEffectUncertain=true`** when an operator is attached (else fails
fast with step context), so a human verifies real state before anything else acts. This is what
prevents a duplicate transaction.

| Class | Example | Response | Result |
|---|---|---|---|
| **Business outcome** | "no such member"; "not eligible" | return `outcomeCode` | `business_outcome` (not an error) |
| **Recoverable** | slow load (auto retry); expired session (needs human) | wait/retry / **escalate** | transparent, else handoff |
| **Hard failure** | `TARGET_AMBIGUOUS`, `TARGET_NOT_FOUND`, `POLICY_DENIED`, checkpoint timeout | stop + rich evidence | `failure {code, step, expected, observed}` |

`RunResult` is a discriminated union `success | business_outcome | failure | invalid_invocation`
(type-invalid inputs are rejected at the boundary before any UI — tested). Run **state**
(`RUNNING → WAITING_FOR_HUMAN → RESUMING → …`) is separate from the terminal result, so a handoff is
non-terminal. Generic execution errors live in the engine; app-specific outcomes
(`MEMBER_NOT_FOUND`, `SESSION_EXPIRED`) live in reviewable `ErrorRule`s, so the engine stays generic.

## 4. Heterogeneity & multi-tenant  *(design; only the Tenant B overlay is built)*

The `SurfaceDriver` is the seam between perceive/act and the recorded flow; the schema is
surface-agnostic (semantic descriptors, frame context, predicates — no CSS). A desktop driver
(UIAutomation/AX) would produce the same sparse node shape + screenshot — *semantic where available,
visual geometry where necessary*. Precise claim: the **schema** ports unchanged; individual
**locator candidates may be surface-specific** (a desktop `automationId` vs a web role/name/frame).
Two axes: *application family/version* (the vendor product) is distinct from *tenant configuration*;
tenant is **execution context**, not artifact data, so one artifact serves a family and the
invocation selects a tenant. Values are parameterized deterministically by exact match
(`10001`→`{param:memberId}`); the same mechanism canonicalizes id-bearing routes to templates where
a flow navigates by id. Effective artifact = `base → app-version → tenant overlay`; an overlay may
add locator candidates / aliases / base URL but **cannot weaken safety** (risk, policy, sensitivity,
irreversible semantics are not overlay-settable — enforced by the overlay type and a test). A
version-fingerprint preflight that fails closed on an unknown build is designed, not built.
**Built & demonstrated:** Tenant B relabels one control (`"Open New Account"`→`"Add Share"`); the
same artifact replays against it via an approved overlay whose extra candidate resolves as a logged
fallback rather than as drift.

## 5. Escalation & handoff

**Detect "stuck" mechanically:** a discovery stop (max-steps / timeout / **dead-end** = observation
fingerprint repeated N times, or a step failure), a replay recoverable rule with `action:escalate`,
or a `human_required` risk gate. **Same session:** agent and human share one persistent
`BrowserContext` (cookies/storage preserved by reuse). Control is a state machine with an explicit
lock — `AUTOMATION → HANDOFF_PENDING → HUMAN → RESUMING → (AUTOMATION|TERMINAL)` — with illegal
transitions rejected (tested), and automation asserts ownership before acting. On escalation the
manager quiesces automation, writes an **intervention record** (`intervention-<step>.json`:
capability/goal, current step, reason, `outcomeCode`, a screenshot ref, current URL, and the
`actionState`/`sideEffectUncertain` uncertainty context), hands off, records the human's action as
an evidence event, and resumes on a **real signal** (`EscalationManager.resume()`). A genuine
human-operable path exists: **`npm run handoff`** launches a *headed* browser, pauses on escalation,
and hands the same live session to a real operator who **re-authenticates via the UI** (clicking
**Sign in** → `/reauth`, a real allowlisted route that restores the session — not a private harness
call) and presses ENTER to hand back. The automated `replay-handoff` evidence uses a *simulated*
operator that performs the same `/reauth` UI step and calls the same `resume()`. Replay resume is
**deterministic**: the engine re-attempts the current step (re-resolve + re-check), no model decides
where to resume. **Human actions never silently become production automation** — in
replay they never mutate the artifact; discovery-captured human steps would land in a `draft`
capability pending review. Console UI and granular in-page action capture are documented cuts; the
control-transfer semantics are real and exercised by the `replay-handoff` evidence (session expiry →
intervention → resume → completion).

## 6. Safety

Two layers: **`PolicyEngine`** pre-validates every automation action — in **discovery *and*
replay**. A replay click on a form submit is re-checked against the allowlist's route risk
**independent of the artifact's declared risk**, so a tampered artifact that mislabels an
irreversible action (`/account/create`) as `automatic` is still blocked (tested). **`SessionGuard`**
enforces containment at the browser-context level (allowlisted origin **and** route on every
navigation **and every mutating request** — POST/PUT/PATCH/DELETE, by method, closing the JS
`fetch`/XHR bypass; blocks downloads/popups) and **stays active during human takeover**, because
human clicks don't pass through `act()` — closing the "single choke point" gap honestly. Risk is
per-step, deterministic, **fail-closed** (unknown ⇒ `human_required`); a missing frame context is a
fail-closed `TARGET_CONTEXT_NOT_FOUND`, not a silent fallback. **PII ≠
secrets:** invocation params are `plain|pii`, carried as `{param}` and supplied per-invocation, never
stored in the artifact (verified PII-free); credentials would come from a separate secret provider
(the demo app has no login, so none are handled) and are never inputs. The `EvidenceRecorder` masks
any **registered sensitive value** wherever it appears in logs/artifacts, including **sensitive
outputs** masked per the artifact's sensitivity metadata (`memberName → J****`, `balance → 4***`);
observations are persisted only as summaries, not raw node dumps. In **discovery**, read output
values are registered for redaction the moment they're read (before any later model `finish` text
could echo them), the model's free-form finish prose is not persisted, and no success screenshot is
taken (it would show member data) — an evidence-scanning test asserts no raw PII in any committed
evidence file. Discovery evidence is a per-step decision log of the model's declared intent + expected
effect ("what & why"), never a raw transcript or chain-of-thought. **Prompt-injection stance:** UI
content is untrusted data, never policy — the model can't expand its allowlist from text the app
renders (`model proposes / policy decides`). **Limits (honest):** committed screenshots use synthetic
data and are not pixel-redacted (screenshot-level redaction is a documented cut); the allowlist is
only as good as its config; `SessionGuard` guards the obvious paths, not a full sandbox;
`approvalState` is co-located in the JSON here but would be external, digest-bound metadata in
production.

## 7. Cuts

Operator console + granular human-action capture mocked (transfer semantics real); desktop driver
designed not built; multi-tenant plumbing not built (one Tenant B overlay demo instead); no
queue/scheduler/workers; secret provider + login designed, not built (no auth in the demo); output/
screenshot redaction is a one-line/cut extension of the working input redaction; **no automatic
artifact self-healing** (fallbacks are used + logged; new versions come only from reviewed
re-recording); version-fingerprint preflight and open-ended LLM replay recovery out (replay
escalates instead); no full browser sandbox. **What I'd build next:** an agent-facing capability
catalog (typed tool endpoints); a draft→approved confidence gate from multi-run stability; a
bounded, policy-checked single-step LLM recovery on replay failure; an external approval registry
bound to artifact digests.
