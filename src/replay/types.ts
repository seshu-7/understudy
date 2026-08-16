import type { MatchEvidence, SemanticDescriptor } from "../surface/types.js";
import type { OutcomeClass } from "../artifact/types.js";

/**
 * The result contract — what an AI agent gets back when it invokes a
 * capability in production.
 *
 * Four arms, not two. The brief is explicit that conflating a legitimate
 * business answer with a crash is the most common design mistake here, so
 * `business_outcome` is its own arm rather than an error subtype or a null
 * return. `escalated` is the fourth because a run that stopped and handed
 * control to a human is neither a success nor a failure, and a caller that
 * cannot tell the difference will retry something a person is mid-way through.
 */
export type ReplayResult =
  | ReplaySuccess
  | ReplayBusinessOutcome
  | ReplayFailure
  | ReplayEscalated;

export interface ReplayCommon {
  runId: string;
  capabilityId: string;
  capabilityVersion: number;
  startedAt: string;
  finishedAt: string;
  stepsAttempted: number;
  /** Recoverable conditions that fired and were handled. Empty on a clean
   *  run. Worth returning even on success: three retries every time is a
   *  signal something is degrading, and nobody sees it if we hide it. */
  recoveries: readonly RecoveryRecord[];
  evidenceDir: string;
}

export interface ReplaySuccess extends ReplayCommon {
  status: "success";
  outputs: Record<string, unknown>;
}

/** A legitimate answer the caller needs, that happens not to be the happy
 *  path. `outcome` is the machine name declared on the capability, so the
 *  calling agent branches on a known value rather than parsing prose. */
export interface ReplayBusinessOutcome extends ReplayCommon {
  status: "business_outcome";
  outcome: string;
  data: Record<string, unknown>;
}

export interface ReplayEscalated extends ReplayCommon {
  status: "escalated";
  interventionId: string;
  reason: string;
  /** Whether the run can be resumed once a human is done, or whether the
   *  caller has to start over. */
  resumable: boolean;
}

export interface ReplayFailure extends ReplayCommon {
  status: "failed";
  failure: FailureDetail;
}

/**
 * Failure detail exists to answer three questions without anyone opening a
 * screenshot: which step, what did it expect, what did it actually see.
 */
export interface FailureDetail {
  code: FailureCode;
  stepIndex: number;
  stepIntent: string;
  expected: string;
  observed: string;
  /** Present when the failure came from target resolution, so the report can
   *  show which signals matched and which did not. */
  match?: {
    descriptor: SemanticDescriptor;
    bestScore: number;
    runnerUp: number | null;
    evidence?: MatchEvidence;
  };
  message: string;
}

export type FailureCode =
  /** Nothing scored above threshold. The control is genuinely not there. */
  | "TARGET_ABSENT"
  /** Several candidates scored alike. We refuse to guess — see the note on
   *  MatchResult in surface/types.ts for why this is a hard stop. */
  | "AMBIGUOUS_TARGET"
  /** The action landed but the checkpoint did not hold. */
  | "CHECKPOINT_FAILED"
  /** A declared recoverable condition exhausted its bounded remedy. */
  | "RECOVERY_EXHAUSTED"
  /** A declared `hard_failure` outcome's detector matched. Distinct from
   *  every other code here: those all mean replay itself broke down trying
   *  to execute the script; this means replay executed exactly as recorded
   *  and the screen it reached is a known bad outcome, not an unexpected one. */
  | "OUTCOME_HARD_FAILURE"
  /** The action call itself never returned within the step's `timeoutMs`
   *  budget - distinct from CHECKPOINT_FAILED, which only starts counting
   *  once the action has already returned. */
  | "STEP_TIMEOUT"
  /** Policy refused the action — off-allowlist route, or an irreversible
   *  step attempted in unattended mode. */
  | "POLICY_BLOCKED"
  /** The surface itself broke: frame detached, session dead, process gone. */
  | "SURFACE_ERROR"
  /** An observation matched nothing the artifact knows about. Deliberately
   *  distinct from the others: this is the one that means the recording has
   *  drifted from reality and a human should look at it. */
  | "UNRECOGNISED_STATE"
  /** `resumeCapability` was called against an intervention that was already
   *  resumed (or abandoned) once before. Nothing was retried and nothing
   *  was touched on the live surface - a second, stale resume call on the
   *  same handoff is refused rather than silently re-executing the step it
   *  was blocked on. */
  | "INTERVENTION_CONSUMED";

export interface RecoveryRecord {
  stepIndex: number;
  outcome: string;
  class: Extract<OutcomeClass, "recoverable">;
  attempts: number;
  succeeded: boolean;
}
