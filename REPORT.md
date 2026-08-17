# Design write-up

> Written phase by phase as decisions got made and tested, not reconstructed
> from memory afterward — real defects found along the way are documented
> with their fixes rather than smoothed over. §7 is the honest cut list.

## 1. Architecture

The through-line: the model discovers, a compiler distils, an interpreter
replays. Discovery emits a raw trace; compilation turns it into a typed
capability; replay is a model-free interpreter over that capability. The
model's conversation is evidence (`evidence/`); the capability is a build
output with no pointer back into it.

Four decisions carry the design:

- **Perception is a normalized UI graph, not raw markup.** A `Surface`
  adapter (`src/surface/types.ts`) emits nodes with role, accessible name,
  state, geometry, and containment — never HTML. Windows UI Automation and
  macOS AX expose the same shape, so a desktop surface needs a new adapter,
  not a schema change; the `Action` vocabulary deliberately excludes
  anything browser-only. No second adapter exists yet — the interface was
  shaped for one from the start, which is real but partial evidence.
- **Controls are addressed by scored evidence, not selectors** (§2).
- **Outcomes are a declarative three-way taxonomy, not try/catch** (§3).
- **Control transfer is a lease** (§5).

Discovery runs observe → format → decide → policy-gate → act → record, one
JSON decision per turn from a fixed 8-action vocabulary rather than
tool-calling, since tool-calling conventions vary across providers and are
flaky on small models — "produce one JSON object matching this schema" is
natively supported everywhere. Policy is checked on the resolved action
before it reaches the surface, in both discovery and replay.

The model choice was measured: a hybrid-thinking model (`qwen3:4b`) burned
150–200 invisible tokens on trivial replies and could exceed a five-minute
ceiling with no suppression flag working; a plain instruct model
(`qwen2.5:7b-instruct`) brought a realistic decision to ~90s with a correct
result — on CPU-bound hardware, a model that reasons unconditionally is a
worse default than one that answers directly.

Screenshot+coordinate grounding was rejected: it needs a stronger
multimodal model than this $0/CPU setup supports, produces targets that
break on layout reflow, and has no stable encoding for a replay-time
descriptor.

## 2. Artifact schema

Defined in `src/artifact/schema.ts` with Zod, not a hand-written interface
— a capability read back off disk, days or tenants later, is untrusted
input at a real boundary. `z.infer` keeps the compiled types and the
runtime validator as one declaration so they can't drift (an earlier
hand-duplicated type did drift, caught by a `readonly string[]` vs
`string[]` mismatch).

A capability is a contract an agent calls: typed inputs, typed outputs, and
a declared set of outcomes — not just a step list. It's also a build
output: provenance records the discovery run id, never enough to
reconstruct the model conversation.

The locator design is the central bet. A selector is one hypothesis that
hits or misses. A `SemanticDescriptor` bundles independent evidence — role,
accessible name, adjacent label, containing section, relative anchor,
ordinal — scored per candidate. A tenant renaming "Search" to "Find Member"
degrades the name signal while structural signals still carry the match;
when candidates score alike, the matcher reports `AMBIGUOUS_TARGET` and
stops rather than guessing.

`src/artifact/compile.ts` turns a raw discovery trace into a capability,
refusing rather than guessing wherever evidence doesn't clearly support a
decision:

- **Parameterization** — a value becomes a named input only if it appears
  verbatim in the goal text; values that don't (an inferred password) stay
  literals.
- **Checkpoint inference** — step N's checkpoint is "step N+1's target is
  present," structural rather than value-based, so replay with different
  data still checks correctly.
- **Output binding** — every claimed output is grounded against the live
  snapshot that produced it; an ungroundable claim fails the whole compile
  rather than silently dropping.

One defect this caught: the final step's checkpoint originally reused the
extracted output's own descriptor, so a compiled artifact checkpointed
against today's literal balance. Fixed by `structuralOnly`, which strips
any name/label equal to the extracted value, keeping only
role/containment/ordinal evidence.

`src/artifact/render.ts` renders every field of a capability to Markdown,
including raw match evidence, for the reviewer who flips `approval` from
`draft` to `approved`.

## 3. Determinism & error handling

`src/replay/replay.ts` is a plain interpreter: every decision is read from
the compiled capability or computed from a live snapshot through the same
scored matcher discovery uses — never a model call. `evidence/determinism-*/`
checks this rather than asserting it: the same capability and input,
replayed three times, diffed with only run metadata excluded. Identical.

The brief names conflating a business answer with a crash as the most
common mistake here, so the taxonomy is modeled in the schema, not
`try`/`catch`. Every capability can declare detectors mapped to
`business_outcome` (a real answer), `recoverable` (a bounded remedy —
capped retry, a `dismiss` resolved through the same matcher, or
`reauthenticate`, which escalates immediately since no automated remedy
exists), or `hard_failure`. `ReplayResult` has four arms — success,
business outcome, failure, escalated — all exercised by real tests.

Failure detail names the step, expected vs. observed state, and per-signal
match scores; a replay's evidence directory holds a screenshot and node
snapshot from the moment it gave up.

Concretely: replaying the real artifact against a member who triggers a
genuine permission-denial screen — with no declared outcome for it, since
the compiler can't know which unvisited screens are meaningful — reports
`CHECKPOINT_FAILED` honestly rather than guessing
(`evidence/replay-1786838072086/`). Declaring that as a `hard_failure` is a
concrete, identified reviewer edit, not a silent gap.

## 4. Heterogeneity & multi-tenant

The seam between "how we perceive/act on a surface" and "the recorded
flow" is the `Surface` interface plus the normalized node vocabulary (§1);
a new surface means a new adapter, not a schema change. `TargetBinding`
separates `app` (vendor product) from `tenant` (one institution's
instance) so a capability recorded against one tenant is reusable against
another running the same software.

An early tenant registry sketched a structured
`stepOverrides`/`outcomeOverrides` schema; it sat unused for most of the
project and was removed once a real second tenant existed to test against.
A flat text-substitution overlay (`applyOverlay`, `src/artifact/overlay.ts`)
said everything the real rename needed.

Tested against a real second tenant, not a mock: `target-app/tenants.ts`
adds a `NORTHSTAR` branding preset renaming "Search" to "Find Member." The
un-overlaid recording fails outright against it — one step *before* the
renamed button, since checkpoints are structural (§2). The overlaid
capability replays clean end-to-end against an independently launched
northstar server and reaches the identical balance the original does
(`evidence/replay-1786846579516/`). `applyOverlay` rewrites only text and
the target binding — it can't add or remove steps, and a wrong rewrite
fails loudly at replay's own checkpoints.

`src/catalog/catalog.ts` is the agent-facing surface: it loads and
validates artifacts, projects a capability's typed I/O into a tool
definition, and dispatches invocations straight to the real replay
interpreter with no duplicate policy logic to drift out of sync. One
defect: overlay never changed a capability's `id`, so base and overlaid
artifacts collided under one id with no uniqueness check — fixed by
minting a tenant-qualified id and having the catalog throw on any
duplicate.

## 5. Escalation & handoff

`src/replay/lease.ts` holds a `SessionLease` (owner `automation | human`, a
token incrementing only on real ownership change); `src/replay/intervention.ts`
is the persisted record a handoff raises; `resumeCapability` in
`replay.ts` makes `ReplayEscalated.resumable` actually true.

Two escalation reasons need different resume semantics. A `reauthenticate`
remedy escalates because a condition is blocking the run — resume retries
the same step once its detector reads cleared. An irreversible step
blocked in unattended mode escalates because automation is simply refused
that action — resume continues at the *next* step, using the blocked
step's own checkpoint as the precondition, so automation never attempts
the irreversible action itself.

Resume never takes a human's word for it: it re-observes the live surface
and checks the precondition fresh before continuing. With no genuine human
available, the honest stand-in is `surface.act()` called directly against
the exact `WebSurface` instance replay escalated with —
`test/replay/resume-web.test.ts` runs the real artifact with "Sign On"
marked irreversible (which happens twice in the real flow), proving two
genuine handoffs on one continuously-open session, both resuming to the
same answer. `src/cli/replay.ts` wires the same mechanism to a real
terminal (pause on stdin, resume on Enter), though that path isn't
independently tested.

One defect: `Intervention.status` existed but was never read, so a second
resume call against an already-resolved intervention would silently
re-execute the blocked step. Fixed by re-reading `intervention.json` fresh,
refusing with `INTERVENTION_CONSUMED` unless still `open`, and persisting
`resolved` before continuing.

What isn't captured: a human's individual actions *during* a handoff
aren't traced, only the handoff boundary and the post-resume state — live
interaction tracing would mean instrumenting the page itself.

## 6. Safety

`config/policy.example.json` defines an allowlist of origins, routes, and
action kinds, risk tiers (safe/elevated/irreversible), and redaction
rules, enforced by `checkAction` in both discovery and replay — a model
exploring an application isn't a trusted context, so policy applies
identically to both. Redaction happens at the perception boundary, before
an observation reaches the planner, trace, artifact, or log.

Both were exercised by real defects, not just designed and trusted:

- A malformed regex silently fell through to the default risk tier via a
  swallowed constructor error, so every rule meant to escalate a
  delete/transfer to irreversible had done nothing since commit. Fixed by
  making case-insensitivity unconditional and letting a malformed pattern
  throw rather than fail open.
- Redaction originally matched a control's *label* as well as its value,
  so a caption reading "Password" was itself redacted — a live run
  surfaced this when the model couldn't find the sign-on field. Fixed by
  scoping the check to values only.
- A model's own free-text narration (`decision.intent`) was never
  redacted, propagating a typed secret into the trace, summary, and a
  compiled capability's rendered Markdown. Fixed by stripping the known
  secret substring from `intent` before pattern redaction, applied
  everywhere intent is persisted.
- The same gap existed independently in replay's own trace and
  failure-snapshot paths; fixed the same way, with tests proving the real
  secret reaches the surface while no evidence file ever contains it.

Two intentional asymmetries: a capability's *outputs* are never redacted,
since "read the balance" exists to relay exactly that value; and the
recorded model cassette is unredacted by design, since it exists to
reproduce an exact exchange — a narrower, real, un-exercised gap.

## 7. Cuts

- **Discovery runs on a local model** (Ollama) — a data-residency decision
  as much as a budget one. The provider is a one-line seam; only Ollama
  and Google are implemented.
- **Exactly two stretch goals**, per the brief's cap: cross-tenant overlay
  reuse and an agent-facing capability catalog (§4).
- **The target app is a deliberately hostile prop** — seeded data, stub
  auth, no persistence.
- **Only a web `Surface` adapter exists**; the desktop claim is structural
  (§1) but unproven.
- **`approval` is a manual JSON edit**, not a CLI command — every artifact
  here is still `draft` because no review has happened.
- **A human's actions during a handoff aren't individually traced** (§5)
  — only the handoff boundary and post-resume state.
- **The recorded cassette isn't redacted** (§6) — a redacted cassette
  couldn't replay the exchange it exists to reproduce.
- **No outcome is declared for the permission-denial case** the real
  artifact hits — it fails honestly rather than being misclassified (§3).
- **The original tenant-overlay scaffold was removed, not filled in**
  (§4) — a flat substitution proved sufficient once tested for real.
- **Screenshot+coordinate grounding was rejected** (§1) on cost,
  brittleness, and determinism grounds.
