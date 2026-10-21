# Data handling

M0 processes only the synthetic corpus and files you pass to the CLI. These rules apply as soon as
any real message is analyzed, including a design partner's past incident.

- **LLM processing.** Real partner content goes to the Anthropic API only under zero-data-retention
  terms, and the provider is listed as a subprocessor. Without those terms, use `--provider none`.
- **Minimize what the engine sees.** The engine needs the request text, sender headers and the
  action, and never recipient identity. Connectors drop recipients before calling the engine
  (principle 2).
- **Store evidence, not mailboxes.** Persist the `Analysis` (tactic ids, evidence spans, decision,
  provenance) and a hash of the body. Full bodies are kept only for the tenant's retention window
  (default 30 days) to support review, then purged.
- **Retention is enforced.** `purgeBodies` (`packages/db/src/tenants.ts`) runs hourly in the API.
  It nulls bodies older than the tenant's `retention_days`.
- **One person reference.** `audit_events.actor_ref` is an opaque id from the customer's
  directory, recorded when someone completes or overrides a verification. It exists for the audit
  trail only. It is never aggregated, scored or exported.
- **Never commit partner or red-team data** to this repository. `source: partner` and
  `source: redteam` corpora live in the tenant's environment.
- **Aggregation keys** for any reporting are tactic, family, channel, workflow and vendor, never
  recipient. In v2 the security-office view adds a k-anonymity floor: cells with fewer than 5
  people are suppressed.
