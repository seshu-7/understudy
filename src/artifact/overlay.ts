import { contentHashOf } from "./hash.js";
import {
  CapabilitySchema,
  type Capability,
  type Detector,
  type OutcomeSpec,
  type OutputSpec,
  type SemanticDescriptor,
  type Step,
  type TargetBinding,
  type TextMatch,
} from "./schema.js";

/**
 * Reusing a capability across tenants without re-recording it.
 *
 * `TargetBinding` has separated `app` from `tenant` since Phase 4, on the
 * claim that a capability recorded against one institution's instance should
 * be reusable against another running the same vendor software.
 * `src/surface/text.ts`'s own header names the exact scenario this module
 * exists to handle: a tenant renaming "Search" to "Find Member". Checked for
 * real against a second live tenant (`test/artifact/overlay-web.test.ts`),
 * that rename is not merely "weakened" without an overlay - the real
 * committed capability fails outright, one step *before* the renamed
 * button, because the previous step's checkpoint is "the next step's own
 * target is present" (Phase 4's checkpoint-inference rule) and that target
 * is the very button that no longer carries the text it was recorded
 * against. An overlay is not a robustness nicety here; for this rename it is
 * the difference between the capability working on a second tenant at all
 * and not.
 *
 * Only text substitution, deliberately. An overlay that could add or remove
 * steps would be a second compiler with none of the evidence discipline the
 * first one has - refusing to guess, grounding every output. Rewriting a
 * `TextMatch` literal is the one operation narrow enough to stay honest: it
 * is asserting "this tenant calls the same control something else," not
 * "this tenant's flow is structurally different," and if it turns out to be
 * the latter, the overlaid capability's own checkpoints will fail loudly at
 * replay time exactly the way any other wrong descriptor would.
 */

export interface TenantOverlay {
  tenant: string;
  entryPoint: string;
  /** Exact literal substitutions, applied to every `name`/`label` (and the
   *  text half of `within`/`anchor`) a step, checkpoint, output or outcome
   *  targets. Keyed on the *recorded* tenant's text - `{"Search": "Find
   *  Member"}` reads as "wherever this capability expects to see 'Search',
   *  this tenant shows 'Find Member' instead." */
  textOverrides: Readonly<Record<string, string>>;
}

function overrideMatch(match: TextMatch | undefined, overrides: Readonly<Record<string, string>>, matched: Set<string>): TextMatch | undefined {
  if (!match || match.kind === "pattern") return match;
  const replacement = overrides[match.value];
  if (replacement === undefined) return match;
  matched.add(match.value);
  return { ...match, value: replacement };
}

function overrideDescriptor(descriptor: SemanticDescriptor, overrides: Readonly<Record<string, string>>, matched: Set<string>): SemanticDescriptor {
  return {
    ...descriptor,
    name: overrideMatch(descriptor.name, overrides, matched),
    label: overrideMatch(descriptor.label, overrides, matched),
    ...(descriptor.within ? { within: { ...descriptor.within, name: overrideMatch(descriptor.within.name, overrides, matched)! } } : {}),
    ...(descriptor.anchor
      ? { anchor: { ...descriptor.anchor, node: { ...descriptor.anchor.node, name: overrideMatch(descriptor.anchor.node.name, overrides, matched)! } } }
      : {}),
  };
}

function overrideDetector(detector: Detector, overrides: Readonly<Record<string, string>>, matched: Set<string>): Detector {
  if (detector.kind === "location_matches") return detector;
  return { ...detector, descriptor: overrideDescriptor(detector.descriptor, overrides, matched) };
}

function overrideOutput(output: OutputSpec, overrides: Readonly<Record<string, string>>, matched: Set<string>): OutputSpec {
  return { ...output, extract: { ...output.extract, descriptor: overrideDescriptor(output.extract.descriptor, overrides, matched) } };
}

function overrideStep(step: Step, overrides: Readonly<Record<string, string>>, matched: Set<string>): Step {
  const a = step.action;
  const action: Step["action"] =
    a.kind === "click" || a.kind === "fill" || a.kind === "select"
      ? { ...a, target: overrideDescriptor(a.target, overrides, matched) }
      : a.kind === "wait" && a.until.kind !== "settled" && a.until.kind !== "location_matches"
        ? { ...a, until: { ...a.until, descriptor: overrideDescriptor(a.until.descriptor, overrides, matched) } }
        : a;
  return {
    ...step,
    action,
    ...(step.checkpoint ? { checkpoint: overrideDetector(step.checkpoint, overrides, matched) } : {}),
  };
}

function overrideOutcome(outcome: OutcomeSpec, overrides: Readonly<Record<string, string>>, matched: Set<string>): OutcomeSpec {
  return {
    ...outcome,
    detect: overrideDetector(outcome.detect, overrides, matched),
    ...(outcome.data ? { data: outcome.data.map((o) => overrideOutput(o, overrides, matched)) } : {}),
  };
}

export interface OverlayResult {
  capability: Capability;
  /** textOverrides keys that never matched a single `name`/`label` anywhere
   *  in the capability - almost always a typo, since a substitution that
   *  matches nothing has silently done nothing. Computed as a byproduct of
   *  the same pass that applies the overrides, not a second lookup that
   *  could disagree with the first about what "matched" means. */
  unmatchedOverrides: readonly string[];
}

/**
 * Produces a new capability for a different tenant. Never mutates the
 * input, and never inherits its `approval` - an overlay changes what every
 * descriptor actually expects to see, and a reviewer has not looked at
 * *these* descriptors yet even if they approved the original ones, so the
 * result always starts `draft` regardless of what was overlaid. `contentHash`
 * is recomputed for the same reason it exists at all: this is honestly a
 * different program now (different target, likely different descriptor
 * text), and a hash that did not change would be lying about that.
 *
 * `id` is tenant-qualified for the same reason: the source capability's own
 * id means "this program, against the tenant it was recorded on" - reusing
 * it unchanged for a second tenant's overlay would leave two capabilities
 * bound to two different origins answering to one id, which is exactly
 * what a catalog keyed on id (`src/catalog/catalog.ts`) cannot tell apart.
 * The suffix matches the `.{tenant}.v{version}` the CLI already uses for
 * the artifact's own filename (`src/cli/overlay.ts`), so the id and the
 * file that holds it agree.
 */
export function applyOverlay(capability: Capability, overlay: TenantOverlay): OverlayResult {
  const matched = new Set<string>();
  const target: TargetBinding = { ...capability.target, tenant: overlay.tenant, entryPoint: overlay.entryPoint };
  const steps = capability.steps.map((s) => overrideStep(s, overlay.textOverrides, matched));
  const outputs = capability.outputs.map((o) => overrideOutput(o, overlay.textOverrides, matched));
  const outcomes = capability.outcomes.map((o) => overrideOutcome(o, overlay.textOverrides, matched));

  const semantic = { target, inputs: capability.inputs, outputs, steps, outcomes };

  const overlaid = CapabilitySchema.parse({
    ...capability,
    ...semantic,
    id: `${capability.id}.${overlay.tenant}`,
    contentHash: contentHashOf(semantic),
    approval: "draft",
    provenance: { ...capability.provenance, humanEdited: true },
  });

  const unmatchedOverrides = Object.keys(overlay.textOverrides).filter((key) => !matched.has(key));
  return { capability: overlaid, unmatchedOverrides };
}
