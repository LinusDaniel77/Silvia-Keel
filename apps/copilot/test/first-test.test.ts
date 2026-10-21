import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { loadLibrary } from "@shield/tactics";
import { describe, expect, it } from "vitest";
import { discoverConversations, readConversation, renderReport } from "../src/first-test.ts";
import { buildCopilotSystemPrompt } from "../src/prompt.ts";
import { CopilotReadSchema, type CopilotRead } from "../src/schema.ts";

const library = loadLibrary();

const READ: CopilotRead = {
  summary: "A dispute over a withheld deposit.",
  my_goal: "Get the deposit back.",
  their_goal: "Cover cleaning costs.",
  my_leverage: ["Move-out photos"],
  what_they_care_about: ["Not losing money on turnover"],
  how_they_likely_feel: "Defensive about the cleaning bill.",
  alternative_readings: [
    {
      reading: "They may simply be slow, not refusing.",
      question_that_settles_it: "When will the itemized list arrive?",
    },
  ],
  tactics_used_by_them: [
    {
      tactic_id: "urgency.consequence",
      confidence: 0.7,
      evidence: ["or you will be held responsible"],
    },
    {
      tactic_id: "secrecy.confidential",
      confidence: 0.9,
      evidence: ["this text is not in the conversation"],
    },
  ],
  tactics_used_by_me: [
    { tactic_id: "urgency.deadline", confidence: 0.6, evidence: ["by end of day"] },
  ],
  honest_pushback: "Your deadline escalates before you've asked for the itemized list.",
  suggested_next_message: "Could you send the itemized deductions by Friday?\nThanks.",
};

function stub(response: unknown) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    beta: { messages: { parse: async (p: Record<string, unknown>) => (calls.push(p), response) } },
  } as unknown as Anthropic;
  return { client, calls };
}

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "copilot-"));
  mkdirSync(path.join(dir, "b-deposit"));
  writeFileSync(
    path.join(dir, "b-deposit", "conversation.txt"),
    "Them: Pay the cleaning fee or you will be held responsible for more.\nMe: I need the deposit back by end of day.",
  );
  writeFileSync(path.join(dir, "b-deposit", "my-read.md"), "They're bluffing about more charges.");
  mkdirSync(path.join(dir, "a-no-read"));
  writeFileSync(path.join(dir, "a-no-read", "conversation.txt"), "Me: hi\nThem: hello");
  mkdirSync(path.join(dir, "not-a-conversation"));
  return dir;
}

describe("copilot first test", () => {
  it("discovers conversation folders and notices a missing read", () => {
    const found = discoverConversations(scratch());
    expect(found.map((c) => c.name)).toEqual(["a-no-read", "b-deposit"]);
    expect(found[0]!.myRead).toBeNull();
    expect(found[1]!.myRead).toContain("bluffing");
  });

  it("keeps only verbatim tactic claims and renders a side-by-side report", async () => {
    const [, deposit] = discoverConversations(scratch());
    const { client, calls } = stub({ stop_reason: "end_turn", parsed_output: READ });
    const result = await readConversation(deposit!, { client, library });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.tacticsByThem.map((h) => h.tacticId)).toEqual(["urgency.consequence"]);
    expect(result.tacticsByMe.map((h) => h.tacticId)).toEqual(["urgency.deadline"]);
    expect(result.droppedHits).toBe(1);
    expect(calls[0]!.fallbacks).toBe("default");
    expect((calls[0]!.messages as { content: string }[])[0]!.content).toContain("<conversation>");

    const md = renderReport([{ conversation: deposit!, result }], {
      library,
      model: "m",
      date: "2026-01-01",
    });
    expect(md).toContain("### Your read");
    expect(md).toContain("They're bluffing");
    expect(md).toContain("**Self-check: tactics in your messages**");
    expect(md).toContain("> Could you send the itemized deductions by Friday?");
    expect(md).toContain("1 tactic claim(s) dropped");
    expect(md).toContain("### Score (fill in)");
  });

  it("reports refusals per conversation instead of failing the run", async () => {
    const [noRead] = discoverConversations(scratch());
    const { client } = stub({
      stop_reason: "refusal",
      stop_details: { category: "general_harms" },
      parsed_output: null,
    });
    const result = await readConversation(noRead!, { client, library });
    expect(result).toMatchObject({ status: "refused", detail: "general_harms" });
    const md = renderReport([{ conversation: noRead!, result }], { library, model: "m" });
    expect(md).toContain("No `my-read.md`");
  });
});

describe("principle 6: preparation, not exploitation", () => {
  it("the output schema has nowhere to put the other person's weak spots", () => {
    const keys = Object.keys(CopilotReadSchema.shape);
    for (const k of keys)
      expect(k).not.toMatch(
        /insecur|vulnerab|weakness|pressure_point|trigger|exploit|leverage_over/i,
      );
  });

  it("the system prompt states the boundary", () => {
    const prompt = buildCopilotSystemPrompt(library);
    expect(prompt).toMatch(/never exploitation/i);
    expect(prompt).toMatch(/do not profile the other person's insecurities/i);
    expect(prompt).toMatch(/do not script deception/i);
    expect(prompt).toMatch(/push past a "no"/i);
  });
});
