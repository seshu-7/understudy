# Design write-up

> **In progress — Phase 3 of 9.** Sections fill in as the decisions get made
> and tested, not at the end from memory. Anything not yet built says so
> plainly rather than describing an intention in the present tense.

## 1. Architecture

The through-line: **the model discovers, a compiler distils, an interpreter
replays.** Discovery emits a raw trace; a separate compilation pass turns that
trace into a typed capability; replay is a plain interpreter over the
capability with no model in it. The model's conversation is *evidence* and
lives in `evidence/`; the capability is a *build output* and nothing in it
points back into the transcript.

Four decisions carry the design.

**Perception is a normalised UI graph, never raw markup.** A `Surface` adapter
emits nodes carrying role, accessible name, state, geometry and containment.
The model never sees HTML. This is the seam that makes the desktop claim real
rather than aspirational: Windows UI Automation and macOS AX produce the same
shape, so extending to a desktop surface means writing an adapter, not
reworking the artifact schema or the replay engine. `src/surface/types.ts`
holds the boundary; the `Action` union deliberately excludes anything that
could only work in a browser, because admitting one such action is how the
abstraction quietly becomes browser-only.

**Controls are addressed by scored evidence, not by selector.** See §2.

**The three-way outcome taxonomy is declarative.** See §3.

**Control transfer is a lease.** See §5.

**Discovery is observe → format → decide → policy gate → act → record**, and
the model gets exactly one JSON decision per turn from a fixed vocabulary of
eight actions — never a tool-calling protocol. That choice is about
portability more than taste: tool-calling conventions differ enough between
providers, and are flaky enough on a small model, that "produce one JSON
object matching this schema" is the contract every target provider (Ollama's
`format`, Gemini's `responseSchema`) already supports natively. The loop
never trusts the model with more than one action at a time, and policy is
checked on the resolved action *before* it reaches the surface — discovery is
not a trusted context merely because it is exploratory.

**The model choice is a measured decision, not an assumed one.** The obvious
pick — a hybrid-thinking model like `qwen3:4b` — was tried first and rejected
on evidence: it spent 150–200 invisible "thinking" tokens on a two-word
reply, and a single realistic decision exceeded a five-minute ceiling with no
response at all, reproduced with and without the JSON-schema constraint.
Neither Ollama's generic `think: false` field nor Qwen3's own documented
`/no_think` directive suppressed it on this build. Switching to a plain
instruct model (`qwen2.5:7b-instruct`, no hybrid-thinking mode) brought a
realistic decision down to roughly 90 seconds with a correct result. The
generalisable point: on CPU-bound, wall-clock-bounded hardware, a model that
reasons unconditionally is a worse default than a smaller model that answers
directly, independent of parameter count. `src/discovery/providers/ollama.ts`
carries the full timing evidence.

_Trade-offs, boundaries, and what was rejected: pending._

## 2. Artifact schema

_Full schema and rationale: pending Phase 4._ The shape is committed in
`src/artifact/types.ts` and the reasoning so far:

A capability is a **contract an agent calls**, so it carries typed inputs,
typed outputs and a declared set of outcomes — not merely an ordered step
list. It is also a **build output**, which is why provenance records the
discovery run id, planner and how many exploratory steps the compiler pruned,
but never enough to reconstruct the model conversation.

The locator design is the part worth arguing. A selector is a single
hypothesis that either hits or misses. A `SemanticDescriptor` is instead a
bundle of independent evidence — role, accessible name, adjacent label,
containing section, relative anchor, ordinal — that every candidate node is
scored against. Two consequences the brief asks for fall out of that. A tenant
rebranding "Search" to "Find Member" degrades the name signal while the
structural signals still carry the match. And when two candidates score alike,
the matcher reports `AMBIGUOUS_TARGET` and stops rather than taking the first
hit, because guessing is how automation posts a transaction to the wrong
account.

## 3. Determinism & error handling

_Pending Phases 4–5._ The committed contract:

Replay makes **zero model calls** by construction — it is an interpreter over
a fixed program, so the same artifact and the same inputs take the same path.

The brief is explicit that the interesting failures are runtime conditions
rather than layout drift, and its glossary names conflating a legitimate
business answer with a crash as the most common design mistake in this
problem. So the classification is modelled in the schema rather than left to a
`try`/`catch`: every capability declares detectors, each mapped to
`business_outcome` (a real answer the caller needs), `recoverable` (with a
**bounded** remedy — an unbounded retry is how automation hammers a core
banking system at 3am), or `hard_failure`. `ReplayResult` has four arms
accordingly: success, business outcome, failure, escalated.

Failure detail answers three questions without anyone opening a screenshot:
which step, what was expected, what was observed — plus the per-signal match
scores when the failure came from target resolution.

## 4. Heterogeneity & multi-tenant

_Pending Phase 8 and the write-up._ Direction: the seam between "how we
perceive and act on a surface" and "the recorded flow" is the `Surface`
interface plus the normalised node vocabulary. `TargetBinding` separates `app`
(the vendor product) from `tenant` (one institution's instance), which is what
lets a single artifact be reused across tenants running the same software with
a per-tenant overlay applied on top, rather than re-recorded per tenant.

## 5. Escalation & handoff

_Pending Phase 7._ Direction: a `SessionLease` with an owner
(`automation | human`) and a monotonic control token. Escalation releases the
lease and raises an intervention carrying the capability, the step, the
observed state and why it stopped. The human drives the **same** live session,
not a fresh one; their actions are captured into the same trace tagged as
human-authored; resume re-verifies the next step's precondition before
continuing rather than blindly picking up where it left off.

## 6. Safety

_Pending Phase 6._ Committed so far: `config/policy.example.json` defines an
explicit allowlist of origins, routes and action kinds, risk tiers separating
safe from elevated from irreversible, and redaction rules.

Two decisions worth stating early. Policy is enforced on every action in
**both** discovery and replay — a model exploring a back-office application is
not a trusted context, and is exactly where an unbounded action does damage.
And redaction happens at the **perception boundary**, before an observation
reaches the planner, the trace, an artifact or a log; redacting at write time
is too late, because by then the value has already been sent to the model.

Both were tested against real defects, not just designed and trusted. The
shipped `nameMatches` risk rules and the bearer-token redaction pattern were
originally written `"(?i)\\bpattern\\b"` — valid in PCRE, not in JS `RegExp`,
which throws at construction on the inline group. The original `catch` around
that construction swallowed the error and fell through to the default risk
tier, so every rule meant to escalate a delete or a transfer to irreversible
had done nothing since the policy file was first committed, silently.
Case-insensitivity is now unconditional in the matcher rather than something
every pattern author has to encode correctly, and a genuinely malformed
pattern now throws instead of failing open — a guardrail that fails open on a
typo is worse than one that refuses to run. Separately, the first version of
the redaction check applied the field-name test to a control's *label* as
well as its value, so a plain caption reading "Password" was itself replaced
with `[redacted:field]` — destroying the exact text a model needs to find the
password field, in the name of protecting a caption that was never sensitive.
A live discovery run surfaced this directly: the model repeatedly chose
`navigate` with no destination on the sign-on screen because its own label
had been redacted out from under it. Fixed by scoping the field-name check to
values only; a control's label and a plain text node's name get pattern
redaction alone.

## 7. Cuts

_Final list at Phase 9._ Decided so far:

- **Discovery runs on a local model** (Ollama) rather than a hosted frontier
  model. This is a design position, not only a budget one: back-office banking
  screens carry member names, account numbers and balances in every
  observation, and no institution is going to pipe those to a third-party
  inference API. Local-first discovery is a data-residency property. The
  provider sits behind a one-line seam, so re-running discovery on a hosted
  frontier model is an environment variable. The honest cost is capability —
  a small model needs a cleaner observation format to succeed, which is itself
  the point being tested.
- **Exactly two stretch goals**, per the brief's cap: cross-tenant overlay
  reuse, and an agent-facing capability catalog. Multi-run stability is not
  counted as a third — replaying N times and diffing the results is evidence
  for the determinism requirement in §3.3, not an extra feature.
- **The target application is a prop.** Deliberately hostile markup, seeded
  in-memory data, stub authentication, no persistence.
