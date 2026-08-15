import { matchText } from "./text.js";
import type {
  MatchEvidence,
  MatchResult,
  NodeRef,
  Role,
  SemanticDescriptor,
  UINode,
  UISnapshot,
} from "./types.js";

/**
 * Resolving a descriptor to a control.
 *
 * This is the load-bearing piece of the whole system, and it is deliberately a
 * pure function over a snapshot so it can be tested exhaustively without a
 * browser anywhere near it.
 *
 * The strategy is scored evidence rather than a selector chain. Every visible
 * node that passes the hard gates is scored on each signal the descriptor
 * actually specifies; the weights are renormalised over those signals, so a
 * descriptor carrying only a role and an anchor is not penalised for having no
 * name. A match is returned only when one candidate clears the acceptance
 * threshold *and* beats the runner-up by a margin.
 *
 * That last clause is the point. Two controls scoring 0.91 and 0.90 means the
 * descriptor does not actually identify one of them, and picking the higher is
 * how automation posts a transaction against the wrong account. We stop
 * instead, and say what we saw.
 */

export interface MatchConfig {
  /** Minimum score to consider a control present at all. */
  accept: number;
  /** Required gap between the best and second-best candidate. */
  margin: number;
  weights: { name: number; label: number; within: number; anchor: number; ordinal: number };
}

export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  accept: 0.55,
  margin: 0.08,
  weights: { name: 0.35, label: 0.2, within: 0.2, anchor: 0.2, ordinal: 0.05 },
};

const NO_EVIDENCE: MatchEvidence = { role: 0, name: 0, label: 0, within: 0, anchor: 0, ordinal: 0 };

function framesEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((segment, i) => segment === b[i]);
}

function roleMatches(want: Role, got: Role): boolean {
  // `unknown` on either side is a wildcard: the adapter could not classify the
  // node, which should not by itself disqualify an otherwise strong match.
  return want === got || want === "unknown" || got === "unknown";
}

/** Best score over the ancestry chain for the descriptor's containment hint. */
function scoreWithin(descriptor: SemanticDescriptor, node: UINode): number {
  const within = descriptor.within;
  if (!within) return 0;
  let best = 0;
  for (const ancestor of node.ancestry) {
    if (!roleMatches(within.role, ancestor.role)) continue;
    best = Math.max(best, matchText(within.name, ancestor.name));
  }
  return best;
}

/**
 * Proximity to a named landmark in document order.
 *
 * This is what makes an unlabelled legacy input addressable: the Member Number
 * field has no accessible name, but it is the first textbox after the text
 * "Member Number". Score decays with the number of same-role controls sitting
 * between the anchor and the candidate, so "the first one after" beats "the
 * third one after" without either being excluded outright.
 */
function scoreAnchor(
  descriptor: SemanticDescriptor,
  nodes: readonly UINode[],
  candidateIndex: number,
): number {
  const anchor = descriptor.anchor;
  if (!anchor) return 0;

  const forward = anchor.direction === "after";
  let best = 0;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node) continue;
    if (!roleMatches(anchor.node.role, node.role)) continue;

    const nameScore = matchText(anchor.node.name, node.name);
    if (nameScore < 0.6) continue;
    if (forward ? candidateIndex <= i : candidateIndex >= i) continue;

    const lo = Math.min(i, candidateIndex);
    const hi = Math.max(i, candidateIndex);
    let between = 0;
    for (let k = lo + 1; k < hi; k++) {
      if (nodes[k]?.role === descriptor.role) between++;
    }
    best = Math.max(best, nameScore / (1 + between));
  }
  return best;
}

interface Scored {
  ref: NodeRef;
  score: number;
  evidence: MatchEvidence;
}

function scoreNode(
  descriptor: SemanticDescriptor,
  node: UINode,
  index: number,
  nodes: readonly UINode[],
  config: MatchConfig,
): Scored | null {
  // Hard gates. A node failing either is not a weaker candidate, it is a
  // different control.
  if (!roleMatches(descriptor.role, node.role)) return null;
  if (descriptor.frame && !framesEqual(descriptor.frame, node.frame)) return null;

  const evidence: MatchEvidence = { ...NO_EVIDENCE, role: 1 };
  let total = 0;
  let available = 0;

  if (descriptor.name) {
    evidence.name = matchText(descriptor.name, node.name);
    total += evidence.name * config.weights.name;
    available += config.weights.name;
  }
  if (descriptor.label) {
    evidence.label = matchText(descriptor.label, node.label ?? "");
    total += evidence.label * config.weights.label;
    available += config.weights.label;
  }
  if (descriptor.within) {
    evidence.within = scoreWithin(descriptor, node);
    total += evidence.within * config.weights.within;
    available += config.weights.within;
  }
  if (descriptor.anchor) {
    evidence.anchor = scoreAnchor(descriptor, nodes, index);
    total += evidence.anchor * config.weights.anchor;
    available += config.weights.anchor;
  }
  if (descriptor.ordinal !== undefined) {
    evidence.ordinal = descriptor.ordinal === node.ordinal ? 1 : 0;
    total += evidence.ordinal * config.weights.ordinal;
    available += config.weights.ordinal;
  }

  // A descriptor with nothing but a role identifies a class of controls, not a
  // control. Refusing to score it keeps that mistake loud rather than letting
  // it resolve to whichever button happens to come first.
  if (available === 0) return null;

  return { ref: node.ref, score: total / available, evidence };
}

export function match(
  descriptor: SemanticDescriptor,
  snapshot: UISnapshot,
  config: MatchConfig = DEFAULT_MATCH_CONFIG,
): MatchResult {
  // Only what a human operator could actually see and act on. Hidden inputs
  // carry state, not affordances.
  const nodes = snapshot.nodes.filter((n) => n.visible);

  const scored: Scored[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node) continue;
    const result = scoreNode(descriptor, node, i, nodes, config);
    if (result) scored.push(result);
  }

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < config.accept) {
    return { status: "absent", bestScore: best?.score ?? 0 };
  }

  const runnerUp = scored[1];
  if (runnerUp && best.score - runnerUp.score < config.margin) {
    return {
      status: "ambiguous",
      candidates: scored
        .filter((c) => best.score - c.score < config.margin)
        .map((c) => ({ ref: c.ref, score: c.score })),
    };
  }

  return {
    status: "unique",
    ref: best.ref,
    score: best.score,
    runnerUp: runnerUp?.score ?? null,
    evidence: best.evidence,
  };
}

/** Human-readable explanation, used verbatim in replay failure reports. */
export function explain(result: MatchResult): string {
  switch (result.status) {
    case "unique":
      return `matched at ${result.score.toFixed(3)}${
        result.runnerUp === null ? " (only candidate)" : `, runner-up ${result.runnerUp.toFixed(3)}`
      }`;
    case "ambiguous":
      return `${result.candidates.length} candidates within the deciding margin (${result.candidates
        .map((c) => c.score.toFixed(3))
        .join(", ")}) — the descriptor does not identify one control`;
    case "absent":
      return `no candidate reached the acceptance threshold (best ${result.bestScore.toFixed(3)})`;
  }
}
