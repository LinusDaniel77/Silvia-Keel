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
rules. It needs Anthropic credentials; the model comes from `SHIELD_MODEL` and defaults to
`claude-opus-5-5`. Do not send real partner data without zero-data-retention terms; see
[`docs/data-handling.md`](docs/data-handling.md).

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
| `docs/`            | Roadmap, principles, tactic authoring, eval methodology, threat model, data handling |

## Current numbers, honestly

| Run (rules only)                  | PAUSE precision | PAUSE catch rate | Catch rate on paraphrased attacks |
| --------------------------------- | --------------- | ---------------- | --------------------------------- |
| Synthetic seed corpus (302 items) | 98%             | 55%              | 4%                                |

The rules are precise but don't generalize to new wording; that's the LLM classifier's job, and
its first measured run is the next step. See
[`docs/eval-methodology.md`](docs/eval-methodology.md) for what these numbers can and cannot claim.
