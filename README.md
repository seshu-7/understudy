# understudy

An understudy watches the performer, learns the part, then performs it without them.

This is the integration layer that gives an AI agent hands inside applications
that expose no API. An LLM drives a real UI to work out how a task is done. The
successful run is compiled into a typed, versioned **capability**. From then on
that capability replays deterministically, with no model in the decision loop.

```
goal ──▶ discovery (LLM drives the UI) ──▶ trace ──▶ compiler ──▶ capability
                                                                      │
                          agent calls it ──▶ deterministic replay ◀───┘
                                              (no model, repeatable, free)
```

> **Status: in progress.** Phase 0 of 9. This README grows as the system does;
> the setup and demo sections below are placeholders until the pieces they
> describe exist.

## Why it is built this way

Four decisions carry the design. Each is argued properly in [REPORT.md](./REPORT.md).

**1. Perception is a normalised UI graph, never raw markup.** A surface adapter
emits nodes with a role, an accessible name, state and relationships. The model
never sees HTML. This is what makes the desktop story a real seam rather than a
paragraph of intent — Windows UI Automation and macOS AX produce the same shape.

**2. Controls are addressed by scored evidence, not by selector.** Each step
records a bundle — role, accessible name, nearby label, containing section,
relative anchor, ordinal — and replay scores every candidate node against it. A
unique winner above threshold wins; anything else is `AMBIGUOUS_TARGET` and a
hard stop. It refuses to guess, and it can explain why it matched.

**3. The three-way outcome taxonomy lives in the schema.** Every capability
declares what a legitimate business answer looks like ("no such member"), what
is recoverable and with what *bounded* remedy, and what is a hard failure. The
glossary in the brief calls conflating the first with the third the most common
design mistake in this problem; making it declarative is how we avoid it.

**4. Control transfer is a lease, not a callback.** Escalation releases the
session; a human drives the *same* live session; their actions are captured into
the same trace; resume re-verifies the next step's precondition before
continuing rather than blindly picking up where it left off.

## Running it costs nothing

Discovery runs against a **local model via Ollama** — no API key, no account, no
network. That is not only a budget decision. Back-office banking screens carry
member names, account numbers and balances in every observation, and no
institution is going to pipe those to a third-party inference API. Local-first
discovery is a data-residency property; the provider sits behind a one-line seam
so anyone who wants to run it on a hosted frontier model can.

Replay makes **zero** model calls by construction. That is the entire point of
the system.

## Setup

_Phase 0 — not yet written. Will cover: prerequisites, `npm install`, pulling
the local model, starting the target application, and how to run everything
without any live service._

## Demo path

_Phase 0 — not yet written. Will give the exact commands to run the agent
against a goal and then replay the resulting artifact._

## Layout

| Path | What lives there |
| --- | --- |
| `src/surface/` | The perception and action boundary — snapshots, descriptors, the matcher |
| `src/discovery/` | The LLM observe → decide → act loop |
| `src/artifact/` | Capability schema and the trace → capability compiler |
| `src/replay/` | The zero-LLM interpreter |
| `src/policy/` | Allowlist, risk tiers, redaction |
| `src/session/` | Control lease and human handoff |
| `src/operator/` | Minimal operator console |
| `src/catalog/` | Agent-facing capability surface |
| `target-app/` | The legacy back-office application being automated, and a second tenant variant |
| `artifacts/` | Saved capabilities |
| `evidence/` | Discovery and replay run evidence |

## Documents

- [REPORT.md](./REPORT.md) — the design write-up
- [evidence/](./evidence/) — what actually happened when it ran

## License

MIT
