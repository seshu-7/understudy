/**
 * The perception and action boundary.
 *
 * Above this line the system reasons about a UI as roles, names and
 * relationships. Below it lives Playwright, or Windows UI Automation, or an
 * accessibility bridge. The design rests on that split holding: if the
 * discovery loop or the replay engine ever needs to know it is driving a
 * browser, the "this extends to desktop" claim in the write-up is fiction.
 */

/** Which family of adapter produced a snapshot. Recorded on artifacts so a
 *  capability can refuse to replay against a surface it was never recorded on. */
export type SurfaceKind = "web" | "desktop";

/** Normalised control roles. Deliberately small — this is the vocabulary the
 *  model gets to reason in, and every adapter has to map onto it. ARIA, UIA
 *  and AX all collapse into these without much argument. */
export type Role =
  | "button"
  | "link"
  | "textbox"
  | "checkbox"
  | "radio"
  | "combobox"
  | "option"
  | "listitem"
  | "row"
  | "cell"
  | "heading"
  | "text"
  | "image"
  | "dialog"
  | "alert"
  | "table"
  | "form"
  | "region"
  | "tab"
  | "unknown";

/** Address of a node *within one snapshot*. Never persist one: refs are
 *  assigned per observation and mean nothing on the next. Durable addressing
 *  is `SemanticDescriptor`. Branded so that persisting one is a type error. */
export type NodeRef = string & { readonly __nodeRef: unique symbol };

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Path through nested frames — framesets are everywhere in the applications
 *  this targets. Empty means the top document. On desktop, the window chain. */
export type FramePath = readonly string[];

export interface NodeState {
  disabled: boolean;
  readonly: boolean;
  required: boolean;
  focused: boolean;
  checked?: boolean;
  expanded?: boolean;
  invalid?: boolean;
}

/** One rung of the containment chain, kept for match scoring. We record the
 *  nearest *meaningful* ancestors rather than a full path — legacy markup
 *  nests tables twelve deep and none of that nesting is stable. */
export interface Ancestor {
  role: Role;
  name: string;
}

export interface UINode {
  ref: NodeRef;
  role: Role;
  /** Accessible name, already normalised: collapsed whitespace, trimmed.
   *  The primary evidence a descriptor matches on. */
  name: string;
  value?: string;
  /** Text of the label annotating this control when it differs from `name`.
   *  Legacy forms label by adjacency far more often than by `for=`. */
  label?: string;
  state: NodeState;
  bounds?: Rect;
  frame: FramePath;
  ancestry: readonly Ancestor[];
  /** Index among siblings sharing this role inside the nearest named
   *  container. Tiebreaker of last resort, and the weakest evidence we keep. */
  ordinal: number;
  /** Whether the adapter believes this is actually perceivable. Explicit so
   *  the model is never shown something a human operator could not click. */
  visible: boolean;
}

export interface UISnapshot {
  snapshotId: string;
  takenAt: string;
  kind: SurfaceKind;
  /** URL for web; window title plus process for desktop. Policy checks this. */
  location: string;
  title: string;
  nodes: readonly UINode[];
  /** Content hash over the node list. Cheap answer to "did anything change?"
   *  without a diff, which the loop asks after every single action. */
  digest: string;
}

export type TextMatch =
  | { kind: "exact"; value: string }
  | { kind: "normalized"; value: string }
  | { kind: "contains"; value: string }
  | { kind: "pattern"; source: string; flags?: string };

/**
 * How a step names the control it wants, durably.
 *
 * This is not a selector. A selector is a single hypothesis that either hits
 * or misses; this is a bundle of independent evidence that every candidate
 * node gets scored against. Two things follow, and both are things the brief
 * asks for. A tenant that rebrands "Search" to "Find Member" degrades the
 * name score but the structural evidence still carries the match. And when
 * two candidates score alike, the matcher can say so and stop, rather than
 * silently taking the first hit and doing the wrong thing to a real account.
 */
export interface SemanticDescriptor {
  role: Role;
  name?: TextMatch;
  label?: TextMatch;
  /** Nearest landmark or section containing the control — the "Member Search"
   *  fieldset. Survives layout churn better than any path expression. */
  within?: { role: Role; name: TextMatch };
  /** "the textbox immediately following the label 'Member ID'". The anchor is
   *  what makes unlabelled legacy inputs addressable at all. */
  anchor?: {
    direction: "after" | "before";
    node: { role: Role; name: TextMatch };
  };
  frame?: FramePath;
  ordinal?: number;
  /** What the model actually saw when this was recorded. Kept so a human
   *  reviewing the artifact has something concrete to read, and so replay
   *  failures can report "expected this, observed that". */
  observedAs?: { text: string; bounds?: Rect };
}

/** Per-signal contribution to a match score. Surfaced in failures so a
 *  human can see *why* the matcher decided what it decided. */
export interface MatchEvidence {
  role: number;
  name: number;
  label: number;
  within: number;
  anchor: number;
  ordinal: number;
}

/** Why the matcher chose, or refused to choose, a node.
 *
 *  `ambiguous` is a first-class outcome rather than an error case. "Two
 *  candidates scored 0.91 and 0.90" is a debuggable message; "element not
 *  found" is not, and "picked the first one" is how automation posts a
 *  transaction to the wrong account. */
export type MatchResult =
  | {
      status: "unique";
      ref: NodeRef;
      score: number;
      runnerUp: number | null;
      evidence: MatchEvidence;
    }
  | { status: "ambiguous"; candidates: readonly { ref: NodeRef; score: number }[] }
  | { status: "absent"; bestScore: number };

export type WaitCondition =
  | { kind: "settled" }
  | { kind: "node_present"; descriptor: SemanticDescriptor }
  | { kind: "node_absent"; descriptor: SemanticDescriptor }
  | { kind: "location_matches"; pattern: string };

/**
 * The action vocabulary.
 *
 * Deliberately tiny: every action here has a plausible implementation on a
 * browser, on Win32 UI Automation, and on a bare screenshot-plus-coordinates
 * surface. Anything that could only ever work in a browser — evaluate script,
 * set a cookie, read the DOM — is excluded on purpose, because admitting one
 * of them is how the abstraction quietly becomes browser-only.
 *
 * Note what is missing: there is no `read`. Extraction is a projection over a
 * snapshot, not something you do *to* a surface.
 */
export type Action =
  | { kind: "click"; target: NodeRef }
  | { kind: "fill"; target: NodeRef; text: string }
  | { kind: "select"; target: NodeRef; option: string }
  | { kind: "press"; key: string }
  | { kind: "navigate"; to: string }
  | { kind: "wait"; until: WaitCondition; timeoutMs: number };

export interface CapturedEvidence {
  kind: "screenshot" | "dom" | "tree";
  mediaType: string;
  bytes: Uint8Array;
}

export interface Surface {
  readonly kind: SurfaceKind;
  observe(): Promise<UISnapshot>;
  /** Mechanical failures — the click did not land, the frame detached —
   *  throw. Resolving *which* node happens earlier, in the matcher; by the
   *  time this is called that question is already settled. */
  act(action: Action): Promise<void>;
  capture(): Promise<CapturedEvidence>;
  close(): Promise<void>;
}
