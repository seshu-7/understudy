import { match } from "../surface/match.js";
import type { Detector, OutputSpec } from "../artifact/schema.js";
import type { UISnapshot } from "../surface/types.js";

/**
 * Evaluating the declarative vocabulary a capability is built from -
 * checkpoints and outcome detectors are both a `Detector`, checked against a
 * live snapshot with no model anywhere near the decision. `node_present` and
 * `node_absent` reuse the exact same scored matcher a step's own target
 * resolution uses, on purpose: a checkpoint is not a second, looser kind of
 * "does this exist" check, it is the identical question asked about a
 * different node.
 */

export interface DetectorResult {
  matched: boolean;
  /** What a FailureDetail's `observed` field should say when this detector
   *  did not hold - built here, once, rather than re-derived at every call
   *  site that reports a checkpoint failure. */
  observed: string;
}

function compileRegex(pattern: string): RegExp {
  try {
    // Case-insensitive unconditionally, matching the established convention
    // in discovery/policy.ts - a pattern author should never have to encode
    // that correctly themselves, and the inline (?i) PCRE syntax throws in
    // JS RegExp rather than doing nothing, which is worse.
    return new RegExp(pattern, "i");
  } catch (error) {
    throw new Error(`detector has an invalid pattern "${pattern}": ${String(error)}`);
  }
}

export function evaluateDetector(detector: Detector, snapshot: UISnapshot): DetectorResult {
  switch (detector.kind) {
    case "node_present": {
      const result = match(detector.descriptor, snapshot);
      return { matched: result.status === "unique", observed: `target resolution: ${result.status}` };
    }
    case "node_absent": {
      const result = match(detector.descriptor, snapshot);
      return { matched: result.status === "absent", observed: `target resolution: ${result.status}` };
    }
    case "text_matches": {
      const result = match(detector.descriptor, snapshot);
      if (result.status !== "unique") {
        return { matched: false, observed: `target resolution: ${result.status} (cannot test pattern against a node that was not uniquely resolved)` };
      }
      const node = snapshot.nodes.find((n) => n.ref === result.ref);
      const text = node?.name || node?.label || node?.value || "";
      return { matched: compileRegex(detector.pattern).test(text), observed: `text was "${text}"` };
    }
    case "location_matches":
      return {
        matched: compileRegex(detector.pattern).test(snapshot.location),
        observed: `location was "${snapshot.location}"`,
      };
  }
}

/** Reads the value an OutputSpec points at off a live snapshot. Throws
 *  rather than returning an empty string on a miss - a replay that cannot
 *  find its own declared output is a resolution failure the caller needs to
 *  see, not a silently empty field in the result. */
export function extractOutput(spec: OutputSpec, snapshot: UISnapshot): string {
  const result = match(spec.extract.descriptor, snapshot);
  if (result.status !== "unique") {
    throw new Error(`output "${spec.name}" could not be re-extracted: target resolution ${result.status}`);
  }
  const node = snapshot.nodes.find((n) => n.ref === result.ref);
  if (!node) throw new Error(`output "${spec.name}": matched node ref is not in the snapshot it came from`);
  switch (spec.extract.from) {
    case "text":
      return node.name || node.label || node.value || "";
    case "value":
      return node.value ?? "";
    case "name":
      return node.name;
  }
}

export function coerceOutput(raw: string, type: OutputSpec["type"]): unknown {
  switch (type) {
    case "number": {
      const n = Number(raw.replace(/,/g, ""));
      return Number.isNaN(n) ? raw : n;
    }
    case "boolean":
      return raw.trim().toLowerCase() === "true";
    case "string":
    case "date":
      return raw;
  }
}
