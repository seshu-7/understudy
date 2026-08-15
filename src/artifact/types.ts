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
 * The Phase 0 version of this file declared these as plain interfaces with a
 * promise that Phase 4 would make a Zod schema the source of truth. It now
 * does — `./schema.ts` is that schema, and this file is a thin re-export of
 * its inferred types, kept only so existing imports of `artifact/types.js`
 * do not have to change. New code should import from `./schema.js` directly,
 * where the Zod schema, the inferred type, and `parseCapability()` for
 * validating an artifact read off disk all live together.
 */
export type {
  ApprovalState,
  Capability,
  Detector,
  OutcomeClass,
  OutcomeSpec,
  OutputSpec,
  ParamSpec,
  ParamType,
  Provenance,
  Remedy,
  RiskTier,
  Step,
  TargetBinding,
  ValueSource,
} from "./schema.js";
