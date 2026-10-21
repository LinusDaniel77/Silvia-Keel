# Manipulation Shield

Deepfakes will become perfect. Manipulation can't hide. Every social-engineering attack, however
convincing the voice or video, still has to rush someone, invoke authority, demand secrecy and
push an unusual payment or access request. This engine detects that psychological signature in
inbound requests and forces a verification step before the money or access moves.

The roadmap is in [`docs/roadmap.md`](docs/roadmap.md): enterprise first, then defense
contractors, then government, with a communication copilot on the same engine in parallel. This
repository currently holds **Milestone 0**: the tactic library, the detection engine and the eval
harness that everything else plugs into.

## Quick start

```sh
pnpm install
pnpm shield analyze samples/bec-vendor-change.eml --action vendor_bank_change \
  --org-domain keelbridge.com --known-domain atlasfreight.com
pnpm shield analyze samples/legit-urgent-cfo.eml --org-domain keelbridge.com
pnpm shield eval --out eval-report.md        # rules only, offline
pnpm shield tactics lint
pnpm test
```

Add `--provider anthropic` to `analyze` or `eval` to run the Claude tactic classifier on top of the
rules. It needs Anthropic credentials: `KEEL_ANTHROPIC_API_KEY` or `SHIELD_ANTHROPIC_API_KEY` (used against the public API;
Claude Code cloud sessions reserve `ANTHROPIC_API_KEY`) or the SDK's usual `ANTHROPIC_API_KEY`. The
model comes from `SHIELD_MODEL` and defaults to `claude-opus-5-5`. Do not send real partner data without zero-data-retention terms; see
[`docs/data-handling.md`](docs/data-handling.md).

## Demo for design partners

```sh
pnpm demo        # http://127.0.0.1:4173, local only
```

Paste a past incident (a raw email with headers, plain text, or a request JSON), say what it asks
for, and see the decision. The page shows the tactics, one-line explanations and the evidence
highlighted in the message. Four built-in examples cover a vendor bank-change attack, a real CFO's
urgent request, an injection attempt and an email-plus-call chain.

- Nothing is stored and request bodies are never logged.
- The server binds to localhost and has no authentication, so don't expose it.
- With Anthropic credentials set, a "Use Claude" toggle adds the classifier. The pasted text then
  goes to Anthropic.

## Copilot first test

```sh
pnpm copilot:first-test   # reads copilot-data/<conversation>/{conversation.txt,my-read.md}
```

This is the roadmap's one-afternoon test. Put 5 real conversations and your own read of each in
`copilot-data/` (git-ignored). The run writes a report with Claude's read next to yours and a
scoring table for each conversation. See [`copilot-data/README.md`](copilot-data/README.md).

## API: the approval gate

```sh
pnpm api               # in-memory Postgres with a demo tenant; prints an API key
pnpm api --seed-demo   # same, plus 48 synthetic requests; console at http://127.0.0.1:4180/console
```

An AP or help-desk system calls `POST /v1/approvals/check` before releasing a payment, a vendor
bank change or a reset.

- **Correlation.** The gate joins the request to the emails and chats behind it and analyzes them.
- **Shadow mode** (the default) records the decision without holding anything.
- **Enforce mode** holds a paused request until someone verifies it through a contact from the
  vendor master or HR directory, never one taken from the message.
- **Labels.** Verification outcomes become eval labels.
- **Console** (`/console`): the security team sees what would have been paused, how often that
  was wrong (with confidence intervals), and what it caught. They can review or verify requests
  and switch workflows to enforce.

See [`docs/api.md`](docs/api.md).

## How a request is judged

```
artifacts (email, chat, call note, approval event) + the action they push for
  → normalize → prefilter (high-risk intent?) → features (headers, lookalikes, channels, vendor baseline)
  → rule hits from the tactic library  ┐
  → Claude tactic classifier (optional) ┴→ merge (LLM can add, never veto) → decide → explain
```

- **ALLOW, WARN or PAUSE.** A pause needs a high-risk action, plus either two independent
  pressure families or a named critical combination such as a vendor bank change plus secrecy.
- **Explanations.** Every flag explains itself in one line, quoting the request and naming the
  tactic, never the person.
- **Provenance.** Every verdict records the tactic library version, model and prompt hash.

## Layout

| Path               | What                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------ |
| `packages/tactics` | The tactic library (YAML), schema, loader, matcher and linter                        |
| `packages/engine`  | The detection pipeline                                                               |
| `packages/llm`     | Provider interface, Claude adapter, prompt builder, evidence validation              |
| `packages/eval`    | Seed corpus, eval harness, metrics, report, principle tests                          |
| `packages/shared`  | Domain types (`ShieldRequest`, `Analysis`, …)                                        |
| `apps/cli`         | `shield` command                                                                     |
| `apps/demo`        | Local paste-a-request demo (`pnpm demo`)                                             |
| `apps/copilot`     | Copilot first-test harness (`pnpm copilot:first-test`)                               |
| `apps/api`         | Approval-gate API (`pnpm api`)                                                       |
| `packages/db`      | Postgres schema, migrations, tenant isolation, retention                             |
| `docs/`            | Roadmap, principles, tactic authoring, eval methodology, threat model, data handling |

## Current numbers, honestly

| Run (rules only)                  | PAUSE precision | PAUSE catch rate | Catch rate on paraphrased attacks |
| --------------------------------- | --------------- | ---------------- | --------------------------------- |
| Synthetic seed corpus (302 items) | 98%             | 55%              | 4%                                |

The rules are precise but don't generalize to new wording; that's the LLM classifier's job. Its
first measured run is deferred for budget. When it runs, it can be priced first for free and
capped, and the cheap first look is about $0.05 (see the eval methodology). See
[`docs/eval-methodology.md`](docs/eval-methodology.md) for what these numbers can and cannot claim.
