import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createAnthropicClient, hasAnthropicCredentials } from "@shield/llm";
import { loadLibrary } from "@shield/tactics";
import {
  DEFAULT_COPILOT_MODEL,
  discoverConversations,
  readConversation,
  renderReport,
} from "./first-test.ts";

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { out: { type: "string" } },
  });
  const dir = path.resolve(positionals[0] ?? "copilot-data");
  const conversations = discoverConversations(dir);
  if (conversations.length === 0) {
    console.error(
      `No conversations found in ${dir}.\nCreate one folder per conversation with conversation.txt and my-read.md (see copilot-data/README.md).`,
    );
    return 1;
  }
  if (!hasAnthropicCredentials()) {
    console.error(
      "No Anthropic credentials in this environment. Set KEEL_ANTHROPIC_API_KEY (in a cloud session, add it to the environment settings under that name, since ANTHROPIC_API_KEY is reserved there, and start a new session).",
    );
    return 1;
  }
  const missing = conversations.filter((c) => !c.myRead).map((c) => c.name);
  if (missing.length)
    console.warn(
      `Warning: no my-read.md for ${missing.join(", ")}; the comparison won't be blind.`,
    );

  const library = loadLibrary();
  const client = createAnthropicClient();
  const model = process.env.COPILOT_MODEL ?? DEFAULT_COPILOT_MODEL;
  const results = [];
  for (const conversation of conversations) {
    process.stdout.write(`Reading ${conversation.name}… `);
    const result = await readConversation(conversation, { client, library, model });
    console.log(
      result.status === "ok" ? `${result.seconds}s` : `${result.status}: ${result.detail}`,
    );
    results.push({ conversation, result });
  }
  const out = values.out ?? path.join(dir, "first-test-report.md");
  writeFileSync(out, renderReport(results, { library, model }));
  console.log(`Report: ${out}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
