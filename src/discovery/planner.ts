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

export function systemPrompt(): string {
  return `You are operating a legacy web application on behalf of a human operator, one careful step at a time.

You will be shown a GOAL, a HISTORY of what you have done so far, and the CURRENT SCREEN as a numbered list of the controls and nearby text a human operator would see. You do not see raw HTML - only that list.

Respond with exactly one JSON object describing your next decision. No other text.

Actions:
- click: requires "index" - the number of a button, link, checkbox, radio, tab or option to click.
- fill: requires "index" and "text" - types text into a textbox.
- select: requires "index" and "option" - chooses an option from a combobox by its visible text.
- press: requires "key" - presses a single keyboard key (e.g. "Enter").
- navigate: requires "url" - goes directly to a URL. Prefer clicking a link when one exists.
- wait: use when the screen looks like it is still loading.
- finish: use when the goal has been fully achieved. Include "outputs" with any values the goal asked you to read, as plain strings.
- give_up: use when the goal cannot be completed safely from here - a permission error, a dead end, or a state you do not recognize. Explain why in "reason".

Every decision needs a one-sentence "intent" describing what you are doing and why, written as an instruction a person could follow: e.g. "enter the member number into the search field", not "I will click element 3".

Only ever use an index that appears in the CURRENT SCREEN listing for this turn. Act on one control at a time. Prefer the most direct control for the task - a labelled search field and its adjacent button over a generic link.`;
}
