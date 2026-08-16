/**
 * Who is driving the live session right now.
 *
 * A lease exists so a handoff is a recorded fact, not an implication. The
 * token is monotonic and increments on every ownership change, not because
 * this single-threaded interpreter has a real race to resolve - it doesn't,
 * replay and a resumed replay never run concurrently against the same
 * surface - but because the trace should let a reviewer answer "who did
 * this step" without inferring it from which function happened to be on the
 * call stack. `automation -> human -> automation` across an escalation and
 * its resume is two token increments, visible in the intervention record.
 */

export interface SessionLease {
  runId: string;
  capabilityId: string;
  owner: "automation" | "human";
  token: number;
}

export function initialLease(runId: string, capabilityId: string): SessionLease {
  return { runId, capabilityId, owner: "automation", token: 0 };
}

/** Idempotent - acquiring a lease already held by `owner` returns it
 *  unchanged rather than burning a token on a no-op handoff. */
export function acquire(lease: SessionLease, owner: SessionLease["owner"]): SessionLease {
  if (lease.owner === owner) return lease;
  return { ...lease, owner, token: lease.token + 1 };
}
