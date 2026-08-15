# evidence

What actually happened when this ran. Committed on purpose — it is a
deliverable, not a build product.

> Empty until Phase 3. This file documents the shape so the layout is fixed
> before anything is written into it.

Each run gets a directory named `<kind>-<runId>/`:

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
