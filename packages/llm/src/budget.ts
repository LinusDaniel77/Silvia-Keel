import {
  addUsage,
  estimateCostUsd,
  estimatePromptUsage,
  ZERO_USAGE,
  type TokenUsage,
} from "./pricing.ts";
import type { LlmProvider, ProviderResult, TacticPrompt } from "./types.ts";

/**
 * Wraps a provider with a hard spending cap. Each call reserves its estimated cost before it is
 * made (so concurrent calls can't overshoot together) and settles to the reported usage after.
 * Calls that would cross the cap are not made; they come back as `skipped_budget`.
 */
export class BudgetedProvider implements LlmProvider {
  readonly id: string;
  readonly model: string;
  private reservedUsd = 0;
  private calls = 0;
  usage: TokenUsage = ZERO_USAGE;
  spentUsd = 0;
  skipped = 0;

  constructor(
    private readonly inner: LlmProvider,
    private readonly maxUsd: number,
  ) {
    if (!inner.model) throw new Error("a budget needs a provider with a known model");
    this.id = inner.id;
    this.model = inner.model;
  }

  async classify(prompt: TacticPrompt): Promise<ProviderResult> {
    const estimate = estimateCostUsd(
      estimatePromptUsage(prompt, { systemCached: this.calls > 0 }),
      this.model,
    );
    if (this.spentUsd + this.reservedUsd + estimate > this.maxUsd) {
      this.skipped++;
      return { status: "skipped_budget", detail: `budget of $${this.maxUsd} reached` };
    }
    this.calls++;
    this.reservedUsd += estimate;
    try {
      const result = await this.inner.classify(prompt);
      const actual = result.usage ? estimateCostUsd(result.usage, this.model) : estimate;
      if (result.usage) this.usage = addUsage(this.usage, result.usage);
      this.spentUsd += actual;
      return result;
    } finally {
      this.reservedUsd -= estimate;
    }
  }
}
