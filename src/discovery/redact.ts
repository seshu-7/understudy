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
    return policy.placeholder.replace("{name}", "field");
  }
  return redactText(value, policy);
}
