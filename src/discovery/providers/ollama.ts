import { DECISION_JSON_SCHEMA, type Planner, type PlannerContext, type PlannerDecision, type PlannerResult } from "../planner.js";

/**
 * Local inference via Ollama's HTTP API. No SDK, no dependency, no key - a
 * plain `fetch` to a server that by default is not reachable from outside
 * this machine. This is the provider the write-up's data-residency argument
 * rests on: nothing here can leave the network.
 *
 * `format` is Ollama's structured-output parameter - passing a JSON Schema
 * makes the server itself constrain generation to that shape, which matters
 * more on a small model than on a frontier one: without it, a small model
 * drifts into prose around the JSON often enough to be a real reliability
 * problem, not a cosmetic one.
 *
 * The default model is a plain instruct model, deliberately not one of the
 * newer hybrid-thinking small models. qwen3:4b was the first choice and was
 * measured, not assumed, to be unusable on CPU-only hardware for this: it
 * spent 150-200 invisible "thinking" tokens on a two-word reply (about 20s
 * at this machine's ~9-10 tok/s), and a single realistic decision - the
 * actual system prompt plus one observation - exceeded a five-minute ceiling
 * with no response at all, reproduced twice, with and without the JSON
 * schema constraint. Neither Ollama's generic `think: false` request field
 * nor Qwen3's own documented `/no_think` directive suppressed it on this
 * build; `think: false` only moved the reasoning text into the `content`
 * field instead of removing it. Switching to qwen2.5:3b-instruct - about a
 * quarter the download, no hybrid-thinking mode - brought a realistic
 * decision down to roughly 20 seconds with a correct result, once the system
 * prompt was made explicit about acting on the screen as it currently is
 * rather than skipping ahead (see the comment on systemPrompt() in
 * planner.ts). The lesson generalises: for a CPU-bound, wall-clock-bounded
 * loop like this one, an unconditionally-reasoning model is a worse default
 * than a smaller model that answers directly, even though it has more
 * parameters.
 */

interface OllamaChatResponse {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
}

export interface OllamaPlannerOptions {
  host?: string;
  model?: string;
  systemPrompt: string;
  /** Per-request timeout. A CPU-only 4B model can genuinely take a couple of
   *  minutes per turn; this is a ceiling against a hung request, not a tight
   *  budget. */
  timeoutMs?: number;
}

export class OllamaPlanner implements Planner {
  readonly provider = "ollama";
  readonly model: string;
  private readonly host: string;
  private readonly systemPrompt: string;
  private readonly timeoutMs: number;

  constructor(opts: OllamaPlannerOptions) {
    this.host = opts.host ?? "http://127.0.0.1:11434";
    this.model = opts.model ?? "qwen2.5:3b-instruct";
    this.systemPrompt = opts.systemPrompt;
    // Measured, not guessed: a single decision against a moderately-sized
    // screen took 95s on qwen2.5:7b-instruct on this CPU-only machine, almost
    // entirely in prompt evaluation rather than generation. A busier screen
    // (more candidate elements, a longer HISTORY) sends more tokens and costs
    // more of exactly that. 5 minutes is headroom over the worst measured
    // case, not an arbitrary round number.
    this.timeoutMs = opts.timeoutMs ?? 300_000;
  }

  async decide(context: PlannerContext): Promise<PlannerResult> {
    const body = {
      model: this.model,
      stream: false,
      format: DECISION_JSON_SCHEMA,
      options: { temperature: 0.1 },
      messages: [
        { role: "system", content: this.systemPrompt },
        {
          role: "user",
          content: `GOAL: ${context.goal}\n\nHISTORY:\n${context.history || "(start of run)"}\n\nCURRENT SCREEN:\n${context.observationText}\n\nRespond with a single JSON decision.`,
        },
      ],
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.host}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new Error(`ollama request exceeded ${this.timeoutMs}ms - is the model still loading?`);
      }
      throw new Error(`could not reach ollama at ${this.host}: ${String(error)}. Is "ollama serve" running?`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new Error(`ollama chat failed: ${res.status} ${await res.text()}`);
    }

    const json = (await res.json()) as OllamaChatResponse;
    const content = json.message?.content ?? "";
    let decision: PlannerDecision;
    try {
      decision = JSON.parse(content) as PlannerDecision;
    } catch {
      throw new Error(`ollama returned non-JSON content: ${content.slice(0, 300)}`);
    }

    return {
      decision,
      usage: { promptTokens: json.prompt_eval_count ?? 0, completionTokens: json.eval_count ?? 0 },
      raw: json,
    };
  }
}
