# evidence

What actually happened when this ran. Committed on purpose — it is a
deliverable, not a build product.

## Runs in this repository

| Directory | What it is |
| --- | --- |
| [`discovery-1786833847548/`](./discovery-1786833847548/) | **The genuine LLM-driven discovery run** the brief requires. Local model (`ollama/qwen2.5:7b-instruct`), no key, no account. Goal: *"look up member 100234 and read their current savings balance."* Reached the answer in 5 steps — sign on, search, read — and extracted `savings_balance: "4,182.55"`, matching the seeded data exactly. Cost: $0.00. |
| [`discovery-1786834288146/`](./discovery-1786834288146/) | **The same run, replayed from the cassette recorded in the run above, with the Ollama server stopped entirely** before this was started. Same five decisions, same outputs, in seconds instead of minutes, with zero model calls physically possible — Ollama was not reachable when this ran. This is the evidence for "how to run without live services," and for the claim that every run after the first costs nothing. |
| [`discovery-1786836008257/`](./discovery-1786836008257/) | **A second genuine live run of the same goal, one day later** (`ollama/qwen2.5:7b-instruct`, $0.00) — reached the identical answer (`savings_balance: "4,182.55"` in 5 steps) independently. Recorded after `DiscoveryOutcome` grew the `goal` and `outputGroundings` fields the Phase 4 compiler reads (see [`src/discovery/ground.ts`](../src/discovery/ground.ts)); the two rows above predate that shape and cannot be compiled as-is. This is the summary.json Phase 4's `npm run compile` actually consumed — [`artifacts/corevantage_servicing.member_savings_balance.json`](../artifacts/corevantage_servicing.member_savings_balance.json) is a real compiled artifact, not a fixture. |

Do not confuse the second row with Phase 5's replay engine. This replays the
**discovery cassette** — the recorded model exchange — to prove discovery
itself is reproducible offline. Phase 5's replay evidence (`replay-*/`, once
it exists) is a different thing: the *compiled capability* executing with no
model in the loop at all, which is the system's actual production path.

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

## What will be here at submission

| Run | Shows |
| --- | --- |
| `discovery-*` | One genuine LLM-driven run against the live surface |
| `replay-success-*` | The compiled capability replaying clean, with outputs |
| `replay-business-outcome-*` | A "no such member" result returned as an answer, not an error |
| `replay-failure-*` | An injected fault detected and reported with step, expected and observed |
| `replay-escalated-*` | A run that stopped, handed control to a human, and resumed |
| `determinism-*` | The same capability replayed N times, results diffed |
| `cross-model-*` | The same goal discovered by two different models, compiled artifacts compared |

Sensitive values are redacted at the perception boundary, before anything
reaches this directory. A test asserts that nothing secret-shaped is present.
