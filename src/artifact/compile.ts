import { createHash } from "node:crypto";

import { CapabilitySchema, type Capability, type OutputSpec, type ParamSpec, type Step, type ValueSource } from "./schema.js";
import type { DiscoveredStep, DiscoveryOutcome } from "../discovery/types.js";
import type { SemanticDescriptor, TextMatch } from "../surface/types.js";

/**
 * The trace compiler.
 *
 * Discovery emits a raw, ordered record of what one run did. This is what
 * turns that record into a *build output* — a typed, versioned capability an
 * agent can call with different data and get a correct answer back, not a
 * transcript of "what happened to member 100234 on 15 Aug 2026." Everything
 * here is deliberately conservative: where the evidence does not clearly
 * support a decision, the compiler throws rather than guesses, because a
 * capability that looks complete but silently dropped something the goal
 * asked for is worse than a compile that refuses to finish.
 *
 * Three things it actually does, each with a documented limit:
 *
 *  1. **Parameterisation.** A fill/select/navigate value gets bound to a
 *     named input parameter when it appears verbatim as a token in the
 *     original goal text - "100234" in the value and in "look up member
 *     100234..." is strong, checkable evidence it is caller-supplied data,
 *     not a fixed detail of the flow. A value with no such evidence stays a
 *     literal. This is a real limitation, not a placeholder: a value the
 *     model chose that happens not to appear in the goal's wording (e.g. an
 *     inferred placeholder password) will not be parameterised, and the
 *     write-up says so.
 *
 *  2. **Checkpoint inference.** For step N, the checkpoint is "step N+1's
 *     own target is present" - proof, from the discovery run itself, that
 *     the action actually advanced the flow. This is not a stand-in for
 *     something better; it is the *correct* choice for a reusable
 *     capability, not merely the cheapest one available. A checkpoint keyed
 *     on the literal text or digest of the resulting screen would be wrong
 *     on purpose here, because replay with different parameters is expected
 *     to reach a screen with different data on it - a structural
 *     "does this control exist" check is invariant to that, a value-based one
 *     is not. The last step, with no N+1 to borrow from, checkpoints against
 *     the descriptor of whatever it produced as an output instead - but with
 *     the same value-blindness enforced explicitly, since an output's own
 *     descriptor is frequently built from the very value it extracts (a
 *     "text" node's accessible name *is* its displayed content). See
 *     `structuralOnly` below: any `name`/`label` that literally equals the
 *     extracted value is dropped from the checkpoint, keeping only the
 *     structural evidence (role, container, frame, position) that stays true
 *     no matter what value the field holds on a given replay.
 *
 *  3. **Output binding.** Only grounded outputs (see discovery/ground.ts)
 *     compile — an output the model claimed but that could not be traced to
 *     exactly one real node fails the whole compile, loudly, rather than
 *     silently disappearing from the artifact.
 */

export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompileError";
  }
}

export interface CompileOptions {
  id?: string;
  name?: string;
  description?: string;
  /** Everything before Phase 6 defaults new artifacts to draft, requiring an
   *  explicit review step before unattended replay will touch them. */
  approval?: Capability["approval"];
}

interface ParamAccumulator {
  params: ParamSpec[];
  byValue: Map<string, string>;
  usedNames: Set<string>;
}

function textMatchLiteral(match: TextMatch | undefined): string | undefined {
  if (!match || match.kind === "pattern") return undefined;
  return match.value;
}

/** The most human-readable name available on a descriptor, used both to name
 *  inferred parameters and to substitute placeholders into the capability's
 *  own name/description/id. */
function descriptorLabel(descriptor: SemanticDescriptor): string | undefined {
  return (
    textMatchLiteral(descriptor.label) ?? textMatchLiteral(descriptor.name) ?? textMatchLiteral(descriptor.anchor?.node.name)
  );
}

function toSnakeCase(text: string): string {
  const snake = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return snake || "value";
}

function uniqueName(base: string, used: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base}_${suffix++}`;
  used.add(candidate);
  return candidate;
}

/** A value counts as caller-supplied data when it appears, verbatim, as its
 *  own token in the goal text - not merely as a substring, which would let
 *  "10" match inside "100234" and misparameterise something the goal never
 *  actually named. Below 3 characters a token match is coincidence more
 *  often than intent, so short values are never parameterised on this
 *  evidence alone. */
function goalMentions(goalText: string, value: string): boolean {
  if (value.trim().length < 3) return false;
  const tokens = goalText.match(/[A-Za-z0-9][A-Za-z0-9._-]*/g) ?? [];
  return tokens.some((t) => t === value || t.toLowerCase() === value.toLowerCase());
}

function valueSourceFor(raw: string, label: string | undefined, goalText: string, acc: ParamAccumulator): ValueSource {
  if (!goalMentions(goalText, raw)) return { kind: "literal", value: raw };

  const existing = acc.byValue.get(raw);
  if (existing) return { kind: "param", name: existing };

  const name = uniqueName(toSnakeCase(label ?? "value"), acc.usedNames);
  acc.byValue.set(raw, name);
  acc.params.push({
    name,
    type: "string",
    description: `"${label ?? "this field"}" - bound from the value discovery typed for this run.`,
    required: true,
    example: raw,
  });
  return { kind: "param", name };
}

/** The path for a step discovery already flagged sensitive - loop.ts has
 *  already redacted `step.action.text`/`.option` into an identical
 *  placeholder before this ever runs, so there is no real value left to
 *  dedupe on or to record as an `example`, and deliberately no attempt to:
 *  two different sensitive fields redacted to the same placeholder text
 *  must not collapse into one parameter just because their (fake) raw
 *  values happen to match. Unlike valueSourceFor, this never falls back to
 *  a literal - a credential is not "caller data that happened not to be
 *  mentioned in the goal," it must never be recorded in the artifact at
 *  all, mentioned or not. */
function sensitiveValueSourceFor(label: string | undefined, acc: ParamAccumulator): ValueSource {
  const name = uniqueName(toSnakeCase(label ?? "value"), acc.usedNames);
  acc.params.push({
    name,
    type: "string",
    description: `"${label ?? "this field"}" - a sensitive value. Never recorded; must be supplied at replay time.`,
    required: true,
    sensitive: true,
  });
  return { kind: "param", name };
}

/** Compiles one discovered step's action, given the *next* step for
 *  checkpoint inference (undefined for the last step - see compileCapability
 *  for how that case is handled instead). */
function compileStep(
  step: DiscoveredStep,
  next: DiscoveredStep | undefined,
  goalText: string,
  acc: ParamAccumulator,
): Step {
  if (!step.descriptor && step.action.kind !== "press" && step.action.kind !== "navigate" && step.action.kind !== "wait") {
    throw new CompileError(`step ${step.index} ("${step.intent}") has no descriptor and cannot be replayed by anything but a raw NodeRef - refusing to compile a step that would not survive its own recording session`);
  }

  let action: Step["action"];
  switch (step.action.kind) {
    case "click":
      action = { kind: "click", target: step.descriptor! };
      break;
    case "fill":
      action = {
        kind: "fill",
        target: step.descriptor!,
        value: step.sensitive
          ? sensitiveValueSourceFor(descriptorLabel(step.descriptor!), acc)
          : valueSourceFor(step.action.text, descriptorLabel(step.descriptor!), goalText, acc),
      };
      break;
    case "select":
      action = {
        kind: "select",
        target: step.descriptor!,
        value: step.sensitive
          ? sensitiveValueSourceFor(descriptorLabel(step.descriptor!), acc)
          : valueSourceFor(step.action.option, descriptorLabel(step.descriptor!), goalText, acc),
      };
      break;
    case "press":
      action = { kind: "press", key: step.action.key };
      break;
    case "navigate":
      action = { kind: "navigate", to: valueSourceFor(step.action.to, undefined, goalText, acc) };
      break;
    case "wait":
      action = { kind: "wait", until: step.action.until, timeoutMs: step.action.timeoutMs };
      break;
  }

  const checkpoint = next?.descriptor ? ({ kind: "node_present", descriptor: next.descriptor } as const) : undefined;

  return {
    index: step.index,
    intent: step.intent,
    action,
    ...(checkpoint ? { checkpoint } : {}),
    // Risk tiering belongs to policy (Phase 6), which re-derives it from the
    // live target at replay time regardless of what is recorded here - this
    // is a safe placeholder, never the value replay actually trusts.
    risk: "safe",
    timeoutMs: 10_000,
  };
}

/** Strips a `name`/`label` TextMatch when its literal equals the very value
 *  that was extracted from this node - e.g. a "text" role node's own
 *  accessible name *is* its displayed content, so an output descriptor built
 *  from one carries today's specific balance, not a stable identity. Using
 *  that descriptor as-is for a checkpoint would repeat the exact mistake the
 *  step-to-step checkpoints above were designed to avoid: proving "the
 *  screen still says 4,182.55" instead of "the screen reached the place
 *  where the balance is read from," which is the only claim that survives
 *  replay with a different member. What is left (role, within, frame,
 *  anchor, ordinal) is deliberately structural and never carries the
 *  extracted value itself, so it is safe to keep. */
function structuralOnly(descriptor: SemanticDescriptor, extractedValue: string): SemanticDescriptor {
  const strip = (match: TextMatch | undefined): TextMatch | undefined =>
    match && textMatchLiteral(match) === extractedValue ? undefined : match;
  return {
    ...descriptor,
    name: strip(descriptor.name),
    label: strip(descriptor.label),
  };
}

function buildOutputs(outcome: DiscoveryOutcome): OutputSpec[] {
  const specs: OutputSpec[] = [];
  for (const grounding of outcome.outputGroundings) {
    if (!grounding.descriptor) {
      throw new CompileError(
        `output "${grounding.name}" (claimed value "${grounding.value}") could not be traced to exactly one node on ` +
          `the final screen, so it cannot be compiled into a re-extractable output. Either the model's claim was wrong, ` +
          `or the value appears in more than one place and which node it meant is genuinely ambiguous - either way, ` +
          `silently dropping it would ship a capability missing the thing the goal asked for.`,
      );
    }
    specs.push({
      name: grounding.name,
      type: "string",
      description: `Read from the screen reached at the end of this capability.`,
      // Stripped the same way as the checkpoint fallback below, and for the
      // same reason - this descriptor is what replay re-resolves at extract
      // time, and a "text" node's own name is frequently its own displayed
      // content. Leaving it in would make extraction match on today's value
      // instead of finding wherever *that kind* of value lives on the
      // screen, which is the one thing that has to work for a member other
      // than the one this was recorded against.
      extract: { descriptor: structuralOnly(grounding.descriptor, grounding.value), from: "text" },
    });
  }
  return specs;
}

function placeholderText(goalText: string, acc: ParamAccumulator): string {
  // Longest values first, so a parameter whose value is a substring of a
  // longer one (unlikely here, but not impossible) does not get partially
  // clobbered by the shorter match running first.
  const entries = [...acc.byValue.entries()].sort((a, b) => b[0].length - a[0].length);
  let out = goalText;
  for (const [value, name] of entries) out = out.split(value).join(`{${name}}`);
  return out;
}

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
 *  Two capabilities recorded independently that compile to the same program
 *  get the same hash; that equality is what makes Phase 8's cross-model
 *  convergence check mean something instead of an eyeball comparison. */
function contentHashOf(semantic: Pick<Capability, "target" | "inputs" | "outputs" | "steps" | "outcomes">): string {
  return createHash("sha256").update(stableStringify(semantic)).digest("hex").slice(0, 16);
}

export function compileCapability(outcome: DiscoveryOutcome, options: CompileOptions = {}): Capability {
  if (outcome.stopReason !== "goal_met") {
    throw new CompileError(
      `cannot compile a run that did not succeed (stopReason: "${outcome.stopReason}") - there is no confirmed-working ` +
        `flow here to distil, only the record of an attempt`,
    );
  }
  if (outcome.steps.length === 0) {
    throw new CompileError("cannot compile a run with no steps - finish was called with nothing acted on first");
  }

  const acc: ParamAccumulator = { params: [], byValue: new Map(), usedNames: new Set() };

  const steps: Step[] = outcome.steps.map((step, i) =>
    compileStep(step, outcome.steps[i + 1], outcome.goal.text, acc),
  );

  const outputs = buildOutputs(outcome);

  // The last step has no "next step" to borrow a checkpoint from; if the run
  // produced at least one grounded output, checkpoint against the first of
  // them instead - proof the state that makes the output readable was
  // actually reached. A goal with no extraction step at all compiles with no
  // checkpoint on its last step, honestly, rather than a fabricated one.
  // outputs[0].extract.descriptor is already stripped of its own value by
  // buildOutputs above, so it is safe to reuse directly as a checkpoint.
  const lastIndex = steps.length - 1;
  if (!steps[lastIndex]!.checkpoint && outputs[0]) {
    steps[lastIndex] = { ...steps[lastIndex]!, checkpoint: { kind: "node_present", descriptor: outputs[0].extract.descriptor } };
  }

  const description = options.description ?? placeholderText(outcome.goal.text, acc);
  const name = options.name ?? description.charAt(0).toUpperCase() + description.slice(1);
  const id = options.id ?? `${toSnakeCase(outcome.goal.target.app)}.${toSnakeCase(description).slice(0, 60)}`;

  const semantic = {
    target: {
      app: outcome.goal.target.app,
      tenant: outcome.goal.target.tenant,
      surface: "web" as const,
      entryPoint: outcome.goal.target.entryPoint,
    },
    inputs: acc.params,
    outputs,
    steps,
    outcomes: [],
  };

  const capability: Capability = {
    schemaVersion: "1.0",
    id,
    name,
    description,
    version: 1,
    contentHash: contentHashOf(semantic),
    approval: options.approval ?? "draft",
    ...semantic,
    provenance: {
      discoveryRunId: outcome.runId,
      recordedAt: outcome.startedAt,
      // Field names differ on purpose across this boundary: discovery calls
      // it "name" because that is what a Planner exposes; the artifact calls
      // it "provider" because that is the word a reviewer reads. Mapping it
      // explicitly here beats reusing the object and hoping the names align.
      planner: { provider: outcome.provider.name, model: outcome.provider.model },
      // Every step in outcome.steps already made it past resolution and
      // policy at discovery time (loop.ts skips anything that did not,
      // silently, before it is ever recorded) - so nothing is pruned *here*.
      // This field exists for a compiler that later learns to drop steps of
      // its own (e.g. a redundant re-observation), not as decoration.
      prunedSteps: 0,
      humanEdited: false,
    },
  };

  // Validate our own output against the same schema a reviewer or a replay
  // engine will hold it to - a compiler that produces something its own
  // schema rejects is a defect in the compiler, not a footnote.
  return CapabilitySchema.parse(capability);
}
