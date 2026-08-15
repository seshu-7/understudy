import { z } from "zod";

/**
 * The capability artifact, as a Zod schema.
 *
 * This is the source of truth the Phase 0 seam promised: one definition that
 * serves runtime validation of a capability read back off disk, the
 * TypeScript types the rest of the system compiles against, and — free of
 * charge, since it is already JSON-Schema-shaped — the contract a calling
 * agent's tool-use surface would publish. `src/artifact/types.ts` re-exports
 * the inferred types from here rather than declaring its own, so there is
 * exactly one place this shape can drift.
 *
 * Two things live here that were only comments before. The descriptor
 * vocabulary (`Role`, `TextMatch`, `SemanticDescriptor`, ...) is re-declared
 * as Zod rather than imported from `src/surface/types.ts`, because those
 * hand-written interfaces describe *live, trusted* data our own adapter just
 * produced — nothing to validate there. A capability read back off disk is
 * the opposite: untrusted input crossing a real boundary, exactly where Zod
 * earns its keep. `test/artifact/schema-surface-parity.test.ts` is what keeps
 * the two representations honest — it runs a real `SemanticDescriptor` out of
 * the actual matcher through this schema and fails loudly the moment they
 * disagree, rather than letting them drift silently.
 *
 * And the "remedy required iff recoverable" rule from the original comment is
 * now real: `OutcomeSpecSchema` enforces it with `.superRefine`, in both
 * directions - a `recoverable` outcome with no remedy is rejected, and a
 * `business_outcome` or `hard_failure` carrying one is too, because a remedy
 * nobody will ever consult is dead data in an artifact meant to be read by a
 * human reviewer.
 */

// ---------------------------------------------------------------------------
// Perception vocabulary — the parts of surface/types.ts an artifact embeds.
// ---------------------------------------------------------------------------

export const RoleSchema = z.enum([
  "button", "link", "textbox", "checkbox", "radio", "combobox", "option",
  "listitem", "row", "cell", "heading", "text", "image", "dialog", "alert",
  "table", "form", "region", "tab", "unknown",
]);

export const RectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

/** `.readonly()` so the inferred type is `readonly string[]`, matching how
 *  every consumer in src/surface/ already treats a frame path - nothing in
 *  this codebase ever mutates one in place, and letting the type say so is
 *  what caught the schema/surface mismatch this file's own header explains. */
export const FramePathSchema = z.array(z.string()).readonly();

export const TextMatchSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exact"), value: z.string() }),
  z.object({ kind: z.literal("normalized"), value: z.string() }),
  z.object({ kind: z.literal("contains"), value: z.string() }),
  z.object({ kind: z.literal("pattern"), source: z.string(), flags: z.string().optional() }),
]);

export const SemanticDescriptorSchema = z.object({
  role: RoleSchema,
  name: TextMatchSchema.optional(),
  label: TextMatchSchema.optional(),
  within: z.object({ role: RoleSchema, name: TextMatchSchema }).optional(),
  anchor: z
    .object({
      direction: z.enum(["after", "before"]),
      node: z.object({ role: RoleSchema, name: TextMatchSchema }),
    })
    .optional(),
  frame: FramePathSchema.optional(),
  ordinal: z.number().int().nonnegative().optional(),
  observedAs: z.object({ text: z.string(), bounds: RectSchema.optional() }).optional(),
});

export const WaitConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("settled") }),
  z.object({ kind: z.literal("node_present"), descriptor: SemanticDescriptorSchema }),
  z.object({ kind: z.literal("node_absent"), descriptor: SemanticDescriptorSchema }),
  z.object({ kind: z.literal("location_matches"), pattern: z.string() }),
]);

export const SurfaceKindSchema = z.enum(["web", "desktop"]);

// ---------------------------------------------------------------------------
// Capability vocabulary
// ---------------------------------------------------------------------------

export const ApprovalStateSchema = z.enum(["draft", "approved", "retired"]);

export const ParamTypeSchema = z.enum(["string", "number", "boolean", "date"]);

export const ParamSpecSchema = z.object({
  name: z.string().min(1),
  type: ParamTypeSchema,
  description: z.string().min(1),
  required: z.boolean(),
  sensitive: z.boolean().optional(),
  example: z.string().optional(),
});

export const OutputSpecSchema = z.object({
  name: z.string().min(1),
  type: ParamTypeSchema,
  description: z.string().min(1),
  extract: z.object({
    descriptor: SemanticDescriptorSchema,
    from: z.enum(["text", "value", "name"]),
  }),
});

export const DetectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("node_present"), descriptor: SemanticDescriptorSchema }),
  z.object({ kind: z.literal("node_absent"), descriptor: SemanticDescriptorSchema }),
  z.object({ kind: z.literal("text_matches"), descriptor: SemanticDescriptorSchema, pattern: z.string() }),
  z.object({ kind: z.literal("location_matches"), pattern: z.string() }),
]);

export const OutcomeClassSchema = z.enum(["business_outcome", "recoverable", "hard_failure"]);

export const RemedySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("dismiss"), descriptor: SemanticDescriptorSchema }),
  z.object({ kind: z.literal("wait_retry"), attempts: z.number().int().positive(), backoffMs: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("reauthenticate") }),
]);

export const OutcomeSpecSchema = z
  .object({
    name: z.string().min(1),
    class: OutcomeClassSchema,
    description: z.string().min(1),
    detect: DetectorSchema,
    remedy: RemedySchema.optional(),
    data: z.array(OutputSpecSchema).optional(),
  })
  .superRefine((outcome, ctx) => {
    if (outcome.class === "recoverable" && !outcome.remedy) {
      ctx.addIssue({
        code: "custom",
        path: ["remedy"],
        message: 'a "recoverable" outcome must declare a remedy - a recoverable condition nobody will attempt to recover from is a hard_failure wearing the wrong label',
      });
    }
    if (outcome.class !== "recoverable" && outcome.remedy) {
      ctx.addIssue({
        code: "custom",
        path: ["remedy"],
        message: `a remedy is meaningless on a "${outcome.class}" outcome and will never be consulted - remove it, or reclassify the outcome as recoverable`,
      });
    }
  });

export const ValueSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: z.string() }),
  z.object({ kind: z.literal("param"), name: z.string().min(1) }),
]);

const StepActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("click"), target: SemanticDescriptorSchema }),
  z.object({ kind: z.literal("fill"), target: SemanticDescriptorSchema, value: ValueSourceSchema }),
  z.object({ kind: z.literal("select"), target: SemanticDescriptorSchema, value: ValueSourceSchema }),
  z.object({ kind: z.literal("press"), key: z.string().min(1) }),
  z.object({ kind: z.literal("navigate"), to: ValueSourceSchema }),
  z.object({ kind: z.literal("wait"), until: WaitConditionSchema, timeoutMs: z.number().int().positive() }),
]);

export const RiskTierSchema = z.enum(["safe", "elevated", "irreversible"]);

export const StepSchema = z.object({
  index: z.number().int().nonnegative(),
  intent: z.string().min(1),
  action: StepActionSchema,
  checkpoint: DetectorSchema.optional(),
  risk: RiskTierSchema,
  timeoutMs: z.number().int().positive(),
});

export const TargetBindingSchema = z.object({
  app: z.string().min(1),
  appVersion: z.string().optional(),
  tenant: z.string().min(1),
  surface: SurfaceKindSchema,
  entryPoint: z.string().min(1),
});

export const ProvenanceSchema = z.object({
  discoveryRunId: z.string().min(1),
  recordedAt: z.iso.datetime({ offset: true }).or(z.iso.datetime()),
  planner: z.object({ provider: z.string().min(1), model: z.string().min(1) }),
  prunedSteps: z.number().int().nonnegative(),
  humanEdited: z.boolean(),
});

/** A hex string, the length `sha256(...).slice(0, N)` actually produces
 *  (see contentHashOf in compile.ts) — not a full 64-char digest, since the
 *  hash only has to be collision-resistant within one project's artifacts. */
export const ContentHashSchema = z.string().regex(/^[0-9a-f]{16}$/, "expected a 16-character lowercase hex digest");

export const CapabilitySchema = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.number().int().positive(),
  contentHash: ContentHashSchema,
  approval: ApprovalStateSchema,
  target: TargetBindingSchema,
  inputs: z.array(ParamSpecSchema),
  outputs: z.array(OutputSpecSchema),
  steps: z.array(StepSchema),
  outcomes: z.array(OutcomeSpecSchema),
  provenance: ProvenanceSchema,
});

export type Role = z.infer<typeof RoleSchema>;
export type Rect = z.infer<typeof RectSchema>;
export type FramePath = z.infer<typeof FramePathSchema>;
export type TextMatch = z.infer<typeof TextMatchSchema>;
export type SemanticDescriptor = z.infer<typeof SemanticDescriptorSchema>;
export type WaitCondition = z.infer<typeof WaitConditionSchema>;
export type SurfaceKind = z.infer<typeof SurfaceKindSchema>;

export type ApprovalState = z.infer<typeof ApprovalStateSchema>;
export type ParamType = z.infer<typeof ParamTypeSchema>;
export type ParamSpec = z.infer<typeof ParamSpecSchema>;
export type OutputSpec = z.infer<typeof OutputSpecSchema>;
export type Detector = z.infer<typeof DetectorSchema>;
export type OutcomeClass = z.infer<typeof OutcomeClassSchema>;
export type Remedy = z.infer<typeof RemedySchema>;
export type OutcomeSpec = z.infer<typeof OutcomeSpecSchema>;
export type ValueSource = z.infer<typeof ValueSourceSchema>;
export type RiskTier = z.infer<typeof RiskTierSchema>;
export type Step = z.infer<typeof StepSchema>;
export type TargetBinding = z.infer<typeof TargetBindingSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type Capability = z.infer<typeof CapabilitySchema>;

/** Parse and validate a capability read back from disk. Throws a ZodError
 *  with a precise path to whatever is wrong - never trust a JSON.parse of an
 *  artifact file without also running it through this. */
export function parseCapability(data: unknown): Capability {
  return CapabilitySchema.parse(data);
}
