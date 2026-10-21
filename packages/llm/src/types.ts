// The SDK's structured-output helper takes zod v4 schemas; zod 3.25 ships v4 under "zod/v4".
import { z } from "zod/v4";

/** What a provider must return: candidate hits, validated by validateHits before use. */
export const RawHitsSchema = z.object({
  hits: z.array(
    z.object({
      tactic_id: z.string(),
      confidence: z.number(),
      evidence: z.array(z.string()),
    }),
  ),
});
export type RawHits = z.infer<typeof RawHitsSchema>;

export interface TacticPrompt {
  system: string;
  user: string;
  /** Hash of everything that shapes the classifier's behavior, recorded on every analysis. */
  hash: string;
}

/** Token counts the API reported for a call (same shape as pricing.TokenUsage). */
export interface ProviderUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type ProviderResult =
  | { status: "ok"; hits: RawHits["hits"]; usage?: ProviderUsage }
  | { status: "refused" | "error"; detail: string; usage?: ProviderUsage }
  | { status: "skipped_budget"; detail: string; usage?: undefined };

export interface LlmProvider {
  readonly id: string;
  readonly model: string | null;
  classify(prompt: TacticPrompt): Promise<ProviderResult>;
}
