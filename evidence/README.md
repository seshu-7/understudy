# evidence

What actually happened when this ran. Committed on purpose — it is a
deliverable, not a build product.

## Runs in this repository

| Directory | What it is |
| --- | --- |
| [`discovery-1786833847548/`](./discovery-1786833847548/) | **The genuine LLM-driven discovery run** the brief requires. Local model (`ollama/qwen2.5:7b-instruct`), no key, no account. Goal: *"look up member 100234 and read their current savings balance."* Reached the answer in 5 steps — sign on, search, read — and extracted `savings_balance: "4,182.55"`, matching the seeded data exactly. Cost: $0.00. |
| [`discovery-1786834288146/`](./discovery-1786834288146/) | **The same run, replayed from the cassette recorded in the run above, with the Ollama server stopped entirely** before this was started. Same five decisions, same outputs, in seconds instead of minutes, with zero model calls physically possible — Ollama was not reachable when this ran. This is the evidence for "how to run without live services," and for the claim that every run after the first costs nothing. |
| [`discovery-1786836008257/`](./discovery-1786836008257/) | **A second genuine live run of the same goal, one day later** (`ollama/qwen2.5:7b-instruct`, $0.00) — reached the identical answer (`savings_balance: "4,182.55"` in 5 steps) independently. Recorded after `DiscoveryOutcome` grew the `goal` and `outputGroundings` fields the Phase 4 compiler reads (see [`src/discovery/ground.ts`](../src/discovery/ground.ts)); the two rows above predate that shape and cannot be compiled as-is. This is the summary.json Phase 4's `npm run compile` actually consumed — [`artifacts/corevantage_servicing.member_savings_balance.v1.json`](../artifacts/corevantage_servicing.member_savings_balance.v1.json) is a real compiled artifact, not a fixture. |

Do not confuse the second row with Phase 5's replay engine. This replays the
**discovery cassette** — the recorded model exchange — to prove discovery
itself is reproducible offline. Phase 5's replay evidence (`replay-*/`,
below) is a different thing: the *compiled capability* executing with no
model in the loop at all, which is the system's actual production path.

### Replay

| Directory | What it is |
| --- | --- |
| [`replay-1786838029329/`](./replay-1786838029329/) | **The compiled capability, replaying clean.** `member_number=100234`, attended, against the live target app. All 5 steps resolved and checkpointed; `savings_balance: "4,182.55"` — matching the discovery run it was compiled from exactly. |
| [`replay-1786838058351/`](./replay-1786838058351/) | **The same capability, a different member.** `member_number=100412`, a member with three accounts instead of two. This is the real test of Phase 4's `structuralOnly` fix (REPORT.md §2): the checkpoint and output-extraction descriptors were stripped of the literal balance they were recorded against specifically so this would still work. It does — `savings_balance: "22,940.18"`, correct for this member, with zero edits to the artifact. |
| [`replay-1786838072086/`](./replay-1786838072086/) | **An honest failure, not a crash.** `member_number=100599` reaches a real permission-denial screen ("Access to member 100599 is restricted. Contact Compliance...") that this capability has no declared outcome for — nobody has reviewed the draft artifact and added one yet. Replay reports `CHECKPOINT_FAILED` at step 4 rather than silently succeeding or throwing; `failure/` holds the screenshot and node snapshot from the moment it gave up. This is the gap a human reviewer closes by adding a `hard_failure` outcome to the artifact, not something replay should paper over on its own. |
| [`replay-1786838157645/`](./replay-1786838157645/), [`replay-1786838165392/`](./replay-1786838165392/) | Two more runs of `member_number=100234`, same as the first — see `determinism-1786838165392/` below. |
| [`determinism-1786838165392/`](./determinism-1786838165392/) | **The determinism claim, checked, not just asserted.** The three `100234` runs above, diffed against each other with only run-specific metadata (runId, timestamps, evidence path) excluded. Identical. |
| [`replay-1786846579516/`](./replay-1786846579516/) | **Cross-tenant reuse, against a real second tenant.** `artifacts/corevantage_servicing.member_savings_balance.northstar.v1.json` (produced by `npm run overlay`, "Search" rewritten to "Find Member") replayed against an independently-launched `TARGET_APP_TENANT=northstar` server on its own port, with its own policy (`config/policy.northstar.json`) — not the in-process test server every other row here uses. Reaches the identical `savings_balance: "4,182.55"` the original meridian recording does. REPORT.md §4 has the full write-up, including what happens to the *un*-overlaid capability against this same tenant (checked in `test/artifact/overlay-web.test.ts`, not captured as a directory here — see that test's own header for why). |

Each discovery run is a directory named `discovery-<runId>/`:

```
discovery-<runId>/
  trace.jsonl        every observation, decision and action, in order
  planner.jsonl      the model exchange — the cassette, replayable at zero cost
  steps/             a screenshot per step
  summary.json       goal, outcome, step count, token cost, wall time

replay-<runId>/
  trace.jsonl        every step, match score and checkpoint result
  result.json        the ReplayResult exactly as a calling agent received it
  failure/           screenshot and node snapshot, written only on failure
```

## Status against the brief

| Run | Shows | Status |
| --- | --- | --- |
| `discovery-*` | One genuine LLM-driven run against the live surface | done |
| `replay-*` (success) | The compiled capability replaying clean, with outputs, against inputs it was **not** recorded on | done |
| `replay-*` (failure) | A real, undeclared condition detected and reported with step, expected and observed — not a crash | done |
| `determinism-*` | The same capability replayed N times, results diffed | done |
| `replay-business-outcome-*` | A declared business outcome (e.g. "no such member") returned as an answer, not an error | pending a reviewer declaring one on the artifact — see the `replay-1786838072086` row above |
| escalate + resume | A run that stopped, handed control to a human, and resumed | done — proven live, not from a directory (see below) |
| cross-tenant reuse | The same capability, overlaid and replayed against a second real tenant with no re-recording | done — `replay-1786846579516/` above |
| `cross-model-*` | The same goal discovered by two different models, compiled artifacts compared | cut — REPORT.md §7 caps this project at two stretch goals; cross-tenant reuse and the capability catalog were the two chosen |

**Escalation and handoff, why this one isn't a static directory.** Every
other row here is a `npm run discover`/`npm run compile`/`npm run replay`
invocation captured once and committed. A genuine handoff needs a human to
actually act mid-run, which an agent generating this repository cannot
produce as a one-off recording without faking the human's half. The honest
substitute — used instead of a fabricated `replay-escalated-*/` — is
[`test/replay/resume-web.test.ts`](../test/replay/resume-web.test.ts): a real
`WebSurface`, the real committed artifact, run against a policy that marks
"Sign On" irreversible (which happens twice in the real flow), with a
stand-in for the human's own action calling `surface.act()` directly against
the exact browser instance replay itself escalated with. It resumes correctly
across both handoffs and reaches the identical `savings_balance: "4,182.55"`
the fully-automated run does — re-run it any time with `npm test` rather than
trusting a snapshot of one run that happened once. REPORT.md §5 has the full
write-up, including what this does and does not prove.

Sensitive values are redacted at the perception boundary, before anything
reaches this directory. A test asserts that nothing secret-shaped is present.
