/**
 * The perception and action boundary.
 *
 * Above this line the system reasons about a UI as roles, names and
 * relationships. Below it lives Playwright, or Windows UI Automation, or an
 * accessibility bridge. The design rests on that split holding: if the
 * discovery loop or the replay engine ever needs to know it is driving a
 * browser, the "this extends to desktop" claim in the write-up is fiction.
 *
 * `SurfaceKind`, `Role`, `TextMatch`, `FramePath`, `Rect`, `SemanticDescriptor`
 * and `WaitCondition` are re-exported from `../artifact/schema.ts` rather
 * than declared here. They used to be hand-written in this file, mirrored by
 * a second, independent hand-written copy inside the Zod artifact schema,
 * with a test asserting the two never drifted apart. Phase 4 tried to
 * compile a discovered step's descriptor directly into an artifact `Step`
 * and the type checker caught what the test could not: Zod infers
 * `frame: string[]`, this file declared `frame: readonly string[]`, and
 * TypeScript correctly refused to treat the two as the same type even though
 * every value either one could hold was identical. A parity test proves two
 * representations agree on today's shape; it cannot stop someone editing one
 * and not the other next month. One definition does.
 *
 * These are the types that get *persisted* — written into a capability and
 * read back off disk, possibly days or tenants later — which is exactly the
 * boundary Zod validation is for. `UINode`, `UISnapshot`, `Action` and the
 * rest below stay plain TypeScript: they describe live, ephemeral data our
 * own adapter just produced, and nothing here ever deserialises them from
 * disk.
 */
export type { SurfaceKind, Role, TextMatch, FramePath, Rect, SemanticDescriptor, WaitCondition } from "../artifact/schema.js";
import type { Role, SemanticDescriptor, SurfaceKind, FramePath, Rect, WaitCondition } from "../artifact/schema.js";

/** Address of a node *within one snapshot*. Never persist one: refs are
 *  assigned per observation and mean nothing on the next. Durable addressing
 *  is `SemanticDescriptor`. Branded so that persisting one is a type error. */
export type NodeRef = string & { readonly __nodeRef: unique symbol };

/** The only sanctioned way to mint a NodeRef. Keeping it to one place means
 *  the brand actually costs something to bypass. */
export function nodeRef(value: string): NodeRef {
  return value as NodeRef;
}

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
