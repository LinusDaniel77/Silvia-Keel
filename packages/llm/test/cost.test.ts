import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  BudgetedProvider,
  classifyInBatch,
  estimateCostUsd,
  estimatePromptUsage,
  PrecomputedProvider,
  promptKey,
  ScriptedProvider,
} from "../src/index.ts";

const prompt = (user: string) => ({ system: "S".repeat(3500), user, hash: "h" });

describe("pricing", () => {
  it("prices input, output, cache reads and writes, and halves batches", () => {
    const u = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 };
    // Haiku 5.5: 0.10 + 0.50 + 0.01 + 0.125
    expect(estimateCostUsd(u, "claude-haiku-5-5")).toBeCloseTo(0.735);
    expect(estimateCostUsd(u, "claude-haiku-5-5", { batch: true })).toBeCloseTo(0.3675);
    expect(() => estimateCostUsd(u, "claude-unknown")).toThrow(/no price on file/);
  });

  it("estimates the system prompt as a cache write first, then cache reads", () => {
    expect(estimatePromptUsage(prompt("u"), { systemCached: false }).cacheWrite).toBe(1000);
    expect(estimatePromptUsage(prompt("u"), { systemCached: true }).cacheRead).toBe(1000);
    expect(estimatePromptUsage(prompt("u"), { systemCached: false, batch: true }).input).toBe(1001);
  });
});

describe("BudgetedProvider", () => {
  it("stops making calls once the cap would be crossed", async () => {
    const usage = { input: 0, output: 1000, cacheRead: 0, cacheWrite: 0 }; // $0.0005 each on Haiku 5.5
    const inner = new ScriptedProvider(() => ({ status: "ok", hits: [], usage }));
    Object.defineProperty(inner, "model", { value: "claude-haiku-5-5" });
    const budget = new BudgetedProvider(inner, 0.002);
    const statuses = [];
    for (let i = 0; i < 10; i++) statuses.push((await budget.classify(prompt(`m${i}`))).status);
    expect(statuses.filter((s) => s === "ok").length).toBeGreaterThan(0);
    expect(statuses.at(-1)).toBe("skipped_budget");
    expect(budget.spentUsd).toBeLessThanOrEqual(0.002);
    expect(inner.calls.length).toBe(statuses.filter((s) => s === "ok").length);
  });
});

describe("batch classification", () => {
  it("submits each unique prompt once, matches results by custom_id, and maps outcomes", async () => {
    const created: { requests: { custom_id: string; params: Record<string, unknown> }[] }[] = [];
    const msg = (text: string, stop = "end_turn") => ({
      stop_reason: stop,
      stop_details: stop === "refusal" ? { category: "cyber" } : null,
      content: [{ type: "text", text }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });
    const client = {
      messages: {
        batches: {
          create: async (p: (typeof created)[number]) => (
            created.push(p),
            {
              id: "b1",
              processing_status: "in_progress",
              request_counts: { succeeded: 0, errored: 0 },
            }
          ),
          retrieve: async () => ({
            id: "b1",
            processing_status: "ended",
            request_counts: { succeeded: 3, errored: 0 },
          }),
          results: async () =>
            (async function* () {
              // Deliberately out of order.
              yield { custom_id: "p2", result: { type: "succeeded", message: msg("", "refusal") } };
              yield {
                custom_id: "p0",
                result: {
                  type: "succeeded",
                  message: msg(
                    '{"hits":[{"tactic_id":"urgency.deadline","confidence":0.9,"evidence":["now"]}]}',
                  ),
                },
              };
              yield { custom_id: "p1", result: { type: "expired" } };
            })(),
        },
      },
    } as unknown as Anthropic;

    const a = prompt("a");
    const b = prompt("b");
    const c = prompt("c");
    const { results, usage } = await classifyInBatch(client, [a, b, c, a], {
      model: "claude-haiku-5-5",
      pollMs: 0,
    });
    expect(created[0]!.requests).toHaveLength(3);
    expect(created[0]!.requests[0]!.params).not.toHaveProperty("fallbacks");
    expect(results.get(promptKey(a))).toMatchObject({
      status: "ok",
      hits: [{ tactic_id: "urgency.deadline" }],
    });
    expect(results.get(promptKey(b))).toMatchObject({
      status: "error",
      detail: "batch entry expired",
    });
    expect(results.get(promptKey(c))).toMatchObject({ status: "refused", detail: "cyber" });
    expect(usage.input).toBe(20);

    const provider = new PrecomputedProvider("anthropic-batch", "claude-haiku-5-5", results);
    expect((await provider.classify(a)).status).toBe("ok");
    expect((await provider.classify(prompt("never-submitted"))).status).toBe("error");
  });
});
