import { describeNode } from "../surface/describe.js";
import { formatObservation } from "./observe-format.js";
import { checkAction, unattendedGate, type Policy } from "./policy.js";
import { CostCeilingExceededError, CostGovernor } from "./cost.js";
import { groundOutputs, type OutputGrounding } from "./ground.js";
import { fieldIsSensitiveByName, redactText, type RedactionPolicy } from "./redact.js";
import { TraceWriter } from "./trace.js";
import type { Planner, PlannerDecision } from "./planner.js";
import type { DiscoveredStep, DiscoveryGoal, DiscoveryOutcome, StopReason } from "./types.js";
import type { Action, SemanticDescriptor, Surface, UINode, UISnapshot } from "../surface/types.js";

/**
 * Observe -> decide -> policy gate -> act -> record.
 *
 * The model is never trusted with more than one decision at a time, and every
 * decision is checked against policy before it touches the live surface -
 * discovery is not an exemption from the guardrails, it is the context they
 * matter most in, because this is a model exploring a real back-office
 * application with no idea yet what is safe.
 */

export interface DiscoveryLoopOptions {
  maxSteps?: number;
  timeoutMs?: number;
  /** Identical decisions in a row before the run is declared a dead end
   *  rather than left to loop until it hits max_steps. */
  stuckThreshold?: number;
}

export interface RunDiscoveryDeps {
  runId: string;
  surface: Surface;
  planner: Planner;
  policy: Policy;
  costGovernor: CostGovernor;
  trace: TraceWriter;
  options?: DiscoveryLoopOptions;
}

interface Resolved {
  action: Action | null;
  descriptor: SemanticDescriptor | null;
  targetName?: string;
}

function resolveAction(decision: PlannerDecision, indexed: readonly UINode[], snapshot: UISnapshot): Resolved {
  const nodeAt = (i: number | undefined): UINode | undefined => (i === undefined ? undefined : indexed[i]);

  switch (decision.action) {
    case "click": {
      const node = nodeAt(decision.index);
      if (!node) return { action: null, descriptor: null };
      return {
        action: { kind: "click", target: node.ref },
        descriptor: describeNode(node, snapshot),
        targetName: node.name || node.label,
      };
    }
    case "fill": {
      const node = nodeAt(decision.index);
      if (!node || decision.text === undefined) return { action: null, descriptor: null };
      return {
        action: { kind: "fill", target: node.ref, text: decision.text },
        descriptor: describeNode(node, snapshot),
        targetName: node.name || node.label,
      };
    }
    case "select": {
      const node = nodeAt(decision.index);
      if (!node || decision.option === undefined) return { action: null, descriptor: null };
      return {
        action: { kind: "select", target: node.ref, option: decision.option },
        descriptor: describeNode(node, snapshot),
        targetName: node.name || node.label,
      };
    }
    case "press":
      return decision.key
        ? { action: { kind: "press", key: decision.key }, descriptor: null }
        : { action: null, descriptor: null };
    case "navigate":
      return decision.url
        ? { action: { kind: "navigate", to: decision.url }, descriptor: null }
        : { action: null, descriptor: null };
    case "wait":
      return { action: { kind: "wait", until: { kind: "settled" }, timeoutMs: 5_000 }, descriptor: null };
    default:
      return { action: null, descriptor: null };
  }
}

function decisionKeyOf(decision: PlannerDecision): string {
  return JSON.stringify({ a: decision.action, i: decision.index, t: decision.text, o: decision.option, u: decision.url });
}

/** A fill/select decision counts as sensitive when the control it targets is
 *  labelled the way the redaction policy already treats a value as
 *  sensitive regardless of pattern (password, PIN, SSN, ...) - checked
 *  against the observation's own indexed node list, before resolution, so
 *  the decision trace event can be redacted at the same moment the model's
 *  choice is first recorded, not only after the action executes. */
function isSensitiveDecision(decision: PlannerDecision, indexed: readonly UINode[], policy: RedactionPolicy): boolean {
  if (decision.action !== "fill" && decision.action !== "select") return false;
  const node = decision.index !== undefined ? indexed[decision.index] : undefined;
  return fieldIsSensitiveByName(node?.label ?? node?.name ?? "", policy);
}

function redactedPlaceholder(policy: RedactionPolicy): string {
  return policy.placeholder.replace("{name}", "field");
}

/** The model's own free-text `intent` narration routinely repeats the raw
 *  value it just typed or selected (e.g. "Type the password X into the
 *  Password field") - intent is natural-language prose, not a value with a
 *  known shape, so a pattern rule alone can't be trusted to catch it. Strip
 *  the exact raw value out first (the one thing known for certain to be the
 *  secret), then run the normal pattern redaction over what's left in case
 *  anything else slipped in. */
function redactIntent(decision: PlannerDecision, policy: RedactionPolicy): string {
  const placeholder = redactedPlaceholder(policy);
  const rawValue = decision.text || decision.option;
  const scrubbed = rawValue ? decision.intent.split(rawValue).join(placeholder) : decision.intent;
  return redactText(scrubbed, policy);
}

function redactDecisionForTrace(decision: PlannerDecision, policy: RedactionPolicy): PlannerDecision {
  const placeholder = redactedPlaceholder(policy);
  return {
    ...decision,
    ...(decision.text !== undefined ? { text: placeholder } : {}),
    ...(decision.option !== undefined ? { option: placeholder } : {}),
    intent: redactIntent(decision, policy),
  };
}

function redactActionForStorage(action: Action, policy: RedactionPolicy): Action {
  const placeholder = redactedPlaceholder(policy);
  if (action.kind === "fill") return { ...action, text: placeholder };
  if (action.kind === "select") return { ...action, option: placeholder };
  return action;
}

export async function runDiscovery(goal: DiscoveryGoal, deps: RunDiscoveryDeps): Promise<DiscoveryOutcome> {
  const { runId, surface, planner, policy, costGovernor, trace, options = {} } = deps;
  const maxSteps = options.maxSteps ?? 20;
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const stuckThreshold = options.stuckThreshold ?? 3;

  const startedAt = new Date().toISOString();
  const deadline = Date.now() + timeoutMs;

  await trace.init();

  const steps: DiscoveredStep[] = [];
  const outputs: Record<string, string> = {};
  const outputGroundings: OutputGrounding[] = [];
  const historyLines: string[] = [];
  let stopReason: StopReason = "max_steps";
  let promptTokens = 0;
  let completionTokens = 0;
  let previousSnapshot: UISnapshot | undefined;
  let lastDecisionKey = "";
  let repeatCount = 0;

  for (let index = 0; index < maxSteps; index++) {
    if (Date.now() > deadline) {
      stopReason = "timeout";
      await trace.event("stop", index, { reason: stopReason });
      break;
    }

    const snapshot = await surface.observe();
    const observation = formatObservation(snapshot, policy.redaction, previousSnapshot);
    await trace.event("observation", index, {
      location: snapshot.location,
      digest: snapshot.digest,
      text: observation.text,
    });

    let plannerResult;
    try {
      plannerResult = await planner.decide({
        goal: goal.text,
        observationText: observation.text,
        history: historyLines.join("\n") || "(start of run)",
      });
    } catch (error) {
      await trace.event("stop", index, { reason: "planner_error", error: String(error) });
      stopReason = "planner_error";
      break;
    }

    promptTokens += plannerResult.usage.promptTokens;
    completionTokens += plannerResult.usage.completionTokens;
    try {
      costGovernor.charge(planner.provider, planner.model, plannerResult.usage.promptTokens, plannerResult.usage.completionTokens);
    } catch (error) {
      if (!(error instanceof CostCeilingExceededError)) throw error;
      await trace.event("stop", index, { reason: "cost_ceiling", error: error.message });
      stopReason = "cost_ceiling";
      break;
    }

    const decision = plannerResult.decision;
    const sensitive = isSensitiveDecision(decision, observation.indexed, policy.redaction);
    await trace.event("decision", index, sensitive ? redactDecisionForTrace(decision, policy.redaction) : decision);

    const key = decisionKeyOf(decision);
    repeatCount = key === lastDecisionKey ? repeatCount + 1 : 1;
    lastDecisionKey = key;
    if (repeatCount >= stuckThreshold) {
      await trace.event("stop", index, { reason: "dead_end", detail: `the same decision repeated ${repeatCount} times in a row` });
      stopReason = "dead_end";
      break;
    }

    if (decision.action === "finish") {
      const rawOutputs = decision.outputs ?? {};
      Object.assign(outputs, rawOutputs);
      const groundings = groundOutputs(rawOutputs, snapshot);
      outputGroundings.push(...groundings);
      await trace.event("grounding", index, groundings);
      historyLines.push(`${index}. finished: ${decision.intent}`);
      stopReason = "goal_met";
      break;
    }
    if (decision.action === "give_up") {
      await trace.event("stop", index, { reason: "give_up", detail: decision.reason });
      historyLines.push(`${index}. gave up: ${decision.reason ?? "(no reason given)"}`);
      stopReason = "dead_end";
      break;
    }

    const resolved = resolveAction(decision, observation.indexed, snapshot);
    if (!resolved.action) {
      historyLines.push(`${index}. the decision referenced a control that does not exist on this screen and was skipped`);
      previousSnapshot = snapshot;
      continue;
    }

    const policyDecision = checkAction(resolved.action, snapshot.location, policy, resolved.targetName);
    await trace.event("policy", index, policyDecision);
    if (!policyDecision.allowed) {
      const shot = await surface.capture();
      await trace.screenshot(index, shot.bytes);
      await trace.event("stop", index, { reason: "policy_blocked", detail: policyDecision.reason });
      stopReason = "policy_blocked";
      break;
    }

    // A model exploring live has no human confirming each individual click
    // any more than an unattended replay run does - discovery gets the same
    // risk-tier gate replay applies, not just the allowlist. There is
    // nowhere in discovery to escalate to (no lease/intervention handoff
    // exists until a capability is compiled), so a tier the policy would
    // otherwise escalate is treated as a hard stop here instead.
    const tierGate = unattendedGate(policyDecision.tier, policy);
    if (!tierGate.allowed) {
      const shot = await surface.capture();
      await trace.screenshot(index, shot.bytes);
      await trace.event("stop", index, { reason: "policy_blocked", detail: tierGate.reason });
      stopReason = "policy_blocked";
      break;
    }

    try {
      // Always the real, unredacted action - the live surface has to receive
      // the actual value typed to work at all. Only what gets traced and
      // stored below is ever redacted.
      await surface.act(resolved.action);
    } catch (error) {
      historyLines.push(`${index}. that action failed to execute (${String(error)}) - try a different approach`);
      const shot = await surface.capture();
      await trace.screenshot(index, shot.bytes);
      previousSnapshot = snapshot;
      continue;
    }

    const shot = await surface.capture();
    await trace.screenshot(index, shot.bytes);
    const storedAction = sensitive ? redactActionForStorage(resolved.action, policy.redaction) : resolved.action;
    const storedIntent = sensitive ? redactIntent(decision, policy.redaction) : decision.intent;
    await trace.event("action", index, { action: storedAction, intent: storedIntent });

    steps.push({ index, intent: storedIntent, action: storedAction, descriptor: resolved.descriptor, sensitive, confirmed: false });
    historyLines.push(`${index}. ${storedIntent}`);
    previousSnapshot = snapshot;
  }

  const outcome: DiscoveryOutcome = {
    goalId: goal.goalId,
    goal,
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    stopReason,
    steps,
    extractedOutputs: outputs,
    outputGroundings,
    tokenUsage: { promptTokens, completionTokens, estimatedUsd: costGovernor.totalUsd },
    provider: { name: planner.provider, model: planner.model },
  };

  await trace.summary(outcome);
  return outcome;
}
