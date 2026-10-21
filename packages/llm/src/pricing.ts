import type { TacticPrompt } from "./types.ts";

/** Token counts for one or more calls, as the API reports them. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
});

/**
 * USD per million tokens, first-party API list prices as of 2026-10-06. Estimates only: the
 * billing console is the source of truth. Haiku 5.5's price applies to prompts under 100K tokens,
 * which covers every classifier call.
 */
export const PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

const CACHE_READ = 0.1;
const CACHE_WRITE_5M = 1.25;
const BATCH = 0.5;

export function priceFor(model: string): { input: number; output: number } {
  const p = PRICES_PER_MTOK[model];
  if (!p)
    throw new Error(
      `no price on file for model "${model}" (known: ${Object.keys(PRICES_PER_MTOK).join(", ")})`,
    );
  return p;
}

export function estimateCostUsd(
  usage: TokenUsage,
  model: string,
  opts: { batch?: boolean } = {},
): number {
  const p = priceFor(model);
  const usd =
    (usage.input * p.input +
      usage.cacheWrite * p.input * CACHE_WRITE_5M +
      usage.cacheRead * p.input * CACHE_READ +
      usage.output * p.output) /
    1e6;
  return opts.batch ? usd * BATCH : usd;
}

/** Rough token count without an API call. Deliberately pessimistic (English averages ~4 chars/token). */
export const estimateTokens = (text: string) => Math.ceil(text.length / 3.5);

/** Output allowance per classifier call, thinking included. Pessimistic for low effort. */
export const OUTPUT_ALLOWANCE_TOKENS = 1000;

/**
 * Predicted usage of one classifier call. With `systemCached`, the system prompt is billed as a
 * cache read; otherwise as a cache write (first call) or, for batches, as plain input, because
 * cache hits inside a batch are best-effort.
 */
export function estimatePromptUsage(
  prompt: TacticPrompt,
  opts: { systemCached: boolean; batch?: boolean },
): TokenUsage {
  const system = estimateTokens(prompt.system);
  const user = estimateTokens(prompt.user);
  if (opts.batch)
    return { input: system + user, output: OUTPUT_ALLOWANCE_TOKENS, cacheRead: 0, cacheWrite: 0 };
  return opts.systemCached
    ? { input: user, output: OUTPUT_ALLOWANCE_TOKENS, cacheRead: system, cacheWrite: 0 }
    : { input: user, output: OUTPUT_ALLOWANCE_TOKENS, cacheRead: 0, cacheWrite: system };
}
