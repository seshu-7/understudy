# Design write-up

> **Complete.** Written phase by phase as decisions got made and tested, not
> reconstructed at the end from memory - which is why the bugs a real run
> caught (§2, §4, §5, §6) are in here with the fix, not smoothed over. §7 is
> the final, honest list of what is out of scope and why.

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

**Rejected: screenshot-and-coordinates grounding.** A vision model reasoning
over pixels and clicking `(x, y)` would work against literally any rendering,
including the ones a DOM- or accessibility-tree-based adapter cannot see
inside (a canvas, a video call's UI). It was rejected for this problem
specifically, not in general: it needs a multimodal model capable enough to
reliably read a dense legacy screen, which on the CPU-only, $0 hardware this
project is scoped to is a materially harder bar than a plain instruct model
already struggling with text (§1's qwen3 measurement); it produces coordinate
targets that break the moment a layout reflows, which is exactly the
brittleness a scored, role-and-containment descriptor exists to avoid; and it
has no natural encoding as a stable `SemanticDescriptor` for replay to
re-resolve later; the coordinates that worked during discovery are not
evidence about anything a future screen will look like. The node-graph
approach is more work up front (an adapter has to know how to read the
target's accessibility layer) and buys determinism and portability neither
scheme gets for free otherwise.

**A boundary honestly still open, not just architecturally argued.** The
desktop claim - "Windows UI Automation and macOS AX produce the same shape"
- rests on `Surface` being a narrow enough interface that a second
implementation is plausible, and the `Action` vocabulary deliberately
excludes anything that only makes sense in a browser. Nobody has written that
second adapter. The claim is real evidence of a design decision (the
interface was shaped by this constraint from Phase 0, not retrofitted), but
it is not the same as a working desktop adapter, and this write-up says so
plainly rather than letting the architecture do the talking for something
that was never built.

## 2. Artifact schema

The schema is `src/artifact/schema.ts` — Zod, not a hand-written interface.
That is a decision, not a style choice: a capability read back off disk days
or tenants later is untrusted input crossing a real boundary, exactly where
validation earns its keep, and Zod's `z.infer` means the TypeScript types the
rest of the system compiles against and the runtime check that guards
`readFile` results are the same declaration, not two that can drift. The
descriptor vocabulary (`Role`, `TextMatch`, `SemanticDescriptor`, ...) lives
here too, and `src/surface/types.ts` re-exports it rather than keeping its own
copy — an earlier version of this file kept two hand-written definitions of
`SemanticDescriptor` in sync by convention, until compiling the first real
step through both caught a `readonly string[]` vs `string[]` mismatch on
`frame` that a parity test alone had not (and structurally could not: a
runtime test proves two representations agree on today's shape, not that
nobody edits one without the other next month).

A capability is a **contract an agent calls**, so it carries typed inputs,
typed outputs and a declared set of outcomes — not merely an ordered step
list. It is also a **build output**, which is why provenance records the
discovery run id and planner, but never enough to reconstruct the model
conversation. `prunedSteps` sits alongside them for the same reason — a
compiler that later learns to drop exploratory steps of its own would have
somewhere to report the count — but today's compiler has no pruning logic
at all; every step that reaches it already survived discovery-time
resolution and policy, so the field is always `0`, not a live count.

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

### The compiler

`src/artifact/compile.ts` turns a `DiscoveryOutcome` — the raw, ordered record
of one run — into a capability: a program a *different* set of inputs can run
correctly, not a transcript of what happened to member 100234 on one
afternoon. It does three things, and refuses rather than guesses wherever the
evidence does not clearly support a decision:

- **Parameterisation.** A fill/select/navigate value becomes a named input
  when it appears verbatim as its own token in the goal text — "100234" in
  both the typed value and "look up member 100234..." is checkable evidence
  it is caller-supplied, not a fixed detail of the flow. The same value reused
  across steps binds to one parameter, not several. A value the model typed
  that happens not to appear in the goal's wording — an inferred password, an
  operator ID — stays a literal; this is a real limit of the heuristic, not a
  placeholder, and the compiled artifact's inputs table is honest about what
  is and is not caller-controlled.
- **Checkpoint inference.** Step *N*'s checkpoint is "step *N+1*'s own target
  is present" — proof, taken from the discovery run itself, that the action
  actually advanced the flow. A checkpoint keyed to the literal text or a
  digest of the resulting screen would be wrong on purpose here: replay with
  different parameters is expected to land on a screen with different data,
  and a structural "does this control exist" check is invariant to that in a
  way a value-based one is not.
- **Output binding.** Discovery grounds every claimed output against the live
  snapshot at the moment it is produced (`src/discovery/ground.ts`), tracing
  the string the model claimed back to exactly one real node — or to nothing,
  if the match is missing or ambiguous, rather than guessing which node was
  meant. A claim that cannot be grounded fails the whole compile loudly; a
  capability that silently drops an output the goal asked for is worse than
  one that refuses to finish.

**A bug the compiler caught in its own output.** The last step in a run has
no *N+1* to borrow a checkpoint from, so it originally checkpointed against
the descriptor of whatever output the run produced — which sounds like the
same structural principle applied one step further, but is not: for a plain
`text`-role node there is no separate label, so its accessible *name* **is**
its displayed content. Compiling the real Phase 3 evidence run produced a
checkpoint reading "screen shows text named 4,182.55" — today's specific
balance, baked into the very descriptor meant to prove the capability still
works for a *different* member. The same defect existed in how that output
was re-extracted, which is the more serious half: replaying with a different
`member_number` would have searched the screen for a node literally named
today's balance and never found it. The fix (`structuralOnly` in
`compile.ts`) strips any `name`/`label` that literally equals the value that
was extracted through it, keeping only the evidence that does not vary with
the data — role, containing table, frame, ordinal position. The rendered
artifact now reads "screen shows text within 'Accounts' \[position 6\]",
which is a weaker-looking checkpoint and a correct one; the human-readable
render was what actually made this visible; a JSON diff would not have made
"the checkpoint over-fits to today's value" legible half as quickly. Real
evidence, not the hand-written test fixtures, is what surfaced this — the
fixtures used a descriptor without a `name` field at all, so the bug was
invisible to them until compiled against the genuine 5-step run.

### The render

`src/artifact/render.ts` produces the Markdown a human reviewer reads before
flipping a capability's `approval` from `draft` to `approved` — deliberately
rendering every field a shorter summary would drop, including the raw match
evidence a step will resolve against at replay time, because that is exactly
what a reviewer signing off on unattended replay against a legacy banking
screen needs to see.

## 3. Determinism & error handling

`src/replay/replay.ts` is the interpreter. Replay makes **zero model calls**
by construction — every decision in it is either read straight off the
compiled capability or computed from a live snapshot through the exact same
scored matcher discovery uses (`src/surface/match.ts`), never asked of a
planner. Same artifact, same inputs, same path is not a claim about how the
system usually behaves; it is a structural property of there being no model
call for anything to vary. `evidence/determinism-1786838165392/` checks this
rather than asserting it: the same capability, same input, replayed three
independent times, results diffed with only run-specific metadata (run id,
timestamps) excluded. Identical.

The brief is explicit that the interesting failures are runtime conditions
rather than layout drift, and its glossary names conflating a legitimate
business answer with a crash as the most common design mistake in this
problem. So the classification is modelled in the schema rather than left to
a `try`/`catch`: every capability can declare detectors, each mapped to
`business_outcome` (a real answer the caller needs), `recoverable` (with a
**bounded** remedy — an unbounded retry is how automation hammers a core
banking system at 3am), or `hard_failure`. `ReplayResult` has four arms
accordingly: success, business outcome, failure, escalated. All four are
exercised by real code paths in `test/replay/replay.test.ts`, not merely
typed and left untested.

Bounded remedies, concretely. `wait_retry` backs off and re-checks up to a
declared attempt count; `dismiss` resolves its own descriptor through the
same matcher every step uses and clicks it; `reauthenticate` names a human
action Phase 5 has no way to perform, so it escalates immediately rather than
spinning a retry loop that could never succeed — Phase 7's handoff is what
turns that into something resumable, and `ReplayEscalated.resumable` is
honestly `false` until it exists.

Failure detail answers three questions without anyone opening a screenshot:
which step, what was expected, what was observed — plus the per-signal match
scores when the failure came from target resolution. `failure/` in a replay's
evidence directory holds the screenshot and node snapshot from the exact
moment replay gave up.

**What "declaring an outcome" actually looks like, for real.** Replaying the
real Phase 4 artifact against `member_number=100599` reaches a genuine
permission-denial screen — *"Access to member 100599 is restricted. Contact
Compliance (ext. 4180)."* The compiled artifact has no outcome declared for
it (`compileCapability` never populates `outcomes` — nothing in a discovery
trace tells the compiler which of the *other* screens it never visited are
meaningful), so replay does exactly what it should with no matching detector:
reports `CHECKPOINT_FAILED` at the step whose checkpoint the screen never
reaches, honestly, rather than guessing it means something
(`evidence/replay-1786838072086/`). Turning that into a declared
`hard_failure` — a reviewer editing the artifact JSON, matching the same
"human adds it by hand" boundary `render.ts`'s default outcomes text already
names — is a real, small, well-scoped piece of follow-up work this evidence
run identifies concretely rather than a gap papered over in the write-up.

## 4. Heterogeneity & multi-tenant

The seam between "how we perceive and act on a surface" and "the recorded
flow" is the `Surface` interface plus the normalised node vocabulary.
`TargetBinding` has separated `app` (the vendor product) from `tenant` (one
institution's instance) since Phase 4, on the claim that a capability
recorded against one tenant should be reusable against another running the
same software rather than re-recorded per institution. This phase is that
claim, checked against a second real tenant rather than left as an
architectural note.

**A simpler mechanism than Phase 0 first sketched, because the simpler one
turned out to be enough.** The very first commit shipped `config/tenants/
meridian.json` and `cascade.json`: a tenant registry with a structured
`overlay: { stepOverrides: [], outcomeOverrides: [] }` field, populated per
step by path. That scaffold sat untouched for eight phases and was removed
in this one rather than filled in - once there was an actual capability and
an actual second tenant to reuse it against, a flat `Record<string, string>`
of literal text substitutions (`applyOverlay` in `src/artifact/overlay.ts`)
turned out to say everything the real rename needed said, and a
step-indexed override structure would have been complexity built for a
scenario this project never actually exercised. Keeping the unused scaffold
around and calling it "supported" would have been the dishonest choice; the
right one was to let what got built diverge from the first sketch and say
so here, not to force the sketch to be right in hindsight.

**A second, real tenant, not a mock.** `target-app/tenants.ts` adds
`TenantBranding` and a second preset (`NORTHSTAR`) to the exact same server
code every other test in this repo runs - `createServicingServer(tenant)`
threads it through the screens that carry branding, defaulting to the
original single-tenant text so nothing else changes. Northstar renames the
member-search button from "Search" to "Find Member" - the precise example
`src/surface/text.ts`'s own header has used throughout this project as the
canonical case a locator strategy has to survive.

**The overlay is text substitution only, deliberately.** `src/artifact/
overlay.ts`'s `applyOverlay` rewrites every `name`/`label` a step, checkpoint,
output or outcome detector targets, plus the target binding's tenant and
entry point - nothing else. An overlay that could add or remove steps would
be a second compiler with none of the first one's evidence discipline
(refusing to guess, grounding every output); rewriting a `TextMatch` literal
only asserts "this tenant calls the same control something else," and if
that turns out to be false the overlaid capability's own checkpoints fail
loudly at replay time exactly the way any other wrong descriptor would.
`contentHash` is recomputed (moved to `src/artifact/hash.ts` so the compiler
and the overlay share one implementation rather than two that could drift)
and `approval` always resets to `draft`, regardless of the source
capability's approval state - nobody has reviewed *these* descriptors yet.

**What the matcher's own robustness turned out not to cover, checked for
real, not assumed.** The working theory going in was that structural
evidence (containment, ordinal) would let the raw, un-overlaid recording
degrade gracefully against the rename - "weaker match, still works."
`test/artifact/overlay-web.test.ts` replays the real committed artifact
against a real, independently-launched northstar server
(`npm run target-app` with `TARGET_APP_TENANT=northstar`, evidenced in
`evidence/replay-1786846579516/`) and the actual result is more interesting
than that: the raw recording fails outright, and one step *before* the
renamed button, not at it. Step 3's checkpoint is "step 4's own target is
present" (Phase 4's checkpoint-inference rule), and step 4's target is the
button that no longer carries the text it was recorded against - so replay
never even gets to *attempt* step 4; it stops at step 3's `CHECKPOINT_FAILED`
first. For this rename, an overlay is not a robustness nicety, it is the
difference between the capability working on a second tenant at all and not.
The overlaid capability (`applyOverlay` with `{"Search": "Find Member"}`,
committed as `artifacts/corevantage_servicing.member_savings_balance
.northstar.v1.json`) replays clean end-to-end and reaches the identical
`savings_balance: "4,182.55"` the original meridian recording does - real
evidence in `evidence/replay-1786846579516/`, a real second policy instance
in `config/policy.northstar.json` (a real deployment configures policy per
tenant same as it configures branding per tenant), from a JSON file with one
button's name literally rewritten and nothing else.

**The capability catalog.** README.md's original layout sketch named
`src/catalog/` as "the agent-facing capability surface," and that is what it
is: `loadCatalog` reads and Zod-validates every artifact in a directory,
`toToolDefinition` projects a `Capability`'s already-typed `inputs`/`outputs`
into the JSON-Schema-shaped tool definition an LLM agent's own tool-use
surface would need, and `invokeCapability` looks a capability up by id and
dispatches straight to `replayCapability` - deliberately with no policy or
approval logic of its own to duplicate and let drift out of sync with the
real interpreter's, the same failure mode already found and fixed twice in
Phase 6 (REPORT.md §6). `npm run catalog -- --tools` prints exactly what an
agent integration would see.

**The catalog and the overlay disagreed about what an id means, and the real
committed artifacts proved it.** `applyOverlay` never changed the source
capability's own `id` - so `artifacts/corevantage_servicing.
member_savings_balance.v1.json` (meridian) and its northstar overlay, the
exact two files the demo path above walks through in order, answered to one
identical id. `loadCatalog` had no uniqueness check, so `findCapability`/
`invokeCapability` silently returned whichever file `readdir()` happened to
list first - no error, no warning, and no way for a caller to know or
choose which tenant (pointed at a completely different server) actually
ran. Running the real, unmodified `npm run catalog -- --tools` against
`artifacts/` exactly as committed printed two tool definitions sharing one
sanitised name, which is malformed as an actual tool-use request on top of
the underlying lookup ambiguity. Fixed the same way every other place a
capability could be silently ambiguous already fails loud rather than
guesses: `applyOverlay` now mints a tenant-qualified id (the same
`.{tenant}` suffix the CLI's own output filename already carried, so the id
and the file that holds it finally agree), and `loadCatalog` throws on any
duplicate id, naming both files. The committed northstar artifact was
regenerated with the fix; `contentHash` is unchanged, since `id` was never
part of what it hashes.

## 5. Escalation & handoff

The direction sketched here in earlier phases is built: `src/replay/lease.ts`
(`SessionLease`, owner `automation | human`, a monotonic token that only
increments on a real ownership change), `src/replay/intervention.ts` (the
persisted record a handoff raises), and `resumeCapability` in
`src/replay/replay.ts`, which is what actually made `ReplayEscalated`'s
`resumable` field able to be `true` - Phase 5 shipped it hardcoded `false`
with a comment saying this phase would fix that.

**The two escalation reasons need different resume semantics, not one.** A
`reauthenticate` remedy escalates because a *condition* is blocking the run -
the same step is still waiting to happen, so resume retries it, and the
precondition is that remedy's own detector now reading `cleared` rather than
present. An irreversible step blocked in unattended mode escalates for the
opposite reason: nothing is wrong, automation is simply refused that one
action, and a human is expected to perform *that exact step* themselves. Resume
there continues at the *next* step - retrying it would mean automation
attempting the irreversible action anyway, the precise thing the block exists
to prevent - and the precondition is the blocked step's own checkpoint (its
ordinary proof of having happened, same evidence replay would have checked if
it had been allowed to act). `Intervention.resumeAt` and `.precondition`
encode this per escalation rather than leaving `resumeCapability` to guess
which case it is in.

**Resume never takes a human's word for it.** Before continuing anything,
`resumeCapability` re-observes the live surface and checks the intervention's
precondition fresh - a human saying "I'm done" is not itself evidence the
blocking condition actually cleared, and proceeding on that alone would be
exactly the kind of guess this project's matcher and checkpoints already
refuse to make everywhere else. `test/replay/replay.test.ts` ("refuses to
continue when the precondition still does not hold") proves this returns a
real failure rather than silently pressing on.

**Real evidence, not just a scripted fake.** No genuine human was available
to this test, so the most honest stand-in is `surface.act()` called directly
against the exact `WebSurface` instance replay itself escalated with - the
same call a human's own click produces through the same interface, never a
freshly launched browser. `test/replay/resume-web.test.ts` runs the real
committed artifact against the real target app with "Sign On" marked
irreversible for the test, which happens twice in the real 5-step flow (once
to leave the login screen, once to confirm the operator ID) - so this is two
genuine handoffs against one continuously-open session, not one. Both resume
correctly and the run reaches the identical answer
(`savings_balance: "4,182.55"`) the fully-automated replay does.
`src/cli/replay.ts` wires the same mechanism to an actual terminal: on a
resumable escalation it leaves the browser open, pauses on stdin instead of
exiting, and calls `resumeCapability` once a human presses Enter - this path
is real code, not a stub, but wasn't itself exercisable by an agent with no
terminal human to press the key, which is exactly why the automated
browser-driven test above exists as the checked evidence instead.

**A stale or duplicate resume used to silently re-execute the step it was
blocked on.** `Intervention.status` (`open | resolved | abandoned`) existed
from this phase's first version but was never read anywhere and never
written to anything but `"open"` — `resumeCapability` re-checked the
precondition but had no notion that an intervention could already be spent.
Concretely: a second call to `resumeCapability` against an intervention that
had already been successfully resumed once would find the precondition
still holds (a `reauthenticate` handoff's "login cleared" condition, once
true, stays true) and silently re-execute the step it was blocked on,
returning a second "successful" `ReplayResult` with no error and no warning.
For this project's own idempotent balance lookup that is harmless; for a
capability whose blocked step is a "Submit"/"Post"/"Transfer" control that
stays visible after firing, a stray retry wrapper, a crash-and-restart from
a persisted `intervention.json`, or a second concurrent caller would
duplicate a real action — precisely the "unbounded retry hammering a core
banking system" failure class the bounded-remedy design in §3 exists to
prevent everywhere else, with no equivalent bound on resume itself.
`resumeCapability` now re-reads `intervention.json` from disk fresh rather
than trusting the caller's possibly-stale in-memory copy (the same reasoning
as re-checking the precondition against a fresh observation rather than a
human's word), refuses with a new `INTERVENTION_CONSUMED` failure unless the
on-disk record is still `"open"` and its id matches, and persists
`status: "resolved"` *before* continuing rather than after, so a second call
reads the update rather than racing it.

**One boundary from the original sketch not fully built.** "Their actions are
captured into the same trace tagged as human-authored" is only partly true:
the handoff itself is a real `trace.jsonl` event (`kind: "handoff"`, both
directions), and everything automation does *after* resuming is traced
exactly as it always is. What a human does *during* the handoff - which
buttons, in what order, whether they took a different path than the recorded
one - is not captured at all, because nothing is watching the page while
`resumeCapability` waits; only the state resume observes when it re-checks
the precondition is. Recording a human's own interactions live would mean
instrumenting the page itself (a DOM listener or Playwright's own input
tracing) rather than the interpreter loop, which is a materially bigger
feature than this phase's scope, and is named here rather than left for a
reader to assume already works.

## 6. Safety

`config/policy.example.json` defines an explicit allowlist of origins, routes
and action kinds, risk tiers separating safe from elevated from irreversible,
and redaction rules - enforced, respectively, by `checkAction`
(`src/discovery/policy.ts`) and the redaction module below, in both discovery
(`src/discovery/loop.ts`) and replay (`src/replay/replay.ts`, Phase 5's
attended/unattended gating is written up in §3).

Two decisions worth stating early. Policy is enforced on every action in
**both** discovery and replay — a model exploring a back-office application is
not a trusted context, and is exactly where an unbounded action does damage.
That includes risk tiers, not just the allowlist: `runDiscovery` calls the
same `unattendedGate` replay's unattended mode does before any action
executes, since discovery has no per-step human confirmation either. The one
asymmetry is what happens on a disallowed tier - replay can escalate to a real
handoff (§5) because a live session and a resumable intervention exist to
escalate *to*; discovery has neither, so it always treats a disallowed tier
as a hard stop (`policy_blocked`) rather than pausing for a human mid-run.
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

**A third defect, in the same lineage, caught this phase by checking a claim
against the code rather than by a run surfacing a symptom.**
`src/discovery/redact.ts`'s own header states the guarantee plainly:
*"everything downstream — the text sent to the planner, the trace written to
disk, the evidence committed to the repo — is built from what this module
returns, never from the raw snapshot."* That was true for the text a model
*reads* (`formatObservation` redacts before anything reaches the planner) and
false for the values a model *types*. `src/discovery/loop.ts` traced the raw
`decision` object, the raw resolved `Action`, and stored that same raw action
into `DiscoveredStep` — which `summary.json` persists and Phase 4's compiler
reads directly — without ever passing through redaction. A fill into a field
labelled "Password" would have had its real value sitting in plain text in
committed evidence and, worse, baked as a hardcoded literal into the compiled
capability, replayed identically and unrotatably forever. The target app's
own login accepts any credential and stores nothing, so no run in this
repository ever actually exposed one — but the compiler and the loop needed
to be correct regardless of what this particular demo app happens to protect.

Fixed at the same boundary the other two defects were: `DiscoveredStep` gains
a `sensitive` flag, set once in the loop from the target's label against the
same field-name list redaction already uses. The **live** action is never
touched — `surface.act()` still receives the real value, because that is
what makes the automation work — but what gets traced and what gets stored in
`steps[]` is redacted from that point on. `compile.ts` reads the flag and
takes a different path entirely for a sensitive step: always a required,
`sensitive` parameter with no `example`, never a literal and never deduped
against another sensitive field's value — deduping would be wrong here in a
way it is not for an ordinary repeated value, since two different secrets
redacted to the same placeholder text must not collapse into one parameter
just because their (fake) recorded values match.

Building the fix surfaced a second copy of the identical mistake, this time
in Phase 5's own replay engine, which this project's evidence-first habit
would otherwise have shipped for a whole phase before anyone noticed: a
`sensitive` parameter's real value — supplied fresh by the *caller* at
replay time, not recorded anywhere — still has to be resolved to a literal
string to actually execute the fill, and that resolved action was being
traced into `evidence/replay-*/trace.jsonl` verbatim. Separately, a live
failure snapshot (`failure/snapshot.json`) persists whatever every visible
control's current value happens to be at the moment replay gave up,
including a password field's live contents if one happened to be on screen.
Both are fixed the same way: `redactSnapshot` (`src/discovery/redact.ts`)
applies the identical label/value asymmetry `formatObservation` already uses
to a whole snapshot rather than one rendered line, and `replay.ts` redacts a
resolved action's value before tracing it whenever the `ValueSource` it came
from points at a `sensitive` parameter. Four tests
(`test/replay/replay.test.ts`, "redaction inside replay") prove the real
secret still reaches the surface while neither trace file nor failure
evidence ever contains it.

**A fourth defect, found exactly the way this project's own history said one
still might be hiding: by a live run, not a code read.** A live discovery
run was asked to sign on and type a password into the login screen's
`Password` field. `action.text` came back `[redacted:field]` exactly as the
third defect's fix intended — but `decision.intent`, the model's own
free-text sentence narrating what it had just done (*"Type the password
`<secret>` into the Password field"*), was never touched by any redaction
anywhere, and a small model narrating its own action routinely repeats the
value verbatim. That sentence went to `trace.jsonl` (both the `"decision"`
and `"action"` trace events) and `summary.json` unredacted, and — the more
serious half, matching the third defect's own worst case — propagates
directly into a compiled `Capability.steps[].intent`, which `render.ts`
renders as a bolded, prominent line in the human-readable `.md` a reviewer
reads *before* flipping `approval` from `draft` to `approved`. A leaked
secret here would sit front-and-center in exactly the document meant to be
a security review, not buried in a JSON field a reviewer might never open.

Root cause: `redactDecisionForTrace` only ever overwrote `decision.text`/
`.option`; nothing touched `intent`, and the `"action"` trace event and the
`DiscoveredStep` pushed into `steps[]` (the object `summary.json` persists
and the compiler reads directly) used the raw `decision.intent`
unconditionally, regardless of whether the step's own `sensitive` flag sat
right next to it in the same object literal. `intent` is natural-language
prose, not a value with a known shape, so the existing pattern-based
`redactText` alone could not be trusted to catch it reliably. `redactIntent`
(`src/discovery/loop.ts`) instead strips the *exact* raw typed or selected
value out of `intent` first — the one substring known for certain to be the
secret, since it is the same string `action.text`/`.option` already
redacted — then runs the ordinary pattern redaction over what's left as a
backstop, applied everywhere `intent` gets persisted: the decision trace
event, the action trace event, `steps[]`, and the `historyLines` fed back
into the model's own next-turn context. The regression test for this
deliberately mirrors the real leak rather than a convenient fixture: the
scripted intent text repeats the raw secret the way the live model actually
did, not a generic "enter the password" that would never have exercised the
bug at all.

**Two boundaries worth naming rather than leaving implicit.** First, this
redaction path is for *input* text — what a decision typed in. What a
capability *extracts* as an output is deliberately never redacted: a "read
the member's balance" capability exists specifically to relay that value to
whoever called it, and redacting the one thing the caller asked for would
make the automation useless while adding no real protection (the caller
already knows what field they asked to read). The asymmetry is intentional,
not an oversight the input-side fix forgot to apply symmetrically. Second,
`planner.jsonl` (the recorded cassette, `src/discovery/cassette.ts`) captures
the model's raw decision unredacted, by design — a cassette exists to
reproduce an exact exchange at zero cost, and a redacted cassette could not
replay the same decision back. If a model ever generated a real secret as
part of a fill decision, cassette recording would capture it even though
`summary.json` and the compiled artifact would not, since those are written
from the (now-redacted) resolved action, not from the raw decision. No run in
this repository has ever exercised that path for real data - the login
screen accepts and stores nothing - but it is a real, narrower gap than the
one this phase closed, named here rather than left for a reader to discover.

## 7. Cuts

The final list. Everything here was a real decision, not an oversight -
each either has its full reasoning written up elsewhere in this document
(linked) or is small enough to explain in place.

- **Discovery runs on a local model** (Ollama) rather than a hosted frontier
  model. A design position, not only a budget one: back-office banking
  screens carry member names, account numbers and balances in every
  observation, and no institution is going to pipe those to a third-party
  inference API. Local-first discovery is a data-residency property. The
  provider sits behind a one-line seam, so re-running discovery on a hosted
  frontier model is an environment variable - `src/discovery/providers/
  google.ts` exists specifically to keep that claim checkable, but only two
  providers are implemented (Ollama, Google); no third was built, since
  breadth of provider support was never the thing being evaluated.
- **Exactly two stretch goals**, per the brief's cap: cross-tenant overlay
  reuse, and an agent-facing capability catalog (§4). Multi-run stability is
  not counted as a third - replaying N times and diffing the results is
  evidence for the determinism requirement in §3, not an extra feature.
- **The target application is a prop.** Deliberately hostile markup, seeded
  in-memory data, stub authentication, no persistence.
- **Only a web `Surface` adapter exists.** The desktop claim is structurally
  argued (§1) - the interface and action vocabulary were shaped by it from
  Phase 0 - but nobody has written a Windows UI Automation or macOS AX
  adapter to prove it. Building and testing one is a multi-day task
  orthogonal to what this brief evaluates.
- **A capability's `approval` field is a one-line JSON edit, not a CLI
  command.** `render.ts` exists so a human has something real to review
  before making that edit; a dedicated `npm run approve` would be tooling
  around a single string field. Every artifact committed in this repository
  is still `draft` because nobody has done that review yet, not because the
  mechanism to flip it is missing.
- **A human's own actions during a handoff are not individually traced**
  (§5) - only the moment control changes hands and the state resume observes
  when it re-checks. Recording live interaction would mean instrumenting the
  page itself, not the interpreter loop.
- **The recorded model cassette (`planner.jsonl`) is not redacted** (§6) - a
  narrower, un-exercised gap than the one this project found and fixed for
  everything else, kept because a redacted cassette could not reproduce the
  exchange it exists to replay.
- **No outcome is declared on the real committed artifact.** Replaying it
  against a member who triggers a real permission-denial screen fails
  honestly (`CHECKPOINT_FAILED`) rather than being misclassified as a
  business answer, but turning that into a declared `hard_failure` is a
  reviewer's edit this project identified concretely (§3) without making.
- **The original `config/tenants/*.json` scaffold from Phase 0 was removed,
  not filled in** (§4) - a flat text-substitution overlay proved sufficient
  once there was an actual second tenant to test against, and the more
  elaborate `stepOverrides`/`outcomeOverrides` structure it sketched was
  speculative complexity for a scenario this project never exercised.
- **Screenshot-and-coordinates UI grounding was considered and rejected**
  (§1) in favour of the accessibility-tree node graph, on cost, brittleness
  and replay-determinism grounds specific to this problem.
