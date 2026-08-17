import type { UINode, UISnapshot } from "../surface/types.js";

/**
 * Redaction at the perception boundary.
 *
 * This is the one place sensitive values are supposed to be stripped, and
 * everything downstream - the text sent to the planner, the trace written to
 * disk, the evidence committed to the repo - is built from what this module
 * returns, never from the raw snapshot. That is a deliberate single choke
 * point: redacting again at write time would mean two code paths have to
 * agree on what counts as sensitive, and the day they disagree is the day
 * something leaks.
 */

export interface RedactionRule {
  name: string;
  regex: RegExp;
}

export interface RedactionPolicy {
  patterns: readonly RedactionRule[];
  /** Lower-cased. A field whose label contains one of these is redacted
   *  regardless of what its value looks like - a password field is redacted
   *  even when its value happens to match no pattern. */
  fieldNames: readonly string[];
  placeholder: string;
}

export interface RawRedactionConfig {
  patterns: readonly { name: string; regex: string }[];
  fieldNames: readonly string[];
  placeholder: string;
}

export function loadRedactionPolicy(raw: RawRedactionConfig): RedactionPolicy {
  return {
    // Always global and case-insensitive. JS RegExp has no inline (?i) flag
    // syntax - writing a pattern the PCRE way throws at construction, which
    // is exactly what the "bearer" pattern in this project's own shipped
    // config did before this was fixed. Case-insensitivity is a property of
    // the matcher now, not something every pattern author has to remember.
    patterns: raw.patterns.map((p) => ({ name: p.name, regex: new RegExp(p.regex, "gi") })),
    fieldNames: raw.fieldNames.map((f) => f.toLowerCase()),
    placeholder: raw.placeholder,
  };
}

export function redactText(value: string, policy: RedactionPolicy): string {
  let out = value;
  for (const rule of policy.patterns) {
    out = out.replace(rule.regex, policy.placeholder.replace("{name}", rule.name));
  }
  return out;
}

/** The placeholder a field-name-based redaction produces - shared so
 *  discovery's trace redaction and replay's action redaction always agree on
 *  the exact text a redacted value becomes, rather than each formatting
 *  `policy.placeholder` the same way independently and risking the two
 *  drifting apart, the way `SemanticDescriptor` and `contentHash` once did
 *  in this project (REPORT.md §2, §4). */
export function fieldPlaceholder(policy: RedactionPolicy): string {
  return policy.placeholder.replace("{name}", "field");
}

export function fieldIsSensitiveByName(label: string, policy: RedactionPolicy): boolean {
  const normalized = label.toLowerCase();
  return policy.fieldNames.some((f) => normalized.includes(f));
}

/** Redact one field's value, given the label a human would read beside it.
 *  Label-based redaction runs first and short-circuits - a field named
 *  "Password" should never appear even partially, whether or not its
 *  contents happen to match a pattern. */
export function redactValue(value: string, label: string, policy: RedactionPolicy): string {
  if (!value) return value;
  if (fieldIsSensitiveByName(label, policy)) {
    return fieldPlaceholder(policy);
  }
  return redactText(value, policy);
}

/** Same asymmetry as observe-format.ts's `lineFor`, applied to a whole live
 *  snapshot instead of one rendered line: a node's `value` gets field-name
 *  redaction (a Password textbox's current contents must never appear,
 *  whether or not they happen to match a pattern), while `name`/`label` get
 *  pattern redaction only, since those are captions, not secrets, and
 *  blanking a field's own label is how a model already once lost the sign-on
 *  screen entirely (see REPORT.md §6). This exists for evidence that persists
 *  a *whole node*, not just formatted text for a planner - replay's failure
 *  snapshots, specifically - where nothing upstream has redacted anything
 *  yet, unlike the model-facing observation text discovery already builds
 *  through `redactValue`/`redactText` directly. */
export function redactSnapshot(snapshot: UISnapshot, policy: RedactionPolicy): UISnapshot {
  const redactNode = (node: UINode): UINode => ({
    ...node,
    name: redactText(node.name, policy),
    ...(node.label !== undefined ? { label: redactText(node.label, policy) } : {}),
    ...(node.value !== undefined ? { value: redactValue(node.value, node.label ?? node.name, policy) } : {}),
  });
  return { ...snapshot, nodes: snapshot.nodes.map(redactNode) };
}
