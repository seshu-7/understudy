/**
 * The cost governor.
 *
 * `UNDERSTUDY_MAX_USD` defaults to 0, and both providers this project
 * actually runs against - local Ollama and Google's free tier - genuinely
 * cost nothing, so the default ceiling is never the thing that blocks a run.
 * It exists for the honest reason: if someone points the seam at a paid
 * provider, the loop must refuse to spend past what they configured rather
 * than discover the bill afterwards.
 */

// USD per million tokens. Deliberately not the intro-discounted rate for
// Sonnet - a safety ceiling should not rely on a promotional price still
// being in effect.
const PRICING: Record<string, { input: number; output: number }> = {
  "anthropic:claude-sonnet-5": { input: 3, output: 15 },
  "anthropic:claude-opus-5": { input: 5, output: 25 },
  "anthropic:claude-haiku-4-5": { input: 1, output: 5 },
};

export function estimateCostUsd(
  provider: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  if (provider === "ollama") return 0; // local inference
  if (provider === "google") return 0; // AI Studio free tier
  const rate = PRICING[`${provider}:${model}`];
  if (!rate) return 0;
  return (promptTokens / 1_000_000) * rate.input + (completionTokens / 1_000_000) * rate.output;
}

export class CostCeilingExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CostCeilingExceededError";
  }
}

export class CostGovernor {
  private spentUsd = 0;

  constructor(private readonly ceilingUsd: number) {}

  /** Prices and records one exchange. Throws before the spend is recorded if
   *  it would cross the ceiling - the caller is expected to catch this and
   *  stop the run with stopReason "cost_ceiling", not to retry. */
  charge(provider: string, model: string, promptTokens: number, completionTokens: number): number {
    const cost = estimateCostUsd(provider, model, promptTokens, completionTokens);
    if (this.spentUsd + cost > this.ceilingUsd) {
      throw new CostCeilingExceededError(
        `this exchange would bring discovery spend to $${(this.spentUsd + cost).toFixed(4)}, over the $${this.ceilingUsd.toFixed(2)} ceiling set by UNDERSTUDY_MAX_USD`,
      );
    }
    this.spentUsd += cost;
    return cost;
  }

  get totalUsd(): number {
    return this.spentUsd;
  }
}
