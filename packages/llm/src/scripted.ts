import type { LlmProvider, ProviderResult, RawHits, TacticPrompt } from "./types.ts";

/**
 * Deterministic provider for tests: returns canned output, optionally per request.
 * Used to simulate a compromised or misbehaving model (e.g. one talked into returning nothing).
 */
export class ScriptedProvider implements LlmProvider {
  readonly id = "scripted";
  readonly model = "scripted";
  readonly calls: TacticPrompt[] = [];

  constructor(
    private readonly respond: (prompt: TacticPrompt) => ProviderResult | RawHits["hits"],
  ) {}

  async classify(prompt: TacticPrompt): Promise<ProviderResult> {
    this.calls.push(prompt);
    const out = this.respond(prompt);
    return Array.isArray(out) ? { status: "ok", hits: out } : out;
  }
}
