import type { TextMatch } from "./types.js";

/**
 * Text comparison for control matching.
 *
 * The important property here is that comparison is *graded*, not boolean. A
 * selector either hits or misses; a descriptor signal returns a number, so a
 * tenant that renamed a button from "Search" to "Find Member" weakens one
 * signal instead of failing outright, and the structural signals decide.
 */

/** Collapse whitespace, trim, drop the punctuation legacy forms decorate
 *  labels with ("Member Number:", "Amount *"), and casefold. Deliberately
 *  conservative — it does not strip interior punctuation, because account
 *  numbers and reference codes are made of it. */
export function normalize(value: string): string {
  return value
    .replace(/[\s ]+/g, " ")
    .trim()
    .replace(/[:*….]+$/, "")
    .trim()
    .toLowerCase();
}

function bigrams(value: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < value.length - 1; i++) {
    const pair = value.slice(i, i + 2);
    out.set(pair, (out.get(pair) ?? 0) + 1);
  }
  return out;
}

/**
 * Sørensen–Dice over character bigrams, in [0, 1].
 *
 * Chosen over edit distance because it is length-insensitive in the way that
 * matters here: "Member Number" against "Member No." scores well, while
 * "Search" against "Find Member" scores near zero. Both are correct. The
 * second case is the one worth being precise about — the name signal *should*
 * collapse there, and the match should survive on containment and anchoring
 * or not at all.
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;

  const left = bigrams(a);
  const right = bigrams(b);
  let shared = 0;
  for (const [pair, count] of left) {
    const other = right.get(pair);
    if (other !== undefined) shared += Math.min(count, other);
  }
  return (2 * shared) / (a.length - 1 + (b.length - 1));
}

/**
 * Below this, bigram overlap is coincidence rather than resemblance, and
 * counting it actively misleads: "search" and "clear" share `ea` and `ar` and
 * score 0.44 against each other despite being unrelated words. On a screen
 * where a rebranded button has to be told apart from the one beside it, that
 * spurious credit is enough to pick the wrong control. Sub-threshold
 * similarity is therefore floored to zero — a name either resembles the
 * recorded one or contributes nothing, and the structural signals decide.
 */
const RESEMBLANCE_FLOOR = 0.5;

function graded(want: string, got: string): number {
  const score = similarity(want, got);
  return score < RESEMBLANCE_FLOOR ? 0 : score;
}

/** Score an observed string against a descriptor's expectation, in [0, 1]. */
export function matchText(spec: TextMatch, actual: string): number {
  switch (spec.kind) {
    case "exact":
      return spec.value === actual ? 1 : 0;

    case "normalized": {
      const want = normalize(spec.value);
      const got = normalize(actual);
      return want === got ? 1 : graded(want, got);
    }

    case "contains": {
      const want = normalize(spec.value);
      const got = normalize(actual);
      if (want === "") return 0;
      // A partial credit rather than zero, so a label that gained a word still
      // contributes something instead of silently dropping out.
      return got.includes(want) ? 1 : graded(want, got) * 0.5;
    }

    case "pattern": {
      try {
        return new RegExp(spec.source, spec.flags).test(actual) ? 1 : 0;
      } catch {
        // A malformed pattern is a defect in the artifact, not a match.
        return 0;
      }
    }
  }
}
