/**
 * The seam between the discovery loop and whichever model is driving it.
 *
 * Deliberately not a tool-calling interface. Tool-calling conventions differ
 * enough between providers - and are flaky enough on a small local model -
 * that the more portable contract is "produce one JSON object matching this
 * schema". Every provider this project targets (Ollama's `format`, Gemini's
 * `responseSchema`) supports that natively, so a provider adapter is a
 * request/response mapping and nothing more. It is also what makes the
 * cassette format uninteresting: recording and replaying "JSON in, JSON out"
 * needs no provider-specific unwrapping.
 */

export type DecisionAction =
  | "click"
  | "fill"
  | "select"
  | "press"
  | "navigate"
  | "wait"
  | "finish"
  | "give_up";

/**
 * One decision, exactly as the model returns it. Fields are optional and
 * interpreted according to `action` - this is intentionally a loose shape at
 * the planner boundary; `src/discovery/loop.ts` is where a decision is
 * validated against the actual candidate list before anything executes.
 */
export interface PlannerDecision {
  action: DecisionAction;
  /** Index into the observation's numbered element list. Required for click,
   *  fill, select. */
  index?: number;
  /** For fill. */
  text?: string;
  /** For select. */
  option?: string;
  /** For press. */
  key?: string;
  /** For navigate. */
  url?: string;
  /** One sentence, always required - this becomes Step.intent in the
   *  compiled artifact and the line a human reads when reviewing a failure. */
  intent: string;
  /** For finish: the named outputs the goal asked for. */
  outputs?: Record<string, string>;
  /** For give_up: why continuing is not safe or not possible. */
  reason?: string;
}

export interface PlannerContext {
  goal: string;
  /** The current, redacted, diffed rendering of the screen. */
  observationText: string;
  /** A short recap of prior steps and what happened, so the model has
   *  continuity without re-reading every past observation in full. */
  history: string;
}

export interface PlannerUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface PlannerResult {
  decision: PlannerDecision;
  usage: PlannerUsage;
  /** The full provider response, redacted before this point - kept for the
   *  cassette and the trace, never re-read for anything the loop decides on. */
  raw: unknown;
}

export interface Planner {
  readonly provider: string;
  readonly model: string;
  decide(context: PlannerContext): Promise<PlannerResult>;
}

/** Shared JSON Schema for the decision object, handed to whichever provider
 *  supports constrained/structured output. Providers that don't are expected
 *  to fall back to prompt instructions plus best-effort JSON parsing. */
export const DECISION_JSON_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["click", "fill", "select", "press", "navigate", "wait", "finish", "give_up"],
    },
    index: { type: "integer" },
    text: { type: "string" },
    option: { type: "string" },
    key: { type: "string" },
    url: { type: "string" },
    intent: { type: "string" },
    outputs: { type: "object" },
    reason: { type: "string" },
  },
  required: ["action", "intent"],
} as const;

/**
 * Every paragraph past the action list below earns its place against a
 * specific, observed failure on a small local instruct model
 * (qwen2.5:3b-instruct, chosen for having no hybrid-thinking tax - see the
 * comment in providers/ollama.ts for why that matters on CPU-only hardware).
 * None of this is hypothetical hardening; each one is what a live run
 * actually got wrong before the corresponding sentence was added.
 *
 *  - No mention of the sign-on screen's actual fields: the model chose
 *    "navigate" with no URL rather than filling the visible Operator ID
 *    field. Fixed by "act on the CURRENT SCREEN exactly as it is" plus the
 *    fill-before-submit ordering.
 *  - Even with that fix, once the Operator ID field already showed
 *    value:"OPERATOR", the model filled the identical field with the
 *    identical value again - twice - rather than moving to Password or
 *    clicking Sign On. The observation was correct; the model simply did
 *    not check it. Fixed by the explicit "check whether it already shows
 *    the value" instruction.
 *  - Separately, it chose "press" and "navigate" several times with no
 *    "key" or "url" field present, despite the schema requiring them for
 *    those actions - producing a well-formed but useless decision the loop
 *    could only skip. Fixed by stating plainly that the action does nothing
 *    without that field, not just that the field is "required" in the
 *    abstract.
 *  - On qwen2.5:7b-instruct, a full run got every mechanical step right -
 *    sign-on, a frame-scoped fill, the search click - and reached a Member
 *    Detail screen whose observation plainly showed the member's name and
 *    "Regular Savings ... 4,182.55", exactly what the goal asked to read.
 *    The model answered "wait" three times running anyway, on an unchanging
 *    screen, until the loop's own repeat detector stopped it. It had never
 *    been told to actively check the goal against what it could already
 *    see; "finish: use when the goal has been fully achieved" reads as a
 *    label for an action, not an instruction to go compare. Fixed by adding
 *    an explicit compare-before-waiting step.
 *
 * The lesson underneath all four: a model this size will not reliably infer
 * a constraint from schema shape, from a single mention, or from an action's
 * one-line description - it needs the check it should perform spelled out as
 * a step, not implied by the existence of an option. That is a property of
 * the model, not a one-off prompt bug, so it is recorded here rather than
 * quietly fixed and forgotten.
 */
export function systemPrompt(): string {
  return `You are operating a legacy web application on behalf of a human operator, one careful step at a time.

You will be shown a GOAL, a HISTORY of what you have done so far, and the CURRENT SCREEN as a numbered list of the controls and nearby text a human operator would see. You do not see raw HTML - only that list.

Respond with exactly one JSON object describing your next decision. No other text.

Actions:
- click: requires "index" - the number of a button, link, checkbox, radio, tab or option to click.
- fill: requires "index" and "text" - types text into a textbox.
- select: requires "index" and "option" - chooses an option from a combobox by its visible text.
- press: requires "key" (e.g. "Enter") - you MUST include "key" or this action does nothing.
- navigate: requires "url" - you MUST include "url" or this action does nothing. Only use this if no control on the CURRENT SCREEN can get you there - it is almost never the right choice when a form or button is visible.
- wait: use when the screen looks like it is still loading.
- finish: use when the goal has been fully achieved. Include "outputs" with any values the goal asked you to read, as plain strings.
- give_up: use when the goal cannot be completed safely from here - a permission error, a dead end, or a state you do not recognize. Explain why in "reason".

Always act on the CURRENT SCREEN exactly as it is, not as you expect it to be after a step you have not taken yet. If it shows a form with empty required fields, fill the first empty required field before doing anything else - do not skip ahead to a step that assumes the form is already submitted.

Before filling a textbox, check whether its line in CURRENT SCREEN already ends in value:"..." showing the value you were about to type. If it does, that step is already done - do not repeat it. Move to the next empty required field, or click the submit control if every required field already has a value. Repeating an action that produced no visible change wastes a turn.

Before choosing "wait" or any other action, first check whether the CURRENT SCREEN already contains everything the GOAL asked you to find or read - a name, a balance, a status, a confirmation message. If it does, use "finish" immediately and put the exact value(s) you found in "outputs". Do not wait, click, or take any further action once the answer is already visible in front of you.

Every decision needs a one-sentence "intent" describing what you are doing and why, written as an instruction a person could follow: e.g. "enter the member number into the search field", not "I will click element 3".

Only ever use an index that appears in the CURRENT SCREEN listing for this turn. Act on one control at a time. Prefer the most direct control for the task - a labelled search field and its adjacent button over a generic link.`;
}
