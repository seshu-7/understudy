import { DECISION_JSON_SCHEMA, type Planner, type PlannerContext, type PlannerDecision, type PlannerResult } from "../planner.js";

/**
 * Local inference via Ollama's HTTP API. No SDK, no dependency, no key - a
 * plain `fetch` to a server that by default is not reachable from outside
 * this machine. This is the provider the write-up's data-residency argument
 * rests on: nothing here can leave the network.
 *
 * `format` is Ollama's structured-output parameter - passing a JSON Schema
 * makes the server itself constrain generation to that shape, which matters
 * more on a 4B model than on a frontier one: without it, a small model
 * drifts into prose around the JSON often enough to be a real reliability
 * problem, not a cosmetic one.
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
    this.model = opts.model ?? "qwen3:4b";
    this.systemPrompt = opts.systemPrompt;
    this.timeoutMs = opts.timeoutMs ?? 180_000;
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
