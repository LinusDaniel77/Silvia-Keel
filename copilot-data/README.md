# Copilot first test: your conversations

This folder is git-ignored except for this README. Real conversations never get committed.

One folder per conversation:

```
copilot-data/
  landlord-deposit/
    conversation.txt   # the conversation, lines starting "Me:" and "Them:" (or free text)
    my-read.md         # YOUR read, written BEFORE you run the tool
  client-scope-creep/
    conversation.txt
    my-read.md
```

Then run:

```sh
pnpm copilot:first-test            # reads copilot-data/, writes copilot-data/first-test-report.md
```

The report puts Claude's read next to yours with a scoring table for each conversation. The
roadmap's rule: if it catches things you missed or matches your read faster, build. If not, the
gaps show exactly what to fix.

Needs `ANTHROPIC_API_KEY`. The model defaults to `claude-opus-5-5` (override with `COPILOT_MODEL`).
The text of each conversation is sent to Anthropic.
