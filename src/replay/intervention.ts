import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Detector } from "../artifact/schema.js";
import type { SessionLease } from "./lease.js";
import type { RecoveryRecord } from "./types.js";

/**
 * What replay hands a human when it stops rather than fails.
 *
 * Carries everything REPORT.md §5's direction promised: the capability, the
 * step, the observed state, why it stopped. What makes it more than a typed
 * error message is `precondition` - the concrete, re-checkable claim that
 * has to become true before `resumeCapability` will continue, so resuming
 * re-verifies rather than taking a human's word for it. Two different
 * escalation reasons need two different readings of "true":
 *
 *  - A `reauthenticate` remedy escalates because the blocking condition
 *    (the recoverable outcome's own detector) needs to go away - `expect:
 *    "cleared"`. `resumeAt` stays on the step that was blocked, so it gets
 *    retried once the human has, say, logged back in.
 *  - An irreversible step blocked in unattended mode escalates because
 *    *automation* is refused it, not because anything is wrong - a human is
 *    expected to perform that exact step themselves. `expect: "matched"`
 *    against the step's own checkpoint (its proof of having happened, same
 *    evidence replay would have checked itself), and `resumeAt` is the
 *    *next* step, since retrying the blocked one would mean automation
 *    attempting the irreversible action anyway.
 */
export interface Intervention {
  interventionId: string;
  runId: string;
  capabilityId: string;
  capabilityVersion: number;
  createdAt: string;
  reason: string;
  observedLocation: string;
  resumeAt: number;
  precondition?: { detect: Detector; expect: "matched" | "cleared" };
  /** Recoveries already recorded before this run stopped - carried forward
   *  on resume so the final result's history is not silently truncated at
   *  the handoff. */
  recoveriesSoFar: readonly RecoveryRecord[];
  lease: SessionLease;
  status: "open" | "resolved" | "abandoned";
}

export function interventionPath(runDir: string): string {
  return join(runDir, "intervention.json");
}

export async function writeIntervention(runDir: string, intervention: Intervention): Promise<void> {
  await writeFile(interventionPath(runDir), JSON.stringify(intervention, null, 2), "utf8");
}

export async function readIntervention(runDir: string): Promise<Intervention> {
  const raw = await readFile(interventionPath(runDir), "utf8");
  return JSON.parse(raw) as Intervention;
}
