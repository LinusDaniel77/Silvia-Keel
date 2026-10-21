import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { validateHits } from "@shield/llm";
import type { TacticHit } from "@shield/shared";
import type { TacticLibrary } from "@shield/tactics";
import { buildCopilotSystemPrompt, renderConversation } from "./prompt.ts";
import { CopilotReadSchema, type CopilotRead } from "./schema.ts";

export const DEFAULT_COPILOT_MODEL = "claude-opus-5-5";

export interface Conversation {
  name: string;
  text: string;
  /** The user's own read, written before running the tool. Missing means the test isn't blind. */
  myRead: string | null;
}

export type ReadResult =
  | {
      status: "ok";
      read: CopilotRead;
      tacticsByThem: TacticHit[];
      tacticsByMe: TacticHit[];
      droppedHits: number;
      seconds: number;
    }
  | { status: "refused" | "error"; detail: string; seconds: number };

export function discoverConversations(dir: string): Conversation[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(path.join(dir, name)).isDirectory())
    .filter((name) => existsSync(path.join(dir, name, "conversation.txt")))
    .sort()
    .map((name) => {
      const readFile = path.join(dir, name, "my-read.md");
      return {
        name,
        text: readFileSync(path.join(dir, name, "conversation.txt"), "utf8"),
        myRead: existsSync(readFile) ? readFileSync(readFile, "utf8").trim() || null : null,
      };
    });
}

export async function readConversation(
  conversation: Conversation,
  opts: { client: Anthropic; library: TacticLibrary; model?: string },
): Promise<ReadResult> {
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 100) / 10;
  try {
    const response = await opts.client.beta.messages.parse({
      model: opts.model ?? DEFAULT_COPILOT_MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "high", format: betaZodOutputFormat(CopilotReadSchema) },
      system: [
        {
          type: "text",
          text: buildCopilotSystemPrompt(opts.library),
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: renderConversation(conversation.text) }],
    });
    if (response.stop_reason === "refusal")
      return {
        status: "refused",
        detail: response.stop_details?.category ?? "refusal",
        seconds: seconds(),
      };
    const read = response.parsed_output;
    if (!read)
      return {
        status: "error",
        detail: `no parsed output (stop_reason=${response.stop_reason})`,
        seconds: seconds(),
      };
    const them = validateHits(read.tactics_used_by_them, opts.library, conversation.text);
    const me = validateHits(read.tactics_used_by_me, opts.library, conversation.text);
    return {
      status: "ok",
      read,
      tacticsByThem: them.hits,
      tacticsByMe: me.hits,
      droppedHits: them.rejected.length + me.rejected.length,
      seconds: seconds(),
    };
  } catch (err) {
    if (err instanceof Anthropic.APIError)
      return {
        status: "error",
        detail: `${err.status ?? "network"}: ${err.message}`,
        seconds: seconds(),
      };
    throw err;
  }
}

const bullets = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- (none)");
const hits = (xs: TacticHit[], library: TacticLibrary) =>
  xs.length
    ? xs
        .map(
          (h) =>
            `- **${library.byId.get(h.tacticId)?.name ?? h.tacticId}** (\`${h.tacticId}\`, ${h.confidence.toFixed(2)}): ${h.evidence.map((e) => `"${e}"`).join(", ")}`,
        )
        .join("\n")
    : "- (none)";

export function renderReport(
  results: { conversation: Conversation; result: ReadResult }[],
  opts: { library: TacticLibrary; model: string; date?: string },
): string {
  const out: string[] = [
    "# Copilot first test",
    "",
    `- Date: ${opts.date ?? new Date().toISOString().slice(0, 10)}`,
    `- Model: \`${opts.model}\` · tactic library ${opts.library.manifest.version}`,
    `- Conversations: ${results.length}`,
    "",
    "Decision rule (from the roadmap): if Claude catches things you missed or matches your read faster, build the copilot. If not, the gaps show exactly what to fix.",
    "",
    "This file contains your real conversations. It lives in `copilot-data/`, which is git-ignored. Keep it that way.",
    "",
  ];
  for (const { conversation: c, result: r } of results) {
    out.push(`## ${c.name}`, "");
    out.push("### Your read", "");
    out.push(
      c.myRead ??
        "_No `my-read.md`. Write your read before running the tool, or the comparison isn't blind._",
      "",
    );
    out.push(`### Claude's read (${r.seconds}s)`, "");
    if (r.status !== "ok") {
      out.push(`_${r.status}: ${r.detail}_`, "");
    } else {
      const x = r.read;
      out.push(
        x.summary,
        "",
        `**Your goal:** ${x.my_goal}`,
        "",
        `**Their goal:** ${x.their_goal}`,
        "",
        "**Your leverage**",
        bullets(x.my_leverage),
        "",
        "**What they likely care about**",
        bullets(x.what_they_care_about),
        "",
        `**How they're probably feeling:** ${x.how_they_likely_feel}`,
        "",
        "**Other readings, and the question that settles each**",
        bullets(
          x.alternative_readings.map((a) => `${a.reading} → _${a.question_that_settles_it}_`),
        ),
        "",
        "**Tactics in their messages**",
        hits(r.tacticsByThem, opts.library),
        "",
        "**Self-check: tactics in your messages**",
        hits(r.tacticsByMe, opts.library),
        "",
        `**Honest pushback:** ${x.honest_pushback || "(none)"}`,
        "",
        "**Suggested next message**",
        "",
        ...x.suggested_next_message.split("\n").map((l) => `> ${l}`),
        "",
      );
      if (r.droppedHits)
        out.push(`_${r.droppedHits} tactic claim(s) dropped for lacking a verbatim quote._`, "");
    }
    out.push(
      "### Score (fill in)",
      "",
      "| | Notes |",
      "|---|---|",
      "| Caught what I missed | |",
      "| Matched my read | |",
      "| Missed what I caught | |",
      "| Wrong reads | |",
      "| Faster than me? | |",
      "",
    );
  }
  out.push(
    "## Verdict (fill in)",
    "",
    "- Conversations where Claude added something: _ / " + results.length,
    "- Conversations where Claude got something wrong: _ / " + results.length,
    "- Build the copilot? _",
    "- Gaps to fix in the tactic library or prompt: _",
    "",
  );
  return out.join("\n");
}
