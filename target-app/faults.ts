/**
 * Fault injection.
 *
 * The brief's point is that in a stable enterprise UI the interesting
 * failures are runtime conditions, not layout drift. Those conditions are
 * hard to demonstrate honestly if you have to wait for one to happen, so this
 * arms them on demand and the evidence directory becomes reproducible on
 * anyone's machine.
 *
 * Note what is *not* here: "member not found", "invalid member number" and
 * "access restricted" are absent on purpose. Those come from ordinary inputs
 * against ordinary data (see data.ts). Injecting them would make the business
 * outcomes a lie — they are real behaviour of the application, and a reviewer
 * can reach them by typing a bad number into the form.
 */

export type FaultMode =
  | "none"
  /** An unexpected confirmation dialog appears before the action completes.
   *  Recoverable: dismiss it and carry on. */
  | "interstitial"
  /** The page takes long enough to be indistinguishable from hung.
   *  Recoverable: wait and retry, bounded. */
  | "slow"
  /** The application errors outright. Recoverable once, hard failure if it
   *  keeps happening. */
  | "error_500"
  /** The session is gone. Not recoverable without a human — this is the one
   *  that has to escalate. */
  | "session_expired";

export const FAULT_MODES: readonly FaultMode[] = [
  "none",
  "interstitial",
  "slow",
  "error_500",
  "session_expired",
];

export function isFaultMode(value: string): value is FaultMode {
  return (FAULT_MODES as readonly string[]).includes(value);
}

interface ArmedFault {
  mode: FaultMode;
  /** Clear after firing once. Default true: a fault that stays armed turns a
   *  demonstration into an infinite loop. */
  once: boolean;
  /** Only fire on paths containing this substring. Empty means any path. */
  path: string;
}

let armed: ArmedFault = { mode: "none", once: true, path: "" };
let slowMs = 6000;

export function arm(mode: FaultMode, opts: { once?: boolean; path?: string; slowMs?: number } = {}): void {
  armed = { mode, once: opts.once ?? true, path: opts.path ?? "" };
  if (opts.slowMs !== undefined) slowMs = opts.slowMs;
}

export function reset(): void {
  armed = { mode: "none", once: true, path: "" };
  slowMs = 6000;
}

export function status(): { mode: FaultMode; once: boolean; path: string; slowMs: number } {
  return { ...armed, slowMs };
}

/** Returns the fault to apply to this request, consuming it if it was armed
 *  for a single shot. */
export function take(pathname: string): FaultMode {
  if (armed.mode === "none") return "none";
  if (armed.path && !pathname.includes(armed.path)) return "none";
  const mode = armed.mode;
  if (armed.once) armed = { mode: "none", once: true, path: "" };
  return mode;
}

export function currentSlowMs(): number {
  return slowMs;
}
