import type { Action, SemanticDescriptor } from "../surface/types.js";
import type { OutputGrounding } from "./ground.js";

/**
 * The discovery loop's own vocabulary.
 *
 * Everything here is trace and evidence material. None of it is the artifact
 * - the compiler in Phase 4 reads a DiscoveryTrace and produces a Capability,
 * and deliberately does not carry provenance further than a run id and a
 * count of pruned steps. This file is the boundary between "what happened"
 * and "what we kept".
 */

export interface DiscoveryGoal {
  goalId: string;
  text: string;
  target: { entryPoint: string; tenant: string; app: string };
}

/**
 * Why the loop stopped. `goal_met` is the only success case; everything else
 * is worth distinguishing in evidence because each implies a different next
 * step for whoever is reading the run - retry, rewrite the prompt, or accept
 * that this goal needs a human.
 */
export type StopReason =
  | "goal_met"
  | "max_steps"
  | "timeout"
  | "dead_end"
  | "policy_blocked"
  | "cost_ceiling"
  | "planner_error";

/** One decided-and-executed step, in the shape the compiler will read. */
export interface DiscoveredStep {
  index: number;
  intent: string;
  action: Action;
  /** null only for actions with no single target - press, navigate, wait. */
  descriptor: SemanticDescriptor | null;
  /** Set once the action has executed and the next observation confirms the
   *  screen changed the way the model expected. Absent means unconfirmed, not
   *  failed - the loop does not retry inside discovery. */
  confirmed: boolean;
}

export interface DiscoveryOutcome {
  goalId: string;
  runId: string;
  startedAt: string;
  finishedAt: string;
  stopReason: StopReason;
  steps: readonly DiscoveredStep[];
  extractedOutputs: Record<string, string>;
  /** Each output in extractedOutputs, traced back to the node it actually
   *  came from - or to nothing, when that trace failed. See ground.ts. */
  outputGroundings: readonly OutputGrounding[];
  tokenUsage: { promptTokens: number; completionTokens: number; estimatedUsd: number };
  provider: { name: string; model: string };
}
