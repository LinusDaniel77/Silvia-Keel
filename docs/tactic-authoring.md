# Writing tactics

The tactic library (`packages/tactics/library/`) is the moat. Each tactic is one YAML file, named
after its id, and is read both by the deterministic rules and by the LLM classifier prompt.

## Anatomy

```yaml
id: secrecy.confidential # <family>.<slug>, and the file name
name: Secrecy
family:
  secrecy # urgency | authority | secrecy | channel | identity | process-bypass |
  # payment-anomaly | access | rapport | injection | elicitation
stages: [enterprise, elicitation, copilot]
version: 1.0.0 # bump on any content change
status: active # draft tactics never reach the engine
severity: high
description: >- # what it is and why it works; the LLM reads this
  ...
explanation: 'This request asks you to keep it quiet ("{evidence}"), ...' # what the employee sees
indicators:
  lexical: [keep this between us, ...] # case-insensitive, word-bounded, plural-tolerant
  patterns: ["(don'?t|do not) (loop|cc) ..."]
  structural: [reply_to_mismatch] # engine feature ids (FEATURE_IDS in @shield/shared)
examples:
  positive: [...] # at least 2; shown to the LLM as "looks like"
  hard_negative: [...] # at least 2; shown to the LLM as "does NOT look like"
references: [...]
author: ...
```

## Rules of the road

1. **Hard negatives are what make precision possible.** Write the real CFO's real urgent request,
   the vendor's genuine bank change with a signed letter, the IT notice that mentions passwords.
   The linter warns when a hard negative trips the tactic's own rules. That is fine only when the
   cue is genuinely present but harmless (a legitimate deadline still uses deadline language).
2. **Describe the request, never the person.** The explanation is shown to an employee about a
   message that may come from their real CEO. The linter rejects person labels.
3. **Lexicons are for precision; the LLM is for recall.** A lexical cue should be something that
   almost never appears in legitimate traffic with the same meaning. Bare words like "urgent" are
   acceptable only because one family never pauses anything on its own. Prefer phrases.
4. **Never tune against held-out data.** The eval corpus's `paraphrase` slice exists to measure
   wording the rules have never seen. Adding its phrasings to a lexicon makes the numbers lie.
   Tune against `template` and `handwritten` items, and add new held-out items when you do.
5. **Version every change.** Bump the tactic's `version` and the manifest's `version`, then run
   `pnpm shield tactics lock`. The linter fails when content changes without a bump. Every
   `Analysis` records the library version that produced it, so verdicts stay reproducible.

## Critical combinations

`manifest.yaml` lists combinations that pause on their own, such as a bank change plus secrecy.
Each must be explainable in one sentence to a CFO. Requirements are tactic ids or `family:<name>`.
`non_pressure_families` lists families that describe the action rather than pressure on a person.
They feed combinations but not the two-family pause rule.

## Workflow

```sh
pnpm shield tactics lint      # schema, examples, person labels, regexes, version discipline
pnpm shield tactics lock      # after bumping versions
pnpm shield eval --out eval-report.md   # see what your change did to precision and recall
```
