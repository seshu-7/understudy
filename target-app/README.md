# CoreVantage Servicing — the target application

A stand-in for the kind of back-office system this project exists to automate:
a server-rendered credit-union servicing console with no API, no test hooks and
no intention of being automated.

```bash
npm run target-app     # http://127.0.0.1:4501/servicing/
```

Any operator id signs on. No credential is stored or checked, and no real
personal data appears anywhere — the members are invented.

A second tenant, same server code, one rebranded control — `target-app/
tenants.ts` — runs standalone on its own port:

```bash
TARGET_APP_PORT=4502 TARGET_APP_TENANT=northstar npm run target-app
```

Northstar renames the member-search button from "Search" to "Find Member."
Every other screen, and the seeded data, is identical. See REPORT.md §4 for
what that one rename does to a capability recorded against the tenant above.

## Why build one instead of using a public demo site

Three reasons, in order of weight.

**Exceptional states have to happen on demand.** The brief's central point is
that in a stable enterprise UI the interesting failures are runtime conditions
— a permission denial, a surprise dialog, a dead session — not layout drift. A
public site will not produce those when you need them, so the evidence would be
a matter of luck. Here they are armed with an HTTP call and reproduce on anyone's
machine.

**It can be genuinely hostile.** Most public demo sites are modern apps with
clean markup. That is the opposite of the environment described in the brief,
and automating one would prove very little.

**It respects the ground rules.** No terms to violate, no rate limits to
exhaust, no real credentials, no real PII.

## What makes it hostile

Every unpleasant thing here is deliberate, and there is a test that keeps it
that way (`test/target-app.test.ts`, "the surface stays hostile").

| Trait | Consequence for automation |
| --- | --- |
| No `id`, no ARIA, no `data-testid`, no `<label>` | Controls have **no accessible name at all**. The Member Number field can only be found by its position relative to the text beside it. |
| Labels are plain text in the adjacent table cell | There is no programmatic label association to look up. |
| Buttons are `<input type="submit">` | The accessible name comes from the `value` attribute, not element text. |
| Real `<frameset>` shell | The address bar never changes as you navigate. A URL-based checkpoint is worthless. |
| Sub-account form inside an `<iframe>` **within** the content frame | The final checkpoint and the value to extract are two frames deep. |
| Layout tables, `<font>`, `bgcolor`, HTML 4.01 | The accounts grid exposes no row or cell roles — every value is a bare text node. |
| Errors distinguished only by colour | Detecting "did that fail?" has to be done on text. |

## The flow

```
sign on ─▶ member search ─▶ member detail ─▶ open sub-account ─▶ confirmation
                                 │                                    │
                        savings balance                     reference number
                          (extractable)                       (extractable)
```

## Outcomes reachable from ordinary input

These are real behaviour, not injected faults — a reviewer can reach every one
of them by typing into the form.

| Input | Result | Class |
| --- | --- | --- |
| `100234`, `100235`, `100412`, `100777` | Member detail | success |
| `999999` (or any unknown) | "No member found" | business outcome |
| `12ab`, `1234`, anything not 6 digits | "must be exactly 6 digits" | business outcome |
| `100599` | "Access ... is restricted" | hard failure |
| `100801` | Member detail, no open accounts | business outcome |
| Deposit below `25.00` | "must be at least 25.00" | business outcome |
| Deposit that is not a number | "is not a valid amount" | business outcome |

## Faults you cannot reach by typing

Armed over HTTP. Single-shot by default — a fault that stays armed turns a
demonstration into an infinite loop.

```bash
curl "http://127.0.0.1:4501/__control/fault?mode=interstitial"
curl "http://127.0.0.1:4501/__control/fault?mode=slow&slowMs=8000"
curl "http://127.0.0.1:4501/__control/fault?mode=error_500&path=acct.asp"
curl "http://127.0.0.1:4501/__control/fault?mode=session_expired&once=0"
curl "http://127.0.0.1:4501/__control/reset"
curl "http://127.0.0.1:4501/__control/status"
```

| Mode | Intended handling |
| --- | --- |
| `interstitial` | recoverable — dismiss the dialog and continue |
| `slow` | recoverable — wait, bounded |
| `error_500` | recoverable once, hard failure if persistent |
| `session_expired` | **escalate** — re-authenticating needs a credential the system deliberately does not hold |

Parameters: `once=0` keeps it armed, `path=<substring>` fires only on matching
requests, `slowMs=<n>` sets the delay.

## What is deliberately fake

Stub authentication, in-memory data reset on restart, no persistence, and
period-appropriate ugliness in place of styling. It is a prop. The parts that
have to be real — the markup's hostility and the outcome behaviour — are real,
and are the parts under test.
