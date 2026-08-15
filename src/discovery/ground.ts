import { describeNode } from "../surface/describe.js";
import type { SemanticDescriptor, UISnapshot } from "../surface/types.js";

/**
 * Grounding a `finish` decision's claimed outputs against the real surface.
 *
 * The model reports outputs as plain strings - `{"savings_balance":
 * "4,182.55"}` - with no reference to where on screen it read that value. If
 * the compiler is going to turn that into an `OutputSpec` a replay can
 * re-extract on every future invocation, it needs a `SemanticDescriptor`
 * pointing at the node the value actually came from, not the string alone.
 *
 * This has to happen here, at discovery time, while the snapshot the finish
 * decision was reasoning over is still in scope - the compiler runs later,
 * offline, over a trace file that was never going to carry full node data
 * without bloating every evidence directory. It also doubles as a sanity
 * check on the model's own claim: if the reported value cannot be found
 * verbatim anywhere in what was actually on screen, that is worth knowing
 * before it becomes a capability, not after.
 */

export interface OutputGrounding {
  name: string;
  value: string;
  /** Null when the value could not be traced to exactly one node - either it
   *  does not appear on screen at all (the model may have summarised or
   *  misremembered it), or it appears in more than one place and which one
   *  it meant is genuinely ambiguous. Either way, guessing would make the
   *  compiled artifact more confident than the evidence supports. */
  descriptor: SemanticDescriptor | null;
}

export function groundOutputs(
  outputs: Readonly<Record<string, string>>,
  snapshot: UISnapshot,
): OutputGrounding[] {
  return Object.entries(outputs).map(([name, value]) => {
    const candidates = snapshot.nodes.filter(
      (n) => n.visible && (n.name === value || n.value === value || n.label === value),
    );
    const descriptor = candidates.length === 1 ? describeNode(candidates[0]!, snapshot) : null;
    return { name, value, descriptor };
  });
}
