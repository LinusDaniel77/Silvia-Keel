import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import {
  RawHitsSchema,
  type LlmProvider,
  type ProviderResult,
  type TacticPrompt,
} from "./types.ts";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

/**
 * Project-specific key name. Claude Code cloud sessions reserve ANTHROPIC_API_KEY (and point
 * ANTHROPIC_BASE_URL at their own proxy), so a key stored under this name is used with the public
 * API base URL instead of whatever the environment's Anthropic variables say.
 */
export const SHIELD_API_KEY_ENV = "SHIELD_ANTHROPIC_API_KEY";
const PUBLIC_API_BASE_URL = "https://api.anthropic.com";

type Env = Record<string, string | undefined>;

export function hasAnthropicCredentials(env: Env = process.env): boolean {
  return Boolean(env[SHIELD_API_KEY_ENV] || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
}

/** SHIELD_ANTHROPIC_API_KEY wins; otherwise the SDK's own env defaults apply. */
export function createAnthropicClient(env: Env = process.env): Anthropic {
  const apiKey = env[SHIELD_API_KEY_ENV];
  if (!apiKey) return new Anthropic();
  return new Anthropic({
    apiKey,
    authToken: null,
    baseURL: env.SHIELD_ANTHROPIC_BASE_URL ?? PUBLIC_API_BASE_URL,
  });
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
    this.effort = opts.effort ?? "medium";
    this.client = opts.client ?? createAnthropicClient();
  }

  async classify(prompt: TacticPrompt): Promise<ProviderResult> {
    try {
      const response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: this.effort, format: betaZodOutputFormat(RawHitsSchema) },
        system: [{ type: "text", text: prompt.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: prompt.user }],
      });
      if (response.stop_reason === "refusal") {
        return { status: "refused", detail: response.stop_details?.category ?? "refusal" };
      }
      if (!response.parsed_output) {
        return {
          status: "error",
          detail: `no parsed output (stop_reason=${response.stop_reason})`,
        };
      }
      return { status: "ok", hits: response.parsed_output.hits };
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        return { status: "error", detail: `${err.status ?? "network"}: ${err.message}` };
      }
      throw err;
    }
  }
}
