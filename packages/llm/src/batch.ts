import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { usageFrom } from "./anthropic.ts";
import { addUsage, ZERO_USAGE, type TokenUsage } from "./pricing.ts";
import {
  RawHitsSchema,
  type LlmProvider,
  type ProviderResult,
  type TacticPrompt,
} from "./types.ts";

/** Key for a prompt's result: identical requests share one answer. */
export const promptKey = (prompt: TacticPrompt) =>
  createHash("sha256").update(`${prompt.hash}\n${prompt.user}`).digest("hex").slice(0, 32);

export interface BatchRunResult {
  batchId: string;
  results: Map<string, ProviderResult>;
  usage: TokenUsage;
}

/**
 * Classifies many prompts through the Message Batches API: half the price of synchronous calls,
 * results within 24 hours (usually minutes). Results are matched by custom_id, never by order.
 * The Batches API rejects `fallbacks`, so refusals here fall back to the rules.
 */
export async function classifyInBatch(
  client: Anthropic,
  prompts: TacticPrompt[],
  opts: {
    model: string;
    effort?: "low" | "medium" | "high";
    pollMs?: number;
    onProgress?: (status: string) => void;
  },
): Promise<BatchRunResult> {
  const unique = new Map(prompts.map((p) => [promptKey(p), p]));
  const keys = [...unique.keys()];
  const batch = await client.messages.batches.create({
    requests: keys.map((key, i) => {
      const p = unique.get(key)!;
      return {
        custom_id: `p${i}`,
        params: {
          model: opts.model,
          max_tokens: 4096,
          output_config: { effort: opts.effort ?? "low", format: zodOutputFormat(RawHitsSchema) },
          system: [
            {
              type: "text" as const,
              text: p.system,
              cache_control: { type: "ephemeral" as const },
            },
          ],
          messages: [{ role: "user" as const, content: p.user }],
        },
      };
    }),
  });

  let status = batch;
  while (status.processing_status !== "ended") {
    opts.onProgress?.(
      `batch ${status.id}: ${status.request_counts.succeeded + status.request_counts.errored}/${keys.length} done`,
    );
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 30_000));
    status = await client.messages.batches.retrieve(status.id);
  }

  const results = new Map<string, ProviderResult>();
  let usage = ZERO_USAGE;
  for await (const entry of await client.messages.batches.results(status.id)) {
    const key = keys[Number(entry.custom_id.slice(1))];
    if (!key) continue;
    const r = entry.result;
    if (r.type !== "succeeded") {
      results.set(key, { status: "error", detail: `batch entry ${r.type}` });
      continue;
    }
    const u = usageFrom(r.message.usage);
    usage = addUsage(usage, u);
    if (r.message.stop_reason === "refusal") {
      results.set(key, {
        status: "refused",
        detail: r.message.stop_details?.category ?? "refusal",
        usage: u,
      });
      continue;
    }
    const text = r.message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    try {
      const parsed = RawHitsSchema.safeParse(JSON.parse(text));
      results.set(
        key,
        parsed.success
          ? { status: "ok", hits: parsed.data.hits, usage: u }
          : { status: "error", detail: "output did not match schema", usage: u },
      );
    } catch {
      results.set(key, {
        status: "error",
        detail: `unparseable output (stop_reason=${r.message.stop_reason})`,
        usage: u,
      });
    }
  }
  return { batchId: status.id, results, usage };
}

/** Serves results computed ahead of time (e.g. by a batch) through the normal provider interface. */
export class PrecomputedProvider implements LlmProvider {
  constructor(
    readonly id: string,
    readonly model: string,
    private readonly results: Map<string, ProviderResult>,
  ) {}

  async classify(prompt: TacticPrompt): Promise<ProviderResult> {
    return (
      this.results.get(promptKey(prompt)) ?? { status: "error", detail: "no precomputed result" }
    );
  }
}
