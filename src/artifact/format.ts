import type { Detector, SemanticDescriptor, TextMatch, ValueSource } from "./schema.js";

/**
 * Turning a descriptor/detector/value into the sentence a person - or a
 * failure report - reads. Shared between `render.ts` (a reviewer reading a
 * capability before approving it) and `src/replay/replay.ts` (a failure's
 * `expected` field, describing the very same target a checkpoint failed to
 * find). Two independent copies of "how do we say what a SemanticDescriptor
 * means" is exactly the kind of drift this project has already caught once
 * (see schema.ts's header) - one function, two callers.
 */

export function textMatchLabel(match: TextMatch | undefined): string {
  if (!match) return "";
  if (match.kind === "pattern") return `/${match.source}/${match.flags ?? ""}`;
  return match.value;
}

export function describeTarget(descriptor: SemanticDescriptor): string {
  const parts: string[] = [descriptor.role];
  const name = textMatchLabel(descriptor.name);
  const label = textMatchLabel(descriptor.label);
  if (name) parts.push(`named "${name}"`);
  if (label) parts.push(`labelled "${label}"`);
  if (!name && !label && descriptor.anchor) {
    parts.push(`after "${textMatchLabel(descriptor.anchor.node.name)}"`);
  }
  if (descriptor.within) parts.push(`within "${textMatchLabel(descriptor.within.name)}"`);
  if (descriptor.frame && descriptor.frame.length > 0) parts.push(`(frame: ${descriptor.frame.join("/")})`);
  if (!name && !label && descriptor.ordinal !== undefined) parts.push(`[position ${descriptor.ordinal}]`);
  return parts.join(" ");
}

export function describeValue(value: ValueSource): string {
  return value.kind === "param" ? `{${value.name}}` : JSON.stringify(value.value);
}

export function describeDetector(detector: Detector): string {
  switch (detector.kind) {
    case "node_present":
      return `screen shows ${describeTarget(detector.descriptor)}`;
    case "node_absent":
      return `screen does not show ${describeTarget(detector.descriptor)}`;
    case "text_matches":
      return `${describeTarget(detector.descriptor)} matches /${detector.pattern}/`;
    case "location_matches":
      return `location matches /${detector.pattern}/`;
  }
}
