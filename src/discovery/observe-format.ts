import { redactText, redactValue } from "./redact.js";
import type { RedactionPolicy } from "./redact.js";
import type { UINode, UISnapshot } from "../surface/types.js";

/**
 * Turning a snapshot into what the model actually reads.
 *
 * Three decisions here carry real weight for a small model on a CPU.
 *
 * The list is a flat, numbered index over interactive controls and the text
 * near them - never markup. A model that has to visually parse HTML spends
 * its limited attention on syntax instead of the task; a numbered list of
 * "[3] textbox, label: Member Number" is closer to what a screen reader would
 * say, and it is the same vocabulary the matcher scores against, so the index
 * the model picks maps directly onto a real descriptor.
 *
 * Only interactive controls and nearby text are listed, not every node the
 * collector found - the collector is exhaustive on purpose (Phase 4 needs
 * that), but showing all of it to the model would bury the six things that
 * matter under two hundred that don't.
 *
 * Diffing against the previous rendering is what keeps token cost down turn
 * over turn without a bigger model or a paid API making up the difference.
 * Most steps in this application change one section of one frame; sending the
 * unchanged remainder again is pure waste, in tokens and in the model's
 * attention.
 */

export interface FormattedObservation {
  text: string;
  /** Index in this listing -> the underlying node, so the loop can resolve
   *  the model's chosen index back to a real UINode without re-parsing text. */
  indexed: readonly UINode[];
}

const LISTABLE_ROLES = new Set<UINode["role"]>([
  "button", "link", "textbox", "checkbox", "radio", "combobox", "option",
  "tab", "text",
]);

/** Cap on how many lines of unchanged context to keep before eliding, so a
 *  screen with hundreds of static rows does not still blow the budget just
 *  because none of them changed. */
const MAX_UNCHANGED_LINES = 40;

function lineFor(node: UINode, index: number, policy: RedactionPolicy): string {
  const parts = [`[${index}]`, node.role];
  // Field-name-based redaction ("this label says Password, hide it") only
  // ever makes sense for a control's *value* - the label itself is a
  // caption, not a secret, and blanking it destroys the very text the model
  // needs to tell fields apart. A live run against this exact bug picked
  // "navigate" three times running on the sign-on screen because the
  // Password caption had been redacted into "[redacted:field]" and the
  // password textbox lost its label entirely - the model was reasoning over
  // a screen with a hole in it. name and label get pattern redaction only
  // (a stray SSN in ordinary text is still worth catching); value is the one
  // place the field-name check applies, using the control's own label as
  // the evidence for what kind of value it holds.
  const name = node.name ? redactText(node.name, policy) : "";
  const label = node.label ? redactText(node.label, policy) : "";
  const value = node.value ? redactValue(node.value, node.label ?? "", policy) : "";

  if (name) parts.push(`"${name}"`);
  if (label && label !== name) parts.push(`label:"${label}"`);
  if (value) parts.push(`value:"${value}"`);
  if (node.state.disabled) parts.push("(disabled)");
  if (node.frame.length > 0) parts.push(`in:${node.frame.join("/")}`);

  return parts.join(" ");
}

function candidateNodes(snapshot: UISnapshot): UINode[] {
  return snapshot.nodes.filter((n) => n.visible && LISTABLE_ROLES.has(n.role));
}

/** A stable per-node key for diffing across observations, since NodeRef is
 *  reassigned on every snapshot and must not be used for that. */
function keyOf(node: UINode): string {
  return `${node.frame.join("/")}|${node.role}|${node.ordinal}|${node.name}|${node.label ?? ""}`;
}

export function formatObservation(
  snapshot: UISnapshot,
  policy: RedactionPolicy,
  previous?: UISnapshot,
): FormattedObservation {
  const nodes = candidateNodes(snapshot);
  const previousKeys = previous ? new Set(candidateNodes(previous).map(keyOf)) : null;

  const lines: string[] = [`SCREEN: ${snapshot.title}`];
  let unchangedShown = 0;
  let unchangedElided = 0;

  nodes.forEach((node, i) => {
    const changed = previousKeys ? !previousKeys.has(keyOf(node)) : true;
    if (changed) {
      lines.push(lineFor(node, i, policy));
      return;
    }
    if (unchangedShown < MAX_UNCHANGED_LINES) {
      lines.push(lineFor(node, i, policy));
      unchangedShown++;
    } else {
      unchangedElided++;
    }
  });

  if (unchangedElided > 0) {
    lines.push(`... ${unchangedElided} unchanged element(s) omitted`);
  }

  return { text: lines.join("\n"), indexed: nodes };
}
