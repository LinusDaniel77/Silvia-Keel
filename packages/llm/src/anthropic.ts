import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import {
  RawHitsSchema,
  type LlmProvider,
  type ProviderResult,
  type ProviderUsage,
  type TacticPrompt,
} from "./types.ts";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

/**
 * Project-specific key names, in order of preference. Claude Code cloud sessions reserve
 * ANTHROPIC_API_KEY (and point ANTHROPIC_BASE_URL at their own proxy), so a key stored under one of
 * these names is used with the public API base URL instead of whatever the environment's Anthropic
 * variables say.
 */
export const PROJECT_API_KEY_ENVS = ["KEEL_ANTHROPIC_API_KEY", "SHIELD_ANTHROPIC_API_KEY"] as const;
const PUBLIC_API_BASE_URL = "https://api.anthropic.com";

type Env = Record<string, string | undefined>;

export function hasAnthropicCredentials(env: Env = process.env): boolean {
  return Boolean(projectApiKey(env) || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
}

const projectApiKey = (env: Env) => PROJECT_API_KEY_ENVS.map((name) => env[name]).find(Boolean);

/** A project key name wins; otherwise the SDK's own env defaults apply. */
export function createAnthropicClient(env: Env = process.env): Anthropic {
  const apiKey = projectApiKey(env);
  if (!apiKey) return new Anthropic();
  return new Anthropic({
    apiKey,
    authToken: null,
    baseURL: env.SHIELD_ANTHROPIC_BASE_URL ?? PUBLIC_API_BASE_URL,
  });
}

/**
 * Models that accept the server-side refusal fallback (`fallbacks: "default"`). Haiku has no
 * server-side fallback, so the parameter is omitted there and a refusal falls back to the rules.
 */
const SERVER_FALLBACK_MODELS = new Set([
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
]);

/** Converts the API's usage block into our token counts. */
export function usageFrom(u: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): ProviderUsage {
  return {
    input: u.input_tokens,
    output: u.output_tokens,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  };
}

export interface AnthropicProviderOptions {
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  client?: Anthropic;
}

/**
 * Claude tactic classifier. Partner data must only flow through an org with zero-data-retention
 * terms in place; see docs/data-handling.md.
 */
export class AnthropicProvider implements LlmProvider {
  readonly id = "anthropic";
  readonly model: string;
  private readonly effort: NonNullable<AnthropicProviderOptions["effort"]>;
  private readonly client: Anthropic;

  constructor(opts: AnthropicProviderOptions = {}) {
    this.model = opts.model ?? process.env.SHIELD_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
    // Classification is a short, bounded task; low effort keeps spend down without changing model.
    this.effort = opts.effort ?? "low";
    this.client = opts.client ?? createAnthropicClient();
  }

  async classify(prompt: TacticPrompt): Promise<ProviderResult> {
    try {
      const response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16000,
        ...(SERVER_FALLBACK_MODELS.has(this.model)
          ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
          : {}),
        output_config: { effort: this.effort, format: betaZodOutputFormat(RawHitsSchema) },
        system: [{ type: "text", text: prompt.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: prompt.user }],
      });
      const usage = usageFrom(response.usage);
      if (response.stop_reason === "refusal") {
        return { status: "refused", detail: response.stop_details?.category ?? "refusal", usage };
      }
      if (!response.parsed_output) {
        return {
          status: "error",
          detail: `no parsed output (stop_reason=${response.stop_reason})`,
          usage,
        };
      }
      return { status: "ok", hits: response.parsed_output.hits, usage };
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        return { status: "error", detail: `${err.status ?? "network"}: ${err.message}` };
      }
      throw err;
    }
  }
}
