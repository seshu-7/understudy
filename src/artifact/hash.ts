import { createHash } from "node:crypto";
import type { Capability } from "./schema.js";

/**
 * Content-addressing a capability's semantic parts, shared between the
 * compiler and the tenant overlay (`overlay.ts`) - both produce a
 * `Capability` from something that isn't one, and both need the identical
 * notion of "what actually changed" rather than two independent hashes that
 * could quietly disagree.
 */

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Hashes only the semantic content - never provenance or approval, both of
 *  which describe how the artifact came to exist rather than what it does.
 *  Two capabilities that compile (or overlay) to the same program get the
 *  same hash; two that don't, don't - that equality is the actual check, not
 *  an eyeball comparison of two JSON files. */
export function contentHashOf(semantic: Pick<Capability, "target" | "inputs" | "outputs" | "steps" | "outcomes">): string {
  return createHash("sha256").update(stableStringify(semantic)).digest("hex").slice(0, 16);
}
