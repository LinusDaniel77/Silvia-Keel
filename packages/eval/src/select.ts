import { promptFor } from "@shield/engine";
import {
  estimateCostUsd,
  estimatePromptUsage,
  addUsage,
  ZERO_USAGE,
  type TokenUsage,
} from "@shield/llm";
import type { TacticLibrary } from "@shield/tactics";
import type { CorpusItem } from "./corpus.ts";

/**
 * Items carrying any of `tags`, plus the clean twin of every selected injection item so the
 * injection-pair check still has both halves. Corpus order is preserved.
 */
export function selectByTags(corpus: CorpusItem[], tags: string[]): CorpusItem[] {
  const wanted = new Set(
    corpus.filter((i) => i.tags.some((t) => tags.includes(t))).map((i) => i.id),
  );
  for (const i of corpus) if (wanted.has(i.id) && i.pairOf) wanted.add(i.pairOf);
  return corpus.filter((i) => wanted.has(i.id));
}

export interface RunEstimate {
  items: number;
  llmCalls: number;
  usage: TokenUsage;
  usd: number;
}

/** Predicts a paid run's size and cost without any API call. */
export function estimateRun(
  corpus: CorpusItem[],
  library: TacticLibrary,
  model: string,
  opts: { batch?: boolean } = {},
): RunEstimate {
  let usage = ZERO_USAGE;
  let llmCalls = 0;
  for (const item of corpus) {
    const prompt = promptFor(item.request, library, model);
    if (!prompt) continue;
    usage = addUsage(
      usage,
      estimatePromptUsage(prompt, { systemCached: llmCalls > 0, batch: opts.batch }),
    );
    llmCalls++;
  }
  return { items: corpus.length, llmCalls, usage, usd: estimateCostUsd(usage, model, opts) };
}
