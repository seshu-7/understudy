import { describeDetector, describeTarget } from "../artifact/format.js";
import type { Capability, Detector, OutcomeSpec, ParamSpec, Remedy, SemanticDescriptor, Step, ValueSource } from "../artifact/schema.js";
import { checkAction, unattendedGate, type Policy } from "../discovery/policy.js";
import { redactSnapshot } from "../discovery/redact.js";
import { match } from "../surface/match.js";
import { coerceOutput, evaluateDetector, extractOutput, type DetectorResult } from "./detect.js";
import { readIntervention, type Intervention, writeIntervention } from "./intervention.js";
import { acquire, initialLease, type SessionLease } from "./lease.js";
import { ReplayTraceWriter } from "./trace.js";
import type { Action, NodeRef, Surface, UISnapshot } from "../surface/types.js";
import type { FailureCode, RecoveryRecord, ReplayCommon, ReplayResult } from "./types.js";

/**
 * The interpreter. Zero model calls, by construction: every decision here is
 * either read straight off the compiled capability or computed from a live
 * snapshot through the same scored matcher discovery uses, never asked of a
 * planner. Same artifact, same inputs, same path - that is the whole point
 * of having compiled a capability in the first place.
 *
 * Structured the same as discovery's own loop on purpose - observe, resolve,
 * policy-gate, act, verify - because replay is not a different philosophy
 * about safety, it is the same one with no model in the loop to second-guess.
 */

export class ReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayError";
  }
}

export interface ReplayDeps {
  runId: string;
  surface: Surface;
  policy: Policy;
  trace: ReplayTraceWriter;
  /** A human is watching this run. Unattended-only gates (approval,
   *  maxTier, onIrreversible) are skipped; the allowlist and deny-routes are
   *  not - those are a boundary about what this system may ever touch, not
   *  about who is watching it touch it. */
  attended: boolean;
  pollIntervalMs?: number;
  /** Step index to begin at - 0 for a fresh run. `resumeCapability` sets
   *  this to `Intervention.resumeAt` to continue the same run rather than
   *  starting over. */
  startAt?: number;
  /** Recoveries already recorded before a resume, carried forward so the
   *  final result's history is not truncated at the handoff. */
  initialRecoveries?: readonly RecoveryRecord[];
  /** Who owns the live session right now. Defaults to a fresh
   *  automation-owned lease; `resumeCapability` passes the one from the
   *  intervention, re-acquired for automation. */
  lease?: SessionLease;
}

function resolveValue(value: ValueSource, inputs: Readonly<Record<string, string>>): string {
  if (value.kind === "literal") return value.value;
  const resolved = inputs[value.name];
  if (resolved === undefined) throw new ReplayError(`missing required input "${value.name}"`);
  return resolved;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const STEP_TIMED_OUT = Symbol("step-timed-out");

/** Races a promise against a step's own `timeoutMs` budget. `surface.act()`
 *  has no bound of its own - a detached frame, a click an overlay silently
 *  swallows, a dead browser process can all hang it forever - so replay has
 *  to be the one to give up rather than wedge indefinitely. Distinct from a
 *  thrown error (SURFACE_ERROR, which fires as soon as the promise rejects)
 *  and from a checkpoint that never holds (CHECKPOINT_FAILED, which only
 *  starts counting once the action has already returned): this is
 *  specifically "the action call itself never returned at all". JS has no
 *  promise cancellation, so a genuinely hung `work` keeps running in the
 *  background after this resolves - the same unavoidable trade-off any
 *  timeout race makes. */
async function withStepTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T | typeof STEP_TIMED_OUT> {
  let timer!: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<typeof STEP_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(STEP_TIMED_OUT), timeoutMs);
  });
  try {
    return await Promise.race([work, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

function isSensitiveValueSource(value: ValueSource, capability: Capability): boolean {
  return value.kind === "param" && (capability.inputs.find((p: ParamSpec) => p.name === value.name)?.sensitive ?? false);
}

/** The concrete Action a step resolved to is what actually reaches the live
 *  surface - correctly, it has to carry the real value for `act()` to work.
 *  This is the same value with the same redaction discovery already applies
 *  before anything is traced, for the same reason: a caller supplying a
 *  `sensitive` parameter at replay time (the password itself, this time,
 *  not a placeholder) must not have it land in trace.jsonl just because
 *  replay - unlike discovery - has no planner-facing text to redact it out
 *  of in the first place. */
function redactActionForTrace(action: Action, stepAction: Step["action"], capability: Capability, policy: Policy): Action {
  const placeholder = policy.redaction.placeholder.replace("{name}", "field");
  if (action.kind === "fill" && stepAction.kind === "fill" && isSensitiveValueSource(stepAction.value, capability)) {
    return { ...action, text: placeholder };
  }
  if (action.kind === "select" && stepAction.kind === "select" && isSensitiveValueSource(stepAction.value, capability)) {
    return { ...action, option: placeholder };
  }
  if (action.kind === "navigate" && stepAction.kind === "navigate" && isSensitiveValueSource(stepAction.to, capability)) {
    return { ...action, to: placeholder };
  }
  return action;
}

async function waitForDetector(
  detector: Detector,
  surface: Surface,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<{ ok: true; snapshot: UISnapshot } | { ok: false; result: DetectorResult; snapshot: UISnapshot }> {
  const deadline = Date.now() + timeoutMs;
  let lastResult: DetectorResult = { matched: false, observed: "(never observed - timeout budget was zero or negative)" };
  let lastSnapshot = await surface.observe();
  for (;;) {
    lastResult = evaluateDetector(detector, lastSnapshot);
    if (lastResult.matched) return { ok: true, snapshot: lastSnapshot };
    if (Date.now() >= deadline) return { ok: false, result: lastResult, snapshot: lastSnapshot };
    await sleep(pollIntervalMs);
    lastSnapshot = await surface.observe();
  }
}

function findFiredOutcome(outcomes: readonly OutcomeSpec[], snapshot: UISnapshot): { spec: OutcomeSpec; result: DetectorResult } | undefined {
  for (const spec of outcomes) {
    const result = evaluateDetector(spec.detect, snapshot);
    if (result.matched) return { spec, result };
  }
  return undefined;
}

function extractOutcomeData(spec: OutcomeSpec, snapshot: UISnapshot): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const item of spec.data ?? []) {
    data[item.name] = coerceOutput(extractOutput(item, snapshot), item.type);
  }
  return data;
}

type RemedyOutcome =
  | { kind: "recovered"; snapshot: UISnapshot; attempts: number }
  | { kind: "escalate"; reason: string }
  | { kind: "exhausted"; snapshot: UISnapshot; attempts: number };

/** Applies a recoverable outcome's declared remedy, bounded by whatever the
 *  remedy itself bounds it by. `reauthenticate` cannot be attempted here at
 *  all - it names a human action Phase 5 has no way to perform, so it
 *  escalates immediately rather than pretending a retry loop could ever
 *  clear it. Phase 7's handoff is what turns that into something resumable;
 *  this only reports that a human is needed and why. */
async function applyRemedy(
  spec: OutcomeSpec,
  remedy: Remedy,
  surface: Surface,
  pollIntervalMs: number,
): Promise<RemedyOutcome> {
  if (remedy.kind === "reauthenticate") {
    return { kind: "escalate", reason: `"${spec.name}" declares a reauthenticate remedy, which requires a human` };
  }

  const attempts = remedy.kind === "wait_retry" ? remedy.attempts : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (remedy.kind === "dismiss") {
      const snapshot = await surface.observe();
      const target = match(remedy.descriptor, snapshot);
      if (target.status === "unique") await surface.act({ kind: "click", target: target.ref });
    } else {
      await sleep(remedy.backoffMs);
    }

    const snapshot = await surface.observe();
    if (!evaluateDetector(spec.detect, snapshot).matched) return { kind: "recovered", snapshot, attempts: attempt };
    if (attempt < attempts && remedy.kind !== "wait_retry") await sleep(pollIntervalMs);
  }
  return { kind: "exhausted", snapshot: await surface.observe(), attempts };
}

type TargetedStepAction = Extract<Step["action"], { kind: "click" | "fill" | "select" }>;

function concreteAction(action: TargetedStepAction, target: NodeRef, inputs: Readonly<Record<string, string>>): Action {
  switch (action.kind) {
    case "click":
      return { kind: "click", target };
    case "fill":
      return { kind: "fill", target, text: resolveValue(action.value, inputs) };
    case "select":
      return { kind: "select", target, option: resolveValue(action.value, inputs) };
  }
}

export async function replayCapability(
  capability: Capability,
  inputs: Readonly<Record<string, string>>,
  deps: ReplayDeps,
): Promise<ReplayResult> {
  const { runId, surface, policy, trace, attended } = deps;
  const pollIntervalMs = deps.pollIntervalMs ?? 500;
  const startAt = deps.startAt ?? 0;
  const lease = deps.lease ?? initialLease(runId, capability.id);

  if (capability.approval === "retired") {
    throw new ReplayError(`capability "${capability.id}" is retired and must not be replayed`);
  }
  if (!attended && capability.approval !== policy.unattended.requiresApproval) {
    throw new ReplayError(
      `capability "${capability.id}" is "${capability.approval}", but unattended replay requires "${policy.unattended.requiresApproval}" - run attended, or get it reviewed first`,
    );
  }
  for (const param of capability.inputs) {
    if (param.required && inputs[param.name] === undefined) {
      throw new ReplayError(`missing required input "${param.name}" ("${param.description}")`);
    }
  }

  await trace.init();
  const startedAt = new Date().toISOString();
  const recoveries: RecoveryRecord[] = [...(deps.initialRecoveries ?? [])];
  let stepsAttempted = startAt;

  const common = () => ({
    runId,
    capabilityId: capability.id,
    capabilityVersion: capability.version,
    startedAt,
    finishedAt: new Date().toISOString(),
    stepsAttempted,
    recoveries,
    evidenceDir: trace.runDir,
  });

  const finish = async (result: ReplayResult): Promise<ReplayResult> => {
    await trace.result(result);
    return result;
  };

  const fail = async (
    step: Step,
    code: FailureCode,
    expected: string,
    observed: string,
    message: string,
    matchInfo?: { descriptor: SemanticDescriptor; bestScore: number; runnerUp: number | null },
    snapshotForEvidence?: UISnapshot,
  ): Promise<ReplayResult> => {
    const snapshot = snapshotForEvidence ?? (await surface.observe());
    const shot = await surface.capture();
    // Screenshots aside (a harder, separate problem - see REPORT.md §6), the
    // node snapshot itself must never carry a sensitive field's live value
    // into evidence, same as discovery's model-facing text never does.
    await trace.failureEvidence(shot.bytes, redactSnapshot(snapshot, policy.redaction));
    return finish({
      status: "failed",
      ...common(),
      failure: { code, stepIndex: step.index, stepIntent: step.intent, expected, observed, message, ...(matchInfo ? { match: matchInfo } : {}) },
    });
  };

  /** Hands control to a human: persists a real, re-checkable Intervention -
   *  not just a message - and marks the lease human-owned. `resumable` is
   *  true because there is now a concrete `resumeCapability` call that will
   *  actually continue this run, not a promise deferred to a later phase. */
  const escalate = async (
    step: Step,
    reason: string,
    snapshot: UISnapshot,
    resumeAt: number,
    precondition?: { detect: Detector; expect: "matched" | "cleared" },
  ): Promise<ReplayResult> => {
    const interventionId = `${runId}-${step.index}`;
    const intervention: Intervention = {
      interventionId,
      runId,
      capabilityId: capability.id,
      capabilityVersion: capability.version,
      createdAt: new Date().toISOString(),
      reason,
      observedLocation: snapshot.location,
      resumeAt,
      ...(precondition ? { precondition } : {}),
      recoveriesSoFar: recoveries,
      lease: acquire(lease, "human"),
      status: "open",
    };
    await writeIntervention(trace.runDir, intervention);
    await trace.event("handoff", step.index, { from: "automation", to: "human", interventionId, reason });
    return finish({ status: "escalated", ...common(), interventionId, reason, resumable: true });
  };

  for (let i = startAt; i < capability.steps.length; i++) {
    const step = capability.steps[i]!;
    let snapshot = await surface.observe();

    const fired = findFiredOutcome(capability.outcomes, snapshot);
    if (fired) {
      await trace.event("outcome", step.index, { name: fired.spec.name, class: fired.spec.class });
      if (fired.spec.class === "business_outcome") {
        return finish({ status: "business_outcome", ...common(), outcome: fired.spec.name, data: extractOutcomeData(fired.spec, snapshot) });
      }
      if (fired.spec.class === "hard_failure") {
        return fail(
          step,
          "OUTCOME_HARD_FAILURE",
          `none of the declared hard_failure outcomes ("${fired.spec.name}")`,
          fired.result.observed,
          fired.spec.description,
          undefined,
          snapshot,
        );
      }
      // recoverable - the schema guarantees a remedy exists whenever class is "recoverable".
      const remedy = fired.spec.remedy!;
      const outcome = await applyRemedy(fired.spec, remedy, surface, pollIntervalMs);
      if (outcome.kind === "escalate") {
        return escalate(step, outcome.reason, snapshot, step.index, { detect: fired.spec.detect, expect: "cleared" });
      }
      recoveries.push({ stepIndex: step.index, outcome: fired.spec.name, class: "recoverable", attempts: outcome.attempts, succeeded: outcome.kind === "recovered" });
      await trace.event("recovery", step.index, { outcome: fired.spec.name, ...outcome });
      if (outcome.kind === "exhausted") {
        return fail(step, "RECOVERY_EXHAUSTED", `"${fired.spec.name}" clears within its declared remedy`, fired.result.observed, `recoverable outcome "${fired.spec.name}" did not clear after ${outcome.attempts} attempt(s)`, undefined, outcome.snapshot);
      }
      snapshot = outcome.snapshot;
    }

    stepsAttempted = step.index + 1;

    let action: Action;
    let controlName: string | undefined;

    if (step.action.kind === "click" || step.action.kind === "fill" || step.action.kind === "select") {
      const result = match(step.action.target, snapshot);
      await trace.event("resolve", step.index, { status: result.status });
      if (result.status !== "unique") {
        const code: FailureCode = result.status === "ambiguous" ? "AMBIGUOUS_TARGET" : "TARGET_ABSENT";
        const bestScore = result.status === "absent" ? result.bestScore : (result.candidates[0]?.score ?? 0);
        return fail(
          step,
          code,
          `exactly one match for ${describeTarget(step.action.target)}`,
          result.status === "ambiguous"
            ? `${result.candidates.length} candidates within the deciding margin`
            : `no candidate reached the acceptance threshold (best ${bestScore.toFixed(3)})`,
          `could not resolve step ${step.index}'s target`,
          { descriptor: step.action.target, bestScore, runnerUp: null },
          snapshot,
        );
      }
      const node = snapshot.nodes.find((n) => n.ref === result.ref);
      controlName = node?.name || node?.label;
      try {
        action = concreteAction(step.action, result.ref, inputs);
      } catch (error) {
        return fail(step, "SURFACE_ERROR", "a resolvable input value", String(error), String(error), undefined, snapshot);
      }
    } else if (step.action.kind === "press") {
      action = { kind: "press", key: step.action.key };
    } else if (step.action.kind === "navigate") {
      action = { kind: "navigate", to: resolveValue(step.action.to, inputs) };
    } else {
      action = { kind: "wait", until: step.action.until, timeoutMs: step.action.timeoutMs };
    }

    const policyDecision = checkAction(action, snapshot.location, policy, controlName);
    await trace.event("policy", step.index, policyDecision);
    if (!policyDecision.allowed) {
      return fail(step, "POLICY_BLOCKED", "action allowed by policy", policyDecision.reason, policyDecision.reason, undefined, snapshot);
    }
    if (!attended) {
      const gate = unattendedGate(policyDecision.tier, policy);
      if (!gate.allowed) {
        if (gate.escalate) {
          // A human is expected to perform *this exact step* themselves,
          // since automation was refused it - resume continues at the next
          // one rather than retrying it, and the precondition is the step's
          // own checkpoint (its normal proof of having happened), when it
          // has one to check.
          return escalate(step, gate.reason, snapshot, step.index + 1, step.checkpoint ? { detect: step.checkpoint, expect: "matched" } : undefined);
        }
        return fail(step, "POLICY_BLOCKED", "action permitted unattended", gate.reason, gate.reason, undefined, snapshot);
      }
    }

    try {
      const result = await withStepTimeout(surface.act(action), step.timeoutMs);
      if (result === STEP_TIMED_OUT) {
        return fail(
          step,
          "STEP_TIMEOUT",
          `the action completes within ${step.timeoutMs}ms`,
          "the action call never returned",
          `step ${step.index}'s action did not complete within its ${step.timeoutMs}ms budget`,
          undefined,
          snapshot,
        );
      }
    } catch (error) {
      return fail(step, "SURFACE_ERROR", "action executes without throwing", String(error), String(error), undefined, snapshot);
    }
    await trace.event("action", step.index, { action: redactActionForTrace(action, step.action, capability, policy) });

    if (step.checkpoint) {
      const waited = await waitForDetector(step.checkpoint, surface, step.timeoutMs, pollIntervalMs);
      await trace.event("checkpoint", step.index, { held: waited.ok });
      if (!waited.ok) {
        return fail(
          step,
          "CHECKPOINT_FAILED",
          describeDetector(step.checkpoint),
          waited.result.observed,
          `step ${step.index}'s checkpoint did not hold within ${step.timeoutMs}ms`,
          undefined,
          waited.snapshot,
        );
      }
    }
  }

  const finalSnapshot = await surface.observe();
  const finalFired = findFiredOutcome(capability.outcomes, finalSnapshot);
  if (finalFired) {
    await trace.event("outcome", capability.steps.length, { name: finalFired.spec.name, class: finalFired.spec.class });
    if (finalFired.spec.class === "business_outcome") {
      return finish({ status: "business_outcome", ...common(), outcome: finalFired.spec.name, data: extractOutcomeData(finalFired.spec, finalSnapshot) });
    }
    if (finalFired.spec.class === "hard_failure") {
      const lastStep = capability.steps[capability.steps.length - 1]!;
      return fail(
        lastStep,
        "OUTCOME_HARD_FAILURE",
        `none of the declared hard_failure outcomes ("${finalFired.spec.name}")`,
        finalFired.result.observed,
        finalFired.spec.description,
        undefined,
        finalSnapshot,
      );
    }
    // A recoverable condition firing only once every step's own checkpoint
    // already held is unusual, but not impossible - report it the same way
    // a mid-run recoverable exhaustion would be reported, rather than
    // silently proceeding to extract outputs from a screen that just said
    // otherwise.
    const lastStep = capability.steps[capability.steps.length - 1]!;
    return fail(
      lastStep,
      "UNRECOGNISED_STATE",
      "the final screen matching no recoverable outcome",
      finalFired.result.observed,
      `recoverable outcome "${finalFired.spec.name}" was still firing after every step's own checkpoint held`,
      undefined,
      finalSnapshot,
    );
  }

  try {
    const outputs: Record<string, unknown> = {};
    for (const spec of capability.outputs) {
      outputs[spec.name] = coerceOutput(extractOutput(spec, finalSnapshot), spec.type);
    }
    return finish({ status: "success", ...common(), outputs });
  } catch (error) {
    const lastStep = capability.steps[capability.steps.length - 1]!;
    return fail(lastStep, "UNRECOGNISED_STATE", "every declared output re-extractable from the final screen", String(error), String(error), undefined, finalSnapshot);
  }
}

/**
 * The other half of a handoff: continues the **same** run against the
 * **same** live surface a human was just driving - `deps.surface` must be
 * the identical instance `replayCapability` escalated with, still open,
 * not a freshly launched one. REPORT.md §5's direction was explicit that
 * this matters: a resume that reopened the browser would be starting over
 * with extra steps, not actually resuming.
 *
 * Re-verifies the intervention's precondition against a fresh observation
 * before doing anything else - a human saying "I'm done" is not itself
 * evidence the blocking condition is actually gone, and proceeding on their
 * word alone is exactly the kind of guess this project's matcher and
 * checkpoints already refuse to make everywhere else.
 */
export async function resumeCapability(
  intervention: Intervention,
  capability: Capability,
  inputs: Readonly<Record<string, string>>,
  deps: ReplayDeps,
): Promise<ReplayResult> {
  const { surface, trace, policy } = deps;

  // The caller's `intervention` may be a snapshot read before this exact
  // handoff was already consumed - by a previous resume, or by a second,
  // concurrent caller holding the same in-memory copy. Trusting the status
  // field on the parameter alone would miss that race; the on-disk record
  // is the one source of truth, the same way a resume re-checks its
  // precondition against a fresh observation rather than trusting a
  // human's say-so. Refused before the surface is even observed, let alone
  // touched.
  const onDisk = await readIntervention(trace.runDir).catch(() => undefined);
  const stillOpen = onDisk !== undefined && onDisk.interventionId === intervention.interventionId && onDisk.status === "open";
  if (!stillOpen) {
    const observed =
      onDisk === undefined
        ? "no intervention record found on disk"
        : onDisk.interventionId !== intervention.interventionId
          ? `the current on-disk intervention is a different one ("${onDisk.interventionId}")`
          : `its on-disk status is "${onDisk.status}"`;
    const failure: ReplayResult = {
      status: "failed",
      runId: intervention.runId,
      capabilityId: capability.id,
      capabilityVersion: capability.version,
      startedAt: intervention.createdAt,
      finishedAt: new Date().toISOString(),
      stepsAttempted: intervention.resumeAt,
      recoveries: intervention.recoveriesSoFar,
      evidenceDir: trace.runDir,
      failure: {
        code: "INTERVENTION_CONSUMED",
        stepIndex: intervention.resumeAt,
        stepIntent: capability.steps[intervention.resumeAt]?.intent ?? "(resume point past the last step)",
        expected: `intervention "${intervention.interventionId}" to still be open`,
        observed,
        message: `resume was requested for intervention "${intervention.interventionId}", but it is no longer open - nothing was retried`,
      },
    };
    await trace.result(failure);
    return failure;
  }

  const snapshot = await surface.observe();

  if (intervention.precondition) {
    const result = evaluateDetector(intervention.precondition.detect, snapshot);
    const satisfied = intervention.precondition.expect === "matched" ? result.matched : !result.matched;
    if (!satisfied) {
      const shot = await surface.capture();
      await trace.failureEvidence(shot.bytes, redactSnapshot(snapshot, policy.redaction));
      const common: ReplayCommon = {
        runId: intervention.runId,
        capabilityId: capability.id,
        capabilityVersion: capability.version,
        startedAt: intervention.createdAt,
        finishedAt: new Date().toISOString(),
        stepsAttempted: intervention.resumeAt,
        recoveries: intervention.recoveriesSoFar,
        evidenceDir: trace.runDir,
      };
      const step = capability.steps[intervention.resumeAt];
      const failure: ReplayResult = {
        status: "failed",
        ...common,
        failure: {
          code: intervention.precondition.expect === "matched" ? "CHECKPOINT_FAILED" : "RECOVERY_EXHAUSTED",
          stepIndex: intervention.resumeAt,
          stepIntent: step?.intent ?? "(resume point past the last step)",
          expected:
            intervention.precondition.expect === "matched"
              ? "the step a human was asked to perform to now show its own checkpoint"
              : "the condition that triggered the handoff to have cleared",
          observed: result.observed,
          message: `resume was requested for intervention "${intervention.interventionId}", but its precondition still does not hold - nothing was retried`,
        },
      };
      await trace.result(failure);
      return failure;
    }
  }

  // Committed to continuing past this handoff now - mark it spent before
  // acting, not after, so a concurrent or crash-and-retry second resume
  // reads "resolved" rather than racing this same "open" record.
  await writeIntervention(trace.runDir, { ...intervention, status: "resolved" });
  await trace.event("handoff", intervention.resumeAt, { from: "human", to: "automation", interventionId: intervention.interventionId });

  return replayCapability(capability, inputs, {
    ...deps,
    startAt: intervention.resumeAt,
    initialRecoveries: intervention.recoveriesSoFar,
    lease: acquire(intervention.lease, "automation"),
  });
}
