# Eval methodology

The roadmap commits to _published_ false-alarm and catch rates, "almost nobody does this, and
buyers notice." Publishing numbers that don't survive scrutiny would cost more credibility than
not publishing at all. This document defines what is measured, on what data, and what the
numbers can and cannot claim.

## Two questions, two kinds of data

| Question                                   | Metric                                                                                                  | Honest data source                                                                                                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How often do we stop a legitimate request? | **False-alarm rate** = legitimate requests paused ÷ legitimate high-risk requests. **PAUSE precision.** | Real partner traffic in **shadow mode**: the engine runs and logs but never pauses. Base rates are high, so the numbers are tight within weeks.                                                                        |
| How many attacks do we stop?               | **Catch rate** = attacks paused ÷ attacks.                                                              | Real attacks are rare, so partner traffic alone gives huge error bars. Use consented **red-team simulations** at partners, partners' **historical incidents**, and the **synthetic corpus**, each reported separately. |

Never blend the two into one "accuracy" number. Every rate is reported with its numerator,
denominator and a 95% Wilson interval (`packages/eval/src/metrics.ts`).

## Decision vs tactic metrics

- **Decision metrics** treat PAUSE as the positive prediction and `labels.attack` as truth. WARN-or-above
  is reported alongside, because a warning that teaches the pattern has value even when it doesn't pause.
- **Tactic metrics** compare fired tactics with `labels.tactics`. Labels are independent of
  the attack label: a real CFO's urgent request is labeled `urgency.deadline` and `attack: false`.
  This separation is the point. Detecting a tactic is not the same as calling an attack.

## Corpus

`packages/eval/corpus/seed.jsonl` holds 302 items: 173 attacks and 129 legitimate requests. It is
built deterministically by `packages/eval/scripts/build-seed-corpus.ts`.

| Slice         | What it is                                                                                     | What it can claim                                                   |
| ------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `template`    | Scenarios plus pressure phrases, mostly phrasings that match the rules                         | Plumbing and policy correctness; an upper bound, not a field number |
| `paraphrase`  | The same scenarios worded to avoid every rule lexicon                                          | **Held out from rule tuning.** The closest proxy for unseen wording |
| `handwritten` | Full messages modelled on scenarios in FBI IC3 and CISA advisories, plus hard legitimate cases | Realism check; small n                                              |
| `injection`   | Attacks with text addressed to a classifier, each paired with its clean twin (`pairOf`)        | Robustness: injected text must never lower the verdict              |
| `hard`        | Legitimate requests that share surface features with attacks                                   | Precision under pressure                                            |

Everything here is synthetic and written by the same team that writes the tactics. That is a
known bias: treat these numbers as a ceiling. Partner data (`source: partner`) and red-team data
(`source: redteam`) are never committed to this repository.

### Leakage rules

1. Never add a phrase from a `paraphrase` item to a lexicon or pattern. If a paraphrase reveals a
   real gap, write _new_ paraphrase items for the held-out slice before tuning.
2. Tactic `examples` are shown to the LLM. Corpus items must not copy them.
3. Changing the corpus and a tactic in the same PR needs a reviewer to check rule 1.

## Baseline (M0, rules only, library 0.1.0)

|                  | PAUSE                     | WARN or above   |
| ---------------- | ------------------------- | --------------- |
| Precision        | 97.9% (95/97; CI 93–99%)  | 78.5% (142/181) |
| Catch rate       | 54.9% (95/173; CI 47–62%) | 82.1% (142/173) |
| False-alarm rate | 1.6% (2/129; CI 0–5%)     | 30.2% (39/129)  |

By slice, PAUSE catch rate is 73% on `template`, **4% on `paraphrase`** and 82% on `handwritten`.
Both false alarms are real executives' legitimate urgent requests ("boarding a flight", "back-to-back
meetings") that mention the travel and meeting cues attackers use.

What this says: the rules are precise and cheap but do not generalize to new wording. Recall on
unseen phrasing has to come from the LLM classifier, and the LLM's job on the two false alarms is
to notice that the request points to a record and a known person. The first
`--provider anthropic` run is the next measurement to take. Its numbers go in this table with
the model id.

## Running the paid eval cheaply

Every paid run can be priced first, for free, and capped:

```sh
# Free: prints the number of classifier calls and an estimated cost. No API call, no key needed.
pnpm shield eval --provider anthropic --model claude-haiku-5-5 --batch \
  --tags paraphrase,hard,injection,handwritten --estimate
# The cheap first look (about $0.05 estimated): Haiku 5.5, Batch API at half price, ~116 items.
pnpm shield eval --provider anthropic --model claude-haiku-5-5 --batch \
  --tags paraphrase,hard,injection,handwritten --max-usd 1 --out docs/eval-runs/<date>-haiku.md
```

- **Spending cap.** `--max-usd` stops synchronous runs before the cap is crossed. Skipped items
  fall back to rules and are listed in the report. Batch runs refuse to submit if the estimate
  exceeds the cap.
- **Effort.** It defaults to `low`. The report's "API usage" section shows tokens and estimated
  cost.
- **Estimates are pessimistic.** The output allowance is 1,000 tokens per call. The billing
  console is authoritative.

## CI gate

`pnpm shield eval --gate` fails the build when rules-only results fall below
`packages/eval/gate.json`: PAUSE precision of at least 0.95, a false-alarm rate of at most 0.03, a
catch rate of at least 0.50, and zero injection-pair violations. Thresholds only move up.

## Field protocol (M3–M7)

1. **Shadow mode, 2–4 weeks per partner.** Log every analysis, including library version, model
   and prompt hash. Sample WARN and PAUSE outcomes for review by the partner's finance or security
   lead. Tune thresholds per tenant.
2. **Verification outcomes are labels.** Each forced verification ends as legitimate, attack or
   inconclusive. That is the flywheel: labels arrive as a by-product of the product working.
3. **Red team.** With written consent, send simulated BEC and help-desk attacks to partner
   workflows and report catch rate on those alone.
4. **Report per model.** A verdict depends on the model, so a change of model, including the v3
   air-gapped open-weight model, needs its own run before its numbers are claimed.
5. **External review** of the methodology by the security-credible advisor before publication.
