import type { SemanticDescriptor, SurfaceKind, WaitCondition } from "../surface/types.js";

/**
 * The capability artifact — the thing this system exists to produce.
 *
 * Two framings shaped it. It is a *contract* an AI agent calls, so it needs
 * typed inputs, typed outputs and a declared set of things that can come back
 * — not a step list. And it is a *build output*, not a transcript: discovery
 * emits a raw trace, a separate compiler distils this from it. The model's
 * conversation is evidence of how we got here and lives in evidence/; nothing
 * in here points back into it.
 *
 * Phase 4 makes a Zod schema the source of truth and derives these types from
 * it, so one definition serves runtime validation, the published JSON Schema,
 * and the agent-facing tool contract. These interfaces are the design; if the
 * schema ends up disagreeing with them, that disagreement is a finding worth
 * writing down rather than quietly editing away.
 */

export type ApprovalState = "draft" | "approved" | "retired";

/** JSON-Schema-ish scalar vocabulary. Kept narrow deliberately: a calling
 *  agent has to be able to fill these in from natural language, and "string,
 *  number, boolean, date" is about as much as that reliably supports. */
export type ParamType = "string" | "number" | "boolean" | "date";

export interface ParamSpec {
  name: string;
  type: ParamType;
  description: string;
  required: boolean;
  /** Marks values that must never reach a log, an artifact or the model.
   *  Redaction is enforced at the perception boundary, not here — this flag
   *  is what tells it which values to look for. */
  sensitive?: boolean;
  example?: string;
}

export interface OutputSpec {
  name: string;
  type: ParamType;
  description: string;
  /** Where the value comes from: a projection over the final snapshot, not
   *  an action. The descriptor names the node; `from` picks the field. */
  extract: { descriptor: SemanticDescriptor; from: "text" | "value" | "name" };
}

/**
 * A predicate over an observation. Detectors are declarative on purpose: the
 * three-way classification the brief asks for is then a property of the
 * artifact a human can review, rather than behaviour buried in replay code.
 */
export type Detector =
  | { kind: "node_present"; descriptor: SemanticDescriptor }
  | { kind: "node_absent"; descriptor: SemanticDescriptor }
  | { kind: "text_matches"; descriptor: SemanticDescriptor; pattern: string }
  | { kind: "location_matches"; pattern: string };

/**
 * What a detector firing *means*. This is the distinction the glossary calls
 * the most common design mistake in this problem, so it is modelled
 * explicitly rather than left to a try/catch.
 *
 *  - `business_outcome`: a legitimate answer the caller asked for. "No such
 *    member" is not a crash; it is the result. Replay returns it as success.
 *  - `recoverable`: a known interruption with a *bounded* remedy. Bounded
 *    matters — an unbounded retry is how automation hammers a core banking
 *    system at 3am.
 *  - `hard_failure`: stop, capture evidence, surface something debuggable.
 */
export type OutcomeClass = "business_outcome" | "recoverable" | "hard_failure";

export type Remedy =
  | { kind: "dismiss"; descriptor: SemanticDescriptor }
  | { kind: "wait_retry"; attempts: number; backoffMs: number }
  | { kind: "reauthenticate" };

export interface OutcomeSpec {
  /** Stable machine name the calling agent branches on, e.g. `member_not_found`. */
  name: string;
  class: OutcomeClass;
  description: string;
  detect: Detector;
  /** Required when class is `recoverable`, meaningless otherwise. The Zod
   *  schema in Phase 4 enforces that with a discriminated union. */
  remedy?: Remedy;
  /** Fields to pull out when this outcome fires — a not-found result often
   *  still carries the message the operator needs to see. */
  data?: readonly OutputSpec[];
}

export interface Step {
  index: number;
  /** Human-readable intent. Written for the reviewer, and it is what shows up
   *  in a failure report, so it should read like something an operator did:
   *  "enter the member ID into the search field". */
  intent: string;
  action:
    | { kind: "click"; target: SemanticDescriptor }
    | { kind: "fill"; target: SemanticDescriptor; value: ValueSource }
    | { kind: "select"; target: SemanticDescriptor; value: ValueSource }
    | { kind: "press"; key: string }
    | { kind: "navigate"; to: ValueSource }
    | { kind: "wait"; until: WaitCondition; timeoutMs: number };
  /** Asserted after the action lands. A step without a checkpoint is a step
   *  that assumes its click worked, which is the failure mode the glossary
   *  names. The compiler infers one for every state-changing step. */
  checkpoint?: Detector;
  /** Risk tier, set by policy at compile time and re-checked at replay.
   *  `irreversible` never runs unattended. */
  risk: "safe" | "elevated" | "irreversible";
  timeoutMs: number;
}

/** Either a literal recorded during discovery, or a binding to a declared
 *  input parameter. Turning the first into the second is what makes a
 *  recording of "member 12345" into a capability that takes a member id. */
export type ValueSource =
  | { kind: "literal"; value: string }
  | { kind: "param"; name: string };

/**
 * What the capability was recorded against, and what it is willing to run
 * against. `app` identifies the vendor product; `tenant` identifies one
 * institution's instance of it. Keeping them separate is what makes one
 * artifact reusable across tenants running the same software, with a
 * per-tenant overlay applied on top rather than a fresh recording.
 */
export interface TargetBinding {
  app: string;
  appVersion?: string;
  tenant: string;
  surface: SurfaceKind;
  entryPoint: string;
}

/** How this artifact came to exist. Enough to audit it, and deliberately not
 *  enough to reconstruct the model conversation — that stays in evidence/. */
export interface Provenance {
  discoveryRunId: string;
  recordedAt: string;
  planner: { provider: string; model: string };
  /** Steps the compiler dropped as exploratory, and why. A reviewer should be
   *  able to see what was thrown away, not just what survived. */
  prunedSteps: number;
  humanEdited: boolean;
}

export interface Capability {
  schemaVersion: "1.0";
  id: string;
  name: string;
  description: string;
  /** Bumped whenever steps change. Callers may pin. */
  version: number;
  /** Hash over the semantic content — steps, params, outcomes — excluding
   *  provenance and approval. Two capabilities recorded independently that
   *  compile to the same program get the same hash, which is what makes the
   *  cross-model convergence check in evidence/ mean anything. */
  contentHash: string;
  approval: ApprovalState;
  target: TargetBinding;
  inputs: readonly ParamSpec[];
  outputs: readonly OutputSpec[];
  steps: readonly Step[];
  outcomes: readonly OutcomeSpec[];
  provenance: Provenance;
}
