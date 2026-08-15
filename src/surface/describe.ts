import { normalize } from "./text.js";
import type { SemanticDescriptor, TextMatch, UINode, UISnapshot } from "./types.js";

/**
 * The inverse of match.ts: given a node the discovery loop has decided to act
 * on, produce the descriptor that would durably re-resolve to it on replay.
 *
 * This is the seam between the model's choice and the artifact. The model
 * picks a node by looking at a numbered list; this function is what turns
 * that ephemeral choice into the same evidence bundle the matcher scores
 * against, so a recorded step and a replayed step speak one vocabulary.
 *
 * The rule that matters: prefer name and label when the node has them, and
 * fall back to an anchor only when it does not. Recording an anchor for a
 * control that already has a name would make the artifact more brittle than
 * the surface actually is — anchoring depends on a neighbour that can move,
 * a name does not.
 */

function normalizedMatch(value: string): TextMatch {
  return { kind: "normalized", value };
}

/** Nearest preceding node in the same frame with non-empty text — what a
 *  human would call "the field right after that label". Mirrors the anchor
 *  search match.ts scores against, so a descriptor built here is guaranteed
 *  scoreable, not merely plausible. */
function findAnchor(node: UINode, snapshot: UISnapshot): { role: UINode["role"]; name: string } | null {
  const frameKey = node.frame.join("/");
  const sameFrame = snapshot.nodes.filter((n) => n.frame.join("/") === frameKey);
  const index = sameFrame.findIndex((n) => n.ref === node.ref);
  if (index < 0) return null;

  for (let i = index - 1; i >= 0; i--) {
    const candidate = sameFrame[i];
    if (candidate && candidate.name.trim().length > 0) {
      return { role: candidate.role, name: candidate.name };
    }
  }
  return null;
}

export function describeNode(node: UINode, snapshot: UISnapshot): SemanticDescriptor {
  const descriptor: SemanticDescriptor = { role: node.role };

  if (node.name && normalize(node.name).length > 0) {
    descriptor.name = normalizedMatch(node.name);
  }
  if (node.label && normalize(node.label).length > 0) {
    descriptor.label = normalizedMatch(node.label);
  }

  const nearest = node.ancestry[0];
  if (nearest && nearest.name) {
    descriptor.within = { role: nearest.role, name: normalizedMatch(nearest.name) };
  }

  // Only reach for an anchor when there is nothing better - it is the
  // weakest independent signal and it is the one the target application
  // forces us to use for every plain textbox.
  if (!descriptor.name && !descriptor.label) {
    const anchor = findAnchor(node, snapshot);
    if (anchor) {
      descriptor.anchor = { direction: "after", node: { role: anchor.role, name: normalizedMatch(anchor.name) } };
    }
  }

  if (node.frame.length > 0) descriptor.frame = node.frame;
  descriptor.ordinal = node.ordinal;

  const observedText = node.name || node.label || node.value || "";
  descriptor.observedAs = observedText || node.bounds ? { text: observedText, ...(node.bounds ? { bounds: node.bounds } : {}) } : undefined;
  if (!descriptor.observedAs) delete descriptor.observedAs;

  return descriptor;
}
