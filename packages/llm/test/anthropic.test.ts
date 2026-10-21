import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AnthropicProvider, createAnthropicClient, hasAnthropicCredentials } from "../src/index.ts";

function stubClient(response: unknown) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        parse: async (params: Record<string, unknown>) => {
          calls.push(params);
          return response;
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const prompt = { system: "SYSTEM", user: "USER", hash: "abc" };

describe("AnthropicProvider", () => {
  it("sends a cached system prompt, structured output and server-side fallbacks", async () => {
    const { client, calls } = stubClient({
      stop_reason: "end_turn",
      parsed_output: {
        hits: [{ tactic_id: "urgency.deadline", confidence: 0.8, evidence: ["now"] }],
      },
    });
    const result = await new AnthropicProvider({ client, model: "claude-opus-5-5" }).classify(
      prompt,
    );
    expect(result).toEqual({
      status: "ok",
      hits: [{ tactic_id: "urgency.deadline", confidence: 0.8, evidence: ["now"] }],
    });
    const params = calls[0]!;
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.fallbacks).toBe("default");
    expect(params.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(params.system).toEqual([
      { type: "text", text: "SYSTEM", cache_control: { type: "ephemeral" } },
    ]);
    expect(params.messages).toEqual([{ role: "user", content: "USER" }]);
    expect((params.output_config as { format: unknown }).format).toBeDefined();
  });

  it("reports refusals instead of throwing", async () => {
    const { client } = stubClient({
      stop_reason: "refusal",
      stop_details: { category: "cyber" },
      parsed_output: null,
    });
    expect(await new AnthropicProvider({ client }).classify(prompt)).toEqual({
      status: "refused",
      detail: "cyber",
    });
  });

  it("reports unparseable output as an error", async () => {
    const { client } = stubClient({ stop_reason: "max_tokens", parsed_output: null });
    const r = await new AnthropicProvider({ client }).classify(prompt);
    expect(r.status).toBe("error");
  });
});

describe("Anthropic credentials", () => {
  it("prefers SHIELD_ANTHROPIC_API_KEY and ignores the environment's base URL and auth token", () => {
    const client = createAnthropicClient({
      SHIELD_ANTHROPIC_API_KEY: "sk-shield",
      ANTHROPIC_BASE_URL: "http://proxy.invalid",
      ANTHROPIC_AUTH_TOKEN: "session-token",
    });
    expect(client.apiKey).toBe("sk-shield");
    expect(client.authToken).toBeNull();
    expect(client.baseURL).toBe("https://api.anthropic.com");
  });

  it("prefers KEEL_ANTHROPIC_API_KEY over SHIELD_ANTHROPIC_API_KEY", () => {
    const client = createAnthropicClient({
      KEEL_ANTHROPIC_API_KEY: "sk-keel",
      SHIELD_ANTHROPIC_API_KEY: "sk-shield",
      ANTHROPIC_BASE_URL: "http://proxy.invalid",
    });
    expect(client.apiKey).toBe("sk-keel");
    expect(client.baseURL).toBe("https://api.anthropic.com");
  });

  it("detects any supported credential", () => {
    expect(hasAnthropicCredentials({})).toBe(false);
    expect(hasAnthropicCredentials({ KEEL_ANTHROPIC_API_KEY: "k" })).toBe(true);
    expect(hasAnthropicCredentials({ SHIELD_ANTHROPIC_API_KEY: "k" })).toBe(true);
    expect(hasAnthropicCredentials({ ANTHROPIC_API_KEY: "k" })).toBe(true);
  });
});
