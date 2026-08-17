# understudy

An understudy watches the performer, learns the part, then performs it without them.

This is the integration layer that gives an AI agent hands inside applications
that expose no API. An LLM drives a real UI to work out how a task is done.
The successful run compiles into a typed, versioned **capability**. After
that, the capability replays deterministically. No model sits in the
decision loop.

```
goal ──▶ discovery (LLM drives the UI) ──▶ trace ──▶ compiler ──▶ capability
                                                                      │
                          agent calls it ──▶ deterministic replay ◀───┘
                                              (no model, repeatable, free)
```

Built across nine phases against a deliberately hostile legacy banking
console, with a real local model driving discovery at every step. The
evidence is committed alongside the code rather than just claimed in prose.
[REPORT.md](./REPORT.md) is the full design write-up, including the bugs a
real run caught, how they got fixed, and the cuts made along the way.

## Why it is built this way

Four decisions carry the design. Each is argued properly in [REPORT.md](./REPORT.md).

**1. Perception is a normalised UI graph, never raw markup.** A surface adapter
emits nodes with a role, an accessible name, state and relationships. The model
never sees HTML. This is what makes the desktop story a real seam rather than a
paragraph of intent: Windows UI Automation and macOS AX produce the same shape,
though only the web adapter is actually built and tested here (REPORT.md §7).

**2. Controls are addressed by scored evidence, not by selector.** Each step
records a bundle: role, accessible name, nearby label, containing section,
relative anchor, ordinal. Replay scores every candidate node against it. A
unique winner above threshold wins; anything else is `AMBIGUOUS_TARGET` and a
hard stop. It refuses to guess, and it can explain why it matched.

**3. The three-way outcome taxonomy lives in the schema.** Every capability can
declare what a legitimate business answer looks like ("no such member"), what
is recoverable and with what *bounded* remedy, and what is a hard failure. The
brief's glossary names conflating the first with the third as the most common
design mistake in this problem. Making the taxonomy declarative is how this
avoids it.

**4. Control transfer is a lease, not a callback.** Escalation releases the
session. A human drives the *same* live session (proven against a real
browser in `test/replay/resume-web.test.ts`), and resume re-verifies its
precondition before continuing rather than blindly picking up where it left
off.

## Running it costs nothing

Discovery runs against a **local model via Ollama**. No API key, no account,
no network. That's not purely a budget decision: back-office banking screens
carry member names, account numbers and balances in every observation, and no
institution is going to pipe those to a third-party inference API. Local-first
discovery is a data-residency property, and the provider sits behind a
one-line seam (`src/discovery/providers/`), so anyone who wants to run it on a
hosted frontier model can, without touching the loop itself.

Replay makes **zero** model calls by construction. That is the entire point of
the system, checked in `evidence/determinism-1786838165392/`, not just claimed.

## Setup

Requires Node 22+, [Ollama](https://ollama.com) running locally, and Playwright's
bundled Chromium.

```bash
npm install
npx playwright install chromium

ollama pull qwen2.5:7b-instruct   # the model every committed evidence run used

cp .env.example .env              # defaults already cost $0 and need no account
```

The target application is a self-contained legacy banking console (plain
`node:http`, no framework, hand-written HTML on purpose — see
[`target-app/README.md`](./target-app/README.md)). Start it in one terminal
and leave it running:

```bash
npm run target-app
# [target-app] CoreVantage Servicing (meridian) on http://127.0.0.1:4501/servicing/
```

Everything below runs against that server, in a second terminal.

## Demo path

**1. Discover.** An LLM drives the live UI to work out a task with no script,
no selector, and no prior knowledge of the screen. This is the one step that
calls a model — everything after it is free and repeatable.

```bash
npm run discover -- --goal "look up member 100234 and read their current savings balance"
# writes evidence/discovery-<runId>/
```

Real evidence from this exact command is already committed:
[`evidence/discovery-1786836008257/`](./evidence/discovery-1786836008257/).
`UNDERSTUDY_CASSETTE=replay` (the `.env.example` default) replays a recorded
exchange instead of calling Ollama at all. Same five decisions, in seconds,
with zero model calls physically possible; see
[`evidence/discovery-1786834288146/`](./evidence/discovery-1786834288146/).

**2. Compile.** Distil the trace into a typed, versioned capability.
Parameters get inferred from what varied, checkpoints from what proved each
step worked, outputs traced back to a real node on screen.

```bash
npm run compile -- evidence/discovery-1786836008257/summary.json \
  --id corevantage_servicing.member_savings_balance \
  --name "Look up a member's savings balance"
# writes artifacts/<id>.v<version>.json and the human-readable .md alongside it
```

The real output is committed:
[`artifacts/corevantage_servicing.member_savings_balance.v1.json`](./artifacts/corevantage_servicing.member_savings_balance.v1.json)
/ [`.md`](./artifacts/corevantage_servicing.member_savings_balance.v1.md).

**3. Replay.** Zero model calls. Same artifact, same inputs, same path, by
construction rather than tendency.

```bash
npm run replay -- artifacts/corevantage_servicing.member_savings_balance.v1.json \
  --input member_number=100234
```

Try a member the capability was never recorded against
(`--input member_number=100412`, three accounts instead of two) and watch the
same artifact generalise instead of just replaying verbatim. Real evidence in
[`evidence/replay-1786838058351/`](./evidence/replay-1786838058351/), written
up in REPORT.md §2.

**4. Call it like an agent would.** The capability catalog projects every
artifact into an Anthropic-tool-use-shaped definition: typed inputs, typed
outputs, nothing an integration has to guess.

```bash
npm run catalog -- --tools
```

**5. Reuse across tenants, without re-recording.** The same capability,
against a second real institution running the same vendor software with one
button renamed. REPORT.md §4 covers what happens without this step first.

```bash
TARGET_APP_PORT=4502 TARGET_APP_TENANT=northstar npm run target-app   # third terminal

npm run overlay -- artifacts/corevantage_servicing.member_savings_balance.v1.json \
  --tenant northstar --entry-point http://127.0.0.1:4502/servicing/login.asp \
  --override "Search=Find Member"

npm run replay -- artifacts/corevantage_servicing.member_savings_balance.northstar.v1.json \
  --input member_number=100234 --policy config/policy.northstar.json
```

## Running the tests

```bash
npm test
```

187 tests. Several run against the real target app and a real headless
browser (Playwright) rather than fixtures standing in for either, including
the cross-tenant replay above and the escalation/handoff flow, both checked
against real browser sessions in `test/`. No test calls a model. The one
`Planner` a live model could reach is never exercised outside `npm run
discover` itself.

## Layout

| Path | What lives there |
| --- | --- |
| `src/surface/` | The perception and action boundary — snapshots, descriptors, the matcher |
| `src/discovery/` | The LLM observe → decide → policy-gate → act → record loop, and the redaction/policy modules it enforces |
| `src/artifact/` | Capability schema, the trace → capability compiler, the tenant overlay, the human-readable render |
| `src/replay/` | The zero-model interpreter, the session lease, and the escalation/resume mechanism |
| `src/catalog/` | The agent-facing capability surface — list, tool-definition projection, dispatch |
| `src/cli/` | `discover` / `compile` / `replay` / `catalog` / `overlay`, one file each |
| `target-app/` | The legacy back-office application being automated, and a second tenant variant |
| `config/` | Policy (allowlist, risk tiers, redaction) — shipped as reviewable examples, never silent defaults |
| `artifacts/` | Saved capabilities — real ones, compiled or overlaid, not fixtures |
| `evidence/` | What actually happened when discovery and replay ran, committed on purpose |
| `test/` | Unit tests against fakes for logic, integration tests against the real app and a real browser for everything that touches one |

## Documents

- [REPORT.md](./REPORT.md) — the design write-up, including trade-offs, bugs a real run caught, and cuts
- [evidence/README.md](./evidence/README.md) — an index of what actually happened when it ran
- [artifacts/README.md](./artifacts/README.md) — what's saved and how it got there
- [target-app/README.md](./target-app/README.md) — the legacy application being automated

## License

MIT
