import { DECISION_JSON_SCHEMA, type Planner, type PlannerContext, type PlannerDecision, type PlannerResult } from "../planner.js";

/**
 * Google AI Studio's free tier, used only for the cross-model evidence run in
 * Phase 8 - a second model discovering the same goal, so the compiled
 * artifacts can be compared. It exists behind this file and nowhere else,
 * proving the provider seam is real rather than asserted: swapping the model
 * that drives discovery is a constructor call, not a rewrite.
 *
 * `responseSchema` is Gemini's equivalent of Ollama's `format` - constrained
 * JSON output from the same decision schema every provider shares.
 */

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export interface GooglePlannerOptions {
  apiKey: string;
  model?: string;
  systemPrompt: string;
  timeoutMs?: number;
}

export class GooglePlanner implements Planner {
  readonly provider = "google";
  readonly model: string;
  private readonly apiKey: string;
  private readonly systemPrompt: string;
  private readonly timeoutMs: number;

  constructor(opts: GooglePlannerOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "gemini-2.0-flash";
    this.systemPrompt = opts.systemPrompt;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  async decide(context: PlannerContext): Promise<PlannerResult> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
    const body = {
      systemInstruction: { parts: [{ text: this.systemPrompt }] },
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `GOAL: ${context.goal}\n\nHISTORY:\n${context.history || "(start of run)"}\n\nCURRENT SCREEN:\n${context.observationText}\n\nRespond with a single JSON decision.`,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
        responseSchema: toGeminiSchema(DECISION_JSON_SCHEMA),
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new Error(`google request exceeded ${this.timeoutMs}ms`);
      }
      throw new Error(`could not reach Google AI Studio: ${String(error)}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new Error(`google generateContent failed: ${res.status} ${await res.text()}`);
    }

    const json = (await res.json()) as GeminiResponse;
    const content = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    let decision: PlannerDecision;
    try {
      decision = JSON.parse(content) as PlannerDecision;
    } catch {
      throw new Error(`google returned non-JSON content: ${content.slice(0, 300)}`);
    }

    return {
      decision,
      usage: {
        promptTokens: json.usageMetadata?.promptTokenCount ?? 0,
        completionTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
      },
      raw: json,
    };
  }
}

/** Gemini's schema dialect rejects a couple of plain JSON Schema keywords
 *  (bare `additionalProperties`-free objects are fine, but it is stricter
 *  about `object` properties needing declared types throughout) - in
 *  practice the shared schema already satisfies it, so this is an identity
 *  mapping kept as a named seam rather than passing the schema through
 *  untyped at the call site. */
function toGeminiSchema(schema: typeof DECISION_JSON_SCHEMA): unknown {
  return schema;
}
